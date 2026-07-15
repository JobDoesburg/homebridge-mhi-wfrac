import assert from 'node:assert/strict';
import test from 'node:test';

import {DeviceClient, DeviceStatus, generateLegacyOperatorId} from '../dist/device.js';

const applyState = (values) => Object.assign(new DeviceStatus(), values);

const baseState = {
  operation: true,
  operationMode: 1,
  airFlow: 0,
  windDirectionUD: 0,
  windDirectionLR: 0,
  presetTemp: 22.5,
  entrust: false,
  coolHotJudge: false,
  modelNo: 0,
  isVacantProperty: 0,
  isSelfCleanReset: false,
  isSelfCleanOperation: false,
};

const log = {
  debug() {},
  error() {},
  info() {},
  warn() {},
};

test('encodes the full cool-mode packet like the Home Assistant reference', () => {
  const status = applyState(baseState);

  assert.equal(Buffer.from(status.commandToByte()).toString('hex'), '0000eb8fadff0000080000100b0000000000');
  assert.equal(Buffer.from(DeviceStatus.receiveToBytes(status)).toString('hex'), '000049072dff000008000000010000000000');
  assert.equal(status.toBase64(), 'AADrj63/AAAIAAAQCwAAAAAAAf/////JDwAASQct/wAACAAAAAEAAAAAAAH/////tf8=');
});

test('encodes model-specific fields like the Home Assistant reference', () => {
  const status = applyState({
    ...baseState,
    operationMode: 2,
    airFlow: 3,
    windDirectionUD: 3,
    windDirectionLR: 4,
    presetTemp: 24,
    entrust: true,
    coolHotJudge: true,
    modelNo: 1,
    isVacantProperty: 1,
    isSelfCleanReset: true,
    isSelfCleanOperation: true,
  });

  assert.equal(status.toBase64(), 'AACzqrD/AAAAAJUTDgAAAAAAAf////+wHgEAESIw/wAAAAABAwQAAAEAAAH/////rWo=');
});

test('retains the established 25 degree placeholder in fan mode', () => {
  const status = applyState({
    ...baseState,
    operation: false,
    operationMode: 3,
    airFlow: 1,
    windDirectionUD: 1,
    windDirectionLR: 7,
    presetTemp: 21,
    modelNo: 2,
  });

  assert.equal(status.toBase64(), 'AACuiLL/AAAIAIAWCgAAAAAAAf////9A0gIADAAy/wAACAAABgAAAAAAAAH/////il0=');
});

test('generates exactly ten decimal digits for legacy firmware', () => {
  for (let index = 0; index < 100; index++) {
    assert.match(generateLegacyOperatorId(), /^\d{10}$/);
  }
});

test('retries a rejected UUID once and persists the accepted numeric operator ID', async () => {
  const originalOperatorId = 'homebridge-5ef7431c-03a9-4637-b994-73d252959292';
  const legacyOperatorId = '1234567890';
  const accepted = [];
  const requests = [];
  const client = new DeviceClient(
    '192.0.2.1',
    51443,
    originalOperatorId,
    'test-device',
    'test-aircon',
    log,
    false,
    operatorId => accepted.push(operatorId),
    () => legacyOperatorId,
  );

  client.useHttps = false;
  client.sendRequest = async (_url, body) => {
    requests.push(JSON.parse(body));
    if (requests.length === 1) {
      const error = new Error('Request failed with status code 501');
      error.isAxiosError = true;
      error.response = {status: 501, statusText: 'Not Implemented', data: 'Not supported this command'};
      throw error;
    }
    return {
      data: {
        command: 'updateAccountInfo',
        apiVer: '1.0',
        operatorId: legacyOperatorId,
        deviceId: 'test-device',
        timestamp: 0,
        result: 0,
        contents: {},
      },
    };
  };

  const response = await client.call('updateAccountInfo', {
    accountId: originalOperatorId,
    airconId: 'test-aircon',
  });

  assert.equal(response.result, 0);
  assert.deepEqual(requests.map(request => request.operatorId), [originalOperatorId, legacyOperatorId]);
  assert.deepEqual(requests.map(request => request.contents.accountId), [originalOperatorId, legacyOperatorId]);
  assert.deepEqual(accepted, [legacyOperatorId]);
});

test('does not fall back for unrelated HTTP 501 responses', async () => {
  const client = new DeviceClient(
    '192.0.2.1', 51443, 'long-operator-id', 'test-device', 'test-aircon', log, false, () => {
      assert.fail('fallback must not be persisted');
    },
  );
  const error = new Error('Request failed with status code 501');
  error.isAxiosError = true;
  error.response = {status: 501, statusText: 'Not Implemented', data: 'Different failure'};
  client.useHttps = false;
  client.sendRequest = async () => { throw error; };

  await assert.rejects(client.call('getAirconStat', {airconId: 'test-aircon'}), error);
});
