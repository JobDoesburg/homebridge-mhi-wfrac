import assert from 'node:assert/strict';
import { test } from 'node:test';
import axios from 'axios';
import { HomebridgeAPI } from 'homebridge/lib/api.js';
import { HomebridgeMHIWFRACPlatform } from '../dist/platform.js';
import { WFRACAccessory } from '../dist/platformAccessory.js';
import { DeviceClient } from '../dist/device.js';

const uuid = '12345678-1234-4234-8234-123456789012';
const legacyId = `homebridge-${uuid}`;
const sampleStatus = 'AAeqmqT/AAAAAAASigAAAAAAAf////8hZoEEARIwmgAAgAIAAgAAAAAAAAOAIJr/gBCb/5QQAAB41A==';
const devices = [
  { name: 'First', mac: '001122334455', ip: '192.0.2.1' },
  { name: 'Second', mac: '001122334466', ip: '192.0.2.2' },
];
const quiet = { info() {}, warn() {}, error() {}, debug() {}, success() {} };

function platformHarness(t, { operatorId, cache = [], remotes = new Map() } = {}) {
  const api = new HomebridgeAPI();
  const instances = [];
  const requests = [];
  const saved = [];
  // Stop periodic work. Tests explicitly run the real registration/status flow.
  t.mock.method(WFRACAccessory.prototype, 'refreshStatus', function () { instances.push(this); });
  t.mock.method(DeviceClient.prototype, 'waitForNextRequestSlot', async () => {});
  t.mock.method(api, 'updatePlatformAccessories', accessories => {
    saved.push(...accessories.map(a => structuredClone(a.context)));
  });
  t.mock.method(axios, 'post', async (url, body) => {
    const request = JSON.parse(body);
    requests.push(request);
    const host = new URL(url).hostname;
    const mac = devices.find(d => d.ip === host).mac;
    assert.equal(new URL(url).pathname, `/beaver/command/${request.command}`);
    assert.equal(request.deviceId, mac);
    assert.equal(typeof request.timestamp, 'number');
    // Reproduce firmware 025's observed response to the old generated ID.
    if (request.operatorId.length > 36) {
      return { data: `{"command":"${request.command}","apiVer":"1.0","deviceId":"","operatorId":"","timestamp":,"result":1}` };
    }
    const accounts = remotes.get(host) ?? new Set();
    remotes.set(host, accounts);
    const data = { ...request, result: 0 };
    switch (request.command) {
      case 'getDeviceInfo':
        data.contents = { airconId: mac, macAddress: mac, apMode: 0 };
        break;
      case 'updateAccountInfo':
        assert.equal(request.contents.accountId, request.operatorId);
        assert.equal(request.contents.airconId, mac);
        if (accounts.size === 4 && !accounts.has(request.operatorId)) {
          data.result = 2;
        } else {
          accounts.add(request.operatorId);
        }
        break;
      case 'getAirconStat':
        assert.equal(request.contents.airconId, mac);
        data.contents = { airconId: mac, airconStat: sampleStatus, remoteList: [...accounts] };
        break;
      case 'deleteAccountInfo':
        assert.equal(request.contents.accountId, request.operatorId);
        accounts.delete(request.operatorId);
        break;
      default:
        assert.fail(`Unexpected command: ${request.command}`);
    }
    return { data };
  });
  const platform = new HomebridgeMHIWFRACPlatform(quiet, {
    platform: 'HomebridgeMHIWFRACPlatform', devices, operatorId,
  }, api);
  for (let i = 0; i < cache.length; i++) {
    const accessory = new api.platformAccessory(devices[i].name, api.hap.uuid.generate(devices[i].mac));
    accessory.context = { device: { ...devices[i] }, ...structuredClone(cache[i]) };
    platform.configureAccessory(accessory);
  }
  return { platform, instances, requests, remotes, saved };
}

