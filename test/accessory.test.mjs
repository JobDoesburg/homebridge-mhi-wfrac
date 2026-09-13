import assert from 'node:assert/strict';
import {test} from 'node:test';
import {HomebridgeAPI} from '../node_modules/homebridge/dist/api.js';

import {HomebridgeMHIWFRACPlatform} from '../dist/platform.js';
import {WFRACAccessory} from '../dist/platformAccessory.js';
import {DeviceClient} from '../dist/deviceClient.js';
import {FakeDevice, installFakeDevices, quietLog, recordingLog} from './fakeDevice.mjs';

const UUID = '12345678-1234-4234-8234-123456789012';
const LEGACY_ID = `homebridge-${UUID}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Boots the platform against fake devices. Polling is stopped after the first poll so tests control timing;
 * the request gap is removed so they run fast.
 */
function harness(t, {config = {}, cache = [], devices, log = quietLog} = {}) {
  const api = new HomebridgeAPI();
  const fakes = devices ?? [new FakeDevice({ip: '192.0.2.1', mac: '001122334455'}), new FakeDevice({ip: '192.0.2.2', mac: '001122334466'})];
  installFakeDevices(t, fakes);
  const originalGap = Object.getOwnPropertyDescriptor(DeviceClient, 'MIN_REQUEST_GAP_MS');
  Object.defineProperty(DeviceClient, 'MIN_REQUEST_GAP_MS', {value: 0, configurable: true});
  t.after(() => Object.defineProperty(DeviceClient, 'MIN_REQUEST_GAP_MS', originalGap));

  const accessories = [];
  const originalPoll = WFRACAccessory.prototype.poll;
  t.mock.method(WFRACAccessory.prototype, 'poll', async function () {
    if (!accessories.includes(this)) {
      accessories.push(this);
    }
    if (this.polled) {
      return;
    }
    this.polled = true;
    this.pollPromise = originalPoll.call(this);
    await this.pollPromise;
    clearTimeout(this.pollTimer);
  });
  t.after(() => accessories.forEach(a => clearTimeout(a.pollTimer)));

  const deviceConfigs = fakes.map((d, i) => ({name: `AC ${i + 1}`, mac: d.mac, ip: d.ip, ...(config.devices?.[i] ?? {})}));
  const platform = new HomebridgeMHIWFRACPlatform(log, {
    platform: 'HomebridgeMHIWFRACPlatform', ...config, devices: deviceConfigs,
  }, api);
  cache.forEach((context, i) => {
    const accessory = new api.platformAccessory(deviceConfigs[i].name, api.hap.uuid.generate(deviceConfigs[i].mac));
    accessory.context = {device: {name: deviceConfigs[i].name, mac: deviceConfigs[i].mac, ip: deviceConfigs[i].ip}, ...structuredClone(context)};
    platform.configureAccessory(accessory);
  });
  platform.configureDevices();
  return {api, platform, accessories, fakes, hap: api.hap};
}

const settled = async accessories => {
  for (const a of accessories) {
    await a.pollPromise;
    await a.pendingWrite;
    await a.device.queue;
  }
};

/** A HomeKit write, the way HAP delivers it: through the onSet handler, awaiting its outcome. */
const write = (service, characteristic, value) => service.getCharacteristic(characteristic).handleSetRequest(value);

const thermostat = a => a.accessory.getService(a.platform.Service.Thermostat);
const value = (service, characteristic) => service.getCharacteristic(characteristic).value;

test('self-register: one UUID for all devices, registered once, status read', async t => {
  const h = harness(t);
  await settled(h.accessories);
  assert.equal(h.accessories.length, 2);
  const [a, b] = h.accessories;
  assert.match(a.operatorId, /^[0-9a-f-]{36}$/);
  assert.equal(a.operatorId, b.operatorId);
  for (const fake of h.fakes) {
    assert.deepEqual([...fake.accounts], [a.operatorId]);
    assert.deepEqual(fake.requests.map(r => r.command), ['getDeviceInfo', 'updateAccountInfo', 'getAirconStat']);
  }
  assert.deepEqual(a.accessory.context.registration, {operatorId: a.operatorId});
  assert.equal(a.accessory.context.device.protocol, 'https');
  assert.equal(value(thermostat(a), h.hap.Characteristic.CurrentTemperature), 21.5);
  assert.equal(value(thermostat(a), h.hap.Characteristic.TargetTemperature), 20);
  assert.equal(value(thermostat(a), h.hap.Characteristic.TargetHeatingCoolingState), h.hap.Characteristic.TargetHeatingCoolingState.COOL);
});

test('a 2.5.x prefixed operator ID that never registered is replaced by the bare UUID (#41)', async t => {
  const h = harness(t, {cache: [{generatedOperatorId: LEGACY_ID, registered: false}, {generatedOperatorId: LEGACY_ID}]});
  for (const fake of h.fakes) {
    fake.malformedForOperatorIds.add(LEGACY_ID);
  }
  await settled(h.accessories);
  for (const a of h.accessories) {
    assert.equal(a.operatorId, UUID);
    assert.deepEqual(a.accessory.context.registration, {operatorId: UUID});
    assert.equal(a.accessory.context.registered, undefined);
  }
  assert.ok(h.fakes.every(f => f.requests.every(r => r.operatorId === UUID)));
});

test('a prefixed operator ID that did register is kept', async t => {
  const h = harness(t, {cache: [{generatedOperatorId: LEGACY_ID, registered: true}]});
  await settled(h.accessories);
  assert.equal(h.accessories[0].operatorId, LEGACY_ID);
  assert.equal(h.fakes[0].requests.filter(r => r.command === 'updateAccountInfo').length, 0);
});

test('mirror mode never registers and warns when the ID is not a listed remote', async t => {
  const log = recordingLog();
  const h = harness(t, {config: {operatorId: 'app-mine'}, log, devices: [new FakeDevice({accounts: ['app-phone-1', 'app-phone-2']})]});
  await settled(h.accessories);
  assert.equal(h.accessories[0].selfManaged, false);
  assert.deepEqual(h.fakes[0].requests.map(r => r.command), ['getDeviceInfo', 'getAirconStat']);
  assert.ok(log.lines.some(l => l.startsWith('warn:') && l.includes('app-mine') && l.includes('app-phone-1')));
});

test('a configured mac keeps its accessory UUID whatever its case', t => {
  const api = new HomebridgeAPI();
  assert.equal(api.hap.uuid.generate('348E89BEB22E') !== api.hap.uuid.generate('348e89beb22e'), true);
});

test('HomeKit writes are coalesced into one full-state setAirconStat', async t => {
  const h = harness(t, {devices: [new FakeDevice()]});
  await settled(h.accessories);
  const a = h.accessories[0];
  const {Characteristic} = h.hap;
  const service = thermostat(a);
  await Promise.all([
    write(service, Characteristic.TargetHeatingCoolingState, Characteristic.TargetHeatingCoolingState.HEAT),
    write(service, Characteristic.TargetTemperature, 23.5),
  ]);
  const writes = h.fakes[0].requests.filter(r => r.command === 'setAirconStat');
  assert.equal(writes.length, 1);
  assert.equal(h.fakes[0].status.operation, true);
  assert.equal(h.fakes[0].status.operationMode, 2);
  assert.equal(h.fakes[0].status.presetTemp, 23.5);
  // Untouched settings travel along unchanged.
  assert.equal(h.fakes[0].status.windDirectionLR, 2);
  assert.equal(h.fakes[0].status.modelNoRaw, 1);
  assert.equal(value(service, Characteristic.TargetHeatingCoolingState), Characteristic.TargetHeatingCoolingState.HEAT);
  assert.equal(value(service, Characteristic.CurrentHeatingCoolingState), Characteristic.CurrentHeatingCoolingState.HEAT);
});

test('turning the fan on while off switches to fan mode, and the thermostat shows off', async t => {
  const h = harness(t, {devices: [new FakeDevice()]});
  await settled(h.accessories);
  const a = h.accessories[0];
  const {Characteristic, Service} = h.hap;
  h.fakes[0].status = h.fakes[0].status.with({operation: false});
  await a.poll.call(Object.assign(a, {polled: false}));
  const fan = a.accessory.getService(Service.Fanv2);
  await Promise.all([
    write(fan, Characteristic.Active, Characteristic.Active.ACTIVE),
    write(fan, Characteristic.RotationSpeed, 75),
  ]);
  assert.equal(h.fakes[0].requests.filter(r => r.command === 'setAirconStat').length, 1);
  assert.equal(h.fakes[0].status.operation, true);
  assert.equal(h.fakes[0].status.operationMode, 3);
  assert.equal(h.fakes[0].status.airFlow, 3);
  assert.equal(value(thermostat(a), Characteristic.TargetHeatingCoolingState), Characteristic.TargetHeatingCoolingState.OFF);
  assert.equal(value(fan, Characteristic.RotationSpeed), 75);
});

test('a write refused because of the write lock is retried once the lock lapses', async t => {
  const log = recordingLog();
  const h = harness(t, {log, devices: [new FakeDevice()]});
  await settled(h.accessories);
  const a = h.accessories[0];
  const fake = h.fakes[0];
  fake.lockedBy = 'someones-phone';
  fake.expires = Math.floor(Date.now() / 1000) + 2;
  const {Characteristic} = h.hap;
  await write(thermostat(a), Characteristic.TargetHeatingCoolingState, Characteristic.TargetHeatingCoolingState.OFF);
  assert.equal(fake.status.operation, true, 'first attempt refused');
  assert.ok(log.lines.some(l => l.startsWith('warn:') && /retrying in \d+ s/.test(l)));
  await sleep(4500);
  await settled([a]);
  assert.equal(fake.status.operation, false);
  assert.equal(fake.requests.filter(r => r.command === 'setAirconStat').length, 2);
});

test('a self-managed ID the device forgot is registered again before the retry', async t => {
  const h = harness(t, {devices: [new FakeDevice()]});
  await settled(h.accessories);
  const a = h.accessories[0];
  const fake = h.fakes[0];
  fake.accounts.clear();
  const {Characteristic} = h.hap;
  await write(thermostat(a), Characteristic.TargetTemperature, 19);
  assert.equal(fake.status.presetTemp, 19);
  assert.deepEqual(fake.requests.slice(-3).map(r => r.command), ['setAirconStat', 'updateAccountInfo', 'setAirconStat']);
});

test('a mirrored ID that is not registered fails with an explanation', async t => {
  const log = recordingLog();
  const h = harness(t, {log, config: {operatorId: 'app-stranger'}, devices: [new FakeDevice({accounts: ['app-phone']})]});
  await settled(h.accessories);
  const {Characteristic} = h.hap;
  await assert.rejects(write(thermostat(h.accessories[0]), Characteristic.TargetTemperature, 19));
  assert.ok(log.lines.some(l => l.startsWith('error:') && l.includes('not registered') && l.includes('app-phone')));
});

test('the indoor temperature offset only affects what HomeKit shows', async t => {
  const h = harness(t, {config: {devices: [{indoorTemperatureOffset: -2}]}, devices: [new FakeDevice()]});
  await settled(h.accessories);
  const a = h.accessories[0];
  const current = thermostat(a).getCharacteristic(h.hap.Characteristic.CurrentTemperature);
  assert.equal(current.value, 19.5);
  assert.equal(current.props.minValue, -32);
  await write(thermostat(a), h.hap.Characteristic.TargetTemperature, 22);
  assert.equal(h.fakes[0].status.presetTemp, 22);
});

test('a full account table is reported once and status keeps flowing', async t => {
  const log = recordingLog();
  const h = harness(t, {log, devices: [new FakeDevice({accounts: ['a', 'b', 'c', 'd']})]});
  await settled(h.accessories);
  const a = h.accessories[0];
  assert.equal(a.accessory.context.registration, undefined);
  assert.equal(log.lines.filter(l => l.includes('four remotes')).length, 1);
  await a.poll.call(Object.assign(a, {polled: false}));
  assert.equal(h.fakes[0].requests.filter(r => r.command === 'updateAccountInfo').length, 1, 'not retried every poll');
  assert.equal(h.fakes[0].requests.filter(r => r.command === 'getAirconStat').length, 2, 'status is still read');
  assert.equal(value(thermostat(a), h.hap.Characteristic.CurrentTemperature), 21.5);
  await assert.rejects(write(thermostat(a), h.hap.Characteristic.TargetTemperature, 19));
  assert.equal(h.fakes[0].requests.filter(r => r.command === 'setAirconStat').length, 0);
});

test('unreachable devices are reported once, and once more when back', async t => {
  const log = recordingLog();
  const h = harness(t, {log, config: {ignoreConnectionErrors: true}, devices: [new FakeDevice()]});
  await settled(h.accessories);
  const a = h.accessories[0];
  h.fakes[0].offline = true;
  for (let i = 0; i < 4; i++) {
    await a.poll.call(Object.assign(a, {polled: false}));
  }
  assert.equal(log.lines.filter(l => l.startsWith('warn:') && l.includes('has not answered')).length, 1);
  assert.equal(log.lines.filter(l => l.startsWith('error:')).length, 0);
  h.fakes[0].offline = false;
  await a.poll.call(Object.assign(a, {polled: false}));
  assert.ok(log.lines.some(l => l.includes('reachable again')));
});

test('removing a device deregisters only its own remote', async t => {
  const h = harness(t, {devices: [new FakeDevice({accounts: ['app-phone']})]});
  await settled(h.accessories);
  const a = h.accessories[0];
  assert.equal(h.fakes[0].accounts.size, 2);
  await h.platform.cleanupRemovedAccessories([a.accessory]);
  assert.deepEqual([...h.fakes[0].accounts], ['app-phone']);
});
