import assert from 'node:assert/strict';
import {test} from 'node:test';

import {parsePlatformConfig} from '../dist/config.js';
import {quietLog, recordingLog} from './fakeDevice.mjs';

test('defaults', () => {
  const config = parsePlatformConfig({platform: 'x', devices: [{name: 'AC', mac: '001122334455', ip: '10.0.0.1'}]}, quietLog);
  assert.equal(config.operatorId, null);
  assert.equal(config.ignoreConnectionErrors, true);
  assert.equal(config.pollIntervalMs, 60000);
  assert.deepEqual(config.devices, [{
    name: 'AC', mac: '001122334455', ip: '10.0.0.1', deviceId: '001122334455', hideDehumidifier: false, indoorTemperatureOffset: 0,
  }]);
});

test('the placeholder operator ID counts as blank', () => {
  assert.equal(parsePlatformConfig({platform: 'x', operatorId: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'}, quietLog).operatorId, null);
  assert.equal(parsePlatformConfig({platform: 'x', operatorId: ' abc '}, quietLog).operatorId, 'abc');
});

test('poll interval is bounded and offsets are numbers', () => {
  const log = recordingLog();
  assert.equal(parsePlatformConfig({platform: 'x', pollInterval: 5}, log).pollIntervalMs, 60000);
  assert.equal(log.lines.length, 1);
  assert.equal(parsePlatformConfig({platform: 'x', pollInterval: '45'}, quietLog).pollIntervalMs, 45000);
  const config = parsePlatformConfig({platform: 'x', devices: [
    {name: 'A', mac: 'AABBCCDDEEFF', ip: '10.0.0.1', indoorTemperatureOffset: '-1.5', hideDehumidifier: true, deviceId: 'phone'},
  ]}, quietLog);
  assert.equal(config.devices[0].indoorTemperatureOffset, -1.5);
  assert.equal(config.devices[0].hideDehumidifier, true);
  assert.equal(config.devices[0].deviceId, 'phone');
  assert.equal(config.devices[0].mac, 'AABBCCDDEEFF', 'kept as configured, the accessory UUID depends on it');
});

test('devices without a valid MAC or IP are skipped with an error', () => {
  const log = recordingLog();
  const config = parsePlatformConfig({platform: 'x', devices: [
    {name: 'bad mac', mac: '00:11:22:33:44:55', ip: '10.0.0.1'},
    {name: 'no ip', mac: '001122334455'},
    {name: 'ok', mac: '001122334466', ip: '10.0.0.2'},
  ]}, log);
  assert.deepEqual(config.devices.map(d => d.name), ['ok']);
  assert.equal(log.lines.filter(l => l.startsWith('error:')).length, 2);
});
