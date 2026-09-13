import assert from 'node:assert/strict';
import {test} from 'node:test';

import {DeviceClient} from '../dist/deviceClient.js';
import {DeviceConnectionError, DeviceResponseError, NotRegisteredError, WriteRefusedError} from '../dist/errors.js';
import {FakeDevice, installFakeDevices, quietLog} from './fakeDevice.mjs';

function client(device, overrides = {}) {
  return new DeviceClient({
    ip: device.ip, operatorId: 'op-1', deviceId: device.mac, airconId: device.mac, log: quietLog, minRequestGapMs: 0, ...overrides,
  });
}

test('detects HTTPS, then HTTP, and reports the protocol it settled on', async t => {
  for (const protocol of ['https', 'http']) {
    const device = new FakeDevice({protocol});
    installFakeDevices(t, [device]);
    const detected = [];
    const c = client(device, {onProtocolDetected: p => detected.push(p)});
    const status = await c.getStatus();
    assert.equal(status.presetTemp, 20);
    assert.deepEqual(detected, [protocol]);
  }
});

test('a cached protocol is used directly and re-detected after a connection failure', async t => {
  const device = new FakeDevice({protocol: 'http'});
  installFakeDevices(t, [device]);
  const c = client(device, {protocol: 'http'});
  await c.getStatus();
  assert.equal(device.requests.length, 1);

  device.offline = true;
  await assert.rejects(c.getStatus(), DeviceConnectionError);
  device.offline = false;
  device.protocol = 'https';
  await c.getStatus();
  assert.equal(device.requests.length, 2);
});

test('a malformed body (rejected operator ID) is a response error, not a crash', async t => {
  const device = new FakeDevice();
  device.malformedForOperatorIds.add('homebridge-bad');
  installFakeDevices(t, [device]);
  const c = client(device, {operatorId: 'homebridge-bad'});
  await assert.rejects(c.getDeviceInfo(), error => error instanceof DeviceResponseError && /malformed/.test(error.message));
});

test('getAirconStat with a non-zero result still yields the state it carries', async t => {
  const device = new FakeDevice();
  installFakeDevices(t, [device]);
  device.json = (request, extra) => ({data: JSON.stringify({...extra, result: 1, command: request.command})});
  const status = await client(device).getStatus();
  assert.equal(status.operation, true);
});

test('setAirconStat maps result codes to typed errors and returns the confirmed state', async t => {
  const device = new FakeDevice();
  installFakeDevices(t, [device]);
  const c = client(device);
  const base = await c.getStatus();

  await assert.rejects(c.setStatus(base.with({operation: false})), NotRegisteredError);
  assert.equal(await c.register('Europe/Amsterdam'), 'registered');

  const confirmed = await c.setStatus(base.with({operation: false, presetTemp: 22.5}));
  assert.equal(confirmed.operation, false);
  assert.equal(confirmed.presetTemp, 22.5);
  assert.equal(c.status, confirmed);

  device.lockedBy = 'someones-phone';
  device.expires = Math.floor(Date.now() / 1000) + 30;
  await assert.rejects(c.setStatus(base), error => error instanceof WriteRefusedError && error.result === 12 && error.expires === device.expires);
});

test('registration reports a full account table', async t => {
  const device = new FakeDevice({accounts: ['a', 'b', 'c', 'd']});
  installFakeDevices(t, [device]);
  assert.equal(await client(device).register('UTC'), 'full');
  assert.equal(device.accounts.size, 4);
});

test('requests are serialized and spaced apart', async t => {
  const device = new FakeDevice();
  installFakeDevices(t, [device]);
  const c = client(device, {minRequestGapMs: 50});
  const started = Date.now();
  await Promise.all([c.getStatus(), c.getStatus(), c.getStatus()]);
  assert.ok(Date.now() - started >= 100, 'three requests need two gaps');
  assert.equal(device.requests.length, 3);
});