test('blank Operator ID registers both devices using one standard UUID and reads status', async t => {
  const h = platformHarness(t);
  h.platform.configureDevices();
  assert.equal(h.instances.length, 2);
  const ids = h.instances.map(a => a.operatorId);
  assert.match(ids[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(ids[0], ids[1]);
  for (const a of h.instances) {
    await a.ensureRegistered();
    assert.equal(a.accessory.context.registered, true);
    assert.equal(a.accessory.context.generatedOperatorId, ids[0]);
    await a.device.getDeviceStatus();
    await a.ensureRegistered();
  }
  assert.equal(h.requests.filter(r => r.command === 'updateAccountInfo').length, 2);
});

test('failed v2.5.2 cached IDs migrate consistently and register on firmware 025', async t => {
  const h = platformHarness(t, { cache: [
    { generatedOperatorId: legacyId, registered: false },
    { generatedOperatorId: legacyId },
  ] });
  h.platform.configureDevices();
  for (const a of h.instances) {
    assert.equal(a.operatorId, uuid);
    await a.ensureRegistered();
    await a.device.getDeviceStatus();
    assert.equal(a.accessory.context.registered, true);
  }
  assert.equal(h.saved.length, 2);
  assert.ok(h.saved.every(c => c.generatedOperatorId === uuid));
  assert.ok(h.requests.every(r => r.operatorId === uuid));
});

test('a cached UUID is reused after restart without allocating another remote', async t => {
  const h = platformHarness(t, { cache: [
    { generatedOperatorId: uuid, registered: true },
    { generatedOperatorId: uuid, registered: true },
  ] });
  h.platform.configureDevices();
  for (const a of h.instances) {
    assert.equal(a.operatorId, uuid);
    await a.ensureRegistered();
  }
  assert.equal(h.requests.length, 0);
});

test('working legacy registrations are preserved ahead of failed cached identities', t => {
  const other = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const h = platformHarness(t, { cache: [
    { generatedOperatorId: other, registered: false },
    { generatedOperatorId: legacyId, registered: true },
  ] });
  assert.deepEqual(h.platform.resolveOperatorId(), { operatorId: legacyId, selfManaged: true });
});

test('explicit Operator ID takes priority and never registers or deregisters an app remote', async t => {
  const h = platformHarness(t, { operatorId: uuid, cache: [
    { generatedOperatorId: legacyId, registered: true },
  ] });
  h.platform.configureDevices();
  for (const a of h.instances) {
    assert.equal(a.selfManaged, false);
    assert.equal(a.operatorId, uuid);
    assert.equal(a.accessory.context.generatedOperatorId, undefined);
    await a.ensureRegistered();
  }
  await h.platform.cleanupRemovedAccessories(h.instances.map(a => a.accessory));
  assert.equal(h.requests.length, 0);
});

test('removing the manual workaround does not reuse a stale registered flag', async t => {
  const h = platformHarness(t, { cache: [{ registered: true }] });
  h.platform.configureDevices();
  assert.equal(h.instances[0].accessory.context.registered, false);
  await h.instances[0].ensureRegistered();
  assert.equal(h.requests.filter(r => r.command === 'updateAccountInfo').length, 1);
  assert.equal(h.instances[0].accessory.context.registered, true);
});

test('the four-account limit remains a failed registration', async t => {
  const remotes = new Map([[devices[0].ip, new Set(['a', 'b', 'c', 'd'])]]);
  const h = platformHarness(t, { remotes });
  h.platform.configureDevices();
  await h.instances[0].ensureRegistered();
  assert.notEqual(h.instances[0].accessory.context.registered, true);
  assert.equal(remotes.get(devices[0].ip).size, 4);
});

test('removing a self-managed device deletes only its own remote', async t => {
  const remotes = new Map([[devices[0].ip, new Set(['existing-app-remote'])]]);
  const h = platformHarness(t, { remotes });
  h.platform.configureDevices();
  const a = h.instances[0];
  await a.ensureRegistered();
  assert.equal(remotes.get(devices[0].ip).size, 2);
  await h.platform.cleanupRemovedAccessories([a.accessory]);
  assert.deepEqual([...remotes.get(devices[0].ip)], ['existing-app-remote']);
});

test('the emulator reproduces the original malformed response for prefixed UUIDs', async t => {
  platformHarness(t);
  const client = new DeviceClient(devices[0].ip, 51443, legacyId, devices[0].mac, devices[0].mac, quiet);
  await assert.rejects(client.getDeviceInfo(), /getDeviceInfo failed/);
});
