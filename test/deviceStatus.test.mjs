// Vectors in vectors.json were produced by pywfrac (the protocol library of the Home Assistant
// integration) — see the generator described in test/README.md.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {DeviceStatus} from '../dist/protocol/deviceStatus.js';
import {crc16ccitt} from '../dist/protocol/crc16.js';

const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));

test('crc16-ccitt matches the known check value', () => {
  assert.equal(crc16ccitt([...Buffer.from('123456789')]), 0x29B1);
});

for (const [name, expected] of Object.entries(vectors.decoded)) {
  test(`decodes the ${name} capture like the reference parser`, () => {
    const status = DeviceStatus.fromBase64(expected.base64);
    for (const [key, value] of Object.entries(expected)) {
      if (key !== 'base64') {
        assert.equal(status[key], value, key);
      }
    }
  });
}

for (const vector of vectors.encoded) {
  const s = vector.state;
  test(`encodes ${JSON.stringify(s)} like the reference encoder`, () => {
    const status = new DeviceStatus().with({});
    Object.assign(status, s);
    assert.equal(status.toBase64(), vector.base64);
  });
}

test('the command block of the model-1 capture matches what the official app sent (issue #43)', () => {
  // The device echoes the last accepted command in the first block of the blob.
  const blob = Buffer.from(vectors.decoded.issue43.base64, 'base64');
  const echoedCommand = [...blob.subarray(0, 18)];
  const status = DeviceStatus.fromBase64(vectors.decoded.issue43.base64);
  const ours = status.commandBytes();
  // Byte 1 has no known meaning and is 0 in the reference encoder too; byte 8 carries the cool/hot
  // judge flag, which the unit may have flipped since the app wrote.
  ours[1] = echoedCommand[1];
  ours[8] = echoedCommand[8];
  assert.deepEqual(ours, echoedCommand);
});

test('with() returns a modified copy and leaves the original alone', () => {
  const status = DeviceStatus.fromBase64(vectors.decoded.issue43.base64);
  const next = status.with({operation: false, presetTemp: 22.5});
  assert.equal(next.operation, false);
  assert.equal(next.presetTemp, 22.5);
  assert.equal(next.modelNoRaw, status.modelNoRaw);
  assert.equal(status.operation, true);
  assert.equal(status.presetTemp, 20);
});

test('error codes follow the family bit before the zero test', () => {
  const encode = state => {
    const cmd = [0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 255, 255, 255, 255, 0, 0];
    return Buffer.from([...cmd, ...state, 1, 255, 255, 255, 255, 0, 0]).toString('base64');
  };
  const state = new Array(18).fill(0);
  assert.equal(DeviceStatus.fromBase64(encode(state)).errorCode, '00');
  state[6] = 0x85;
  assert.equal(DeviceStatus.fromBase64(encode(state)).errorCode, 'M05');
  state[6] = 0x21;
  assert.equal(DeviceStatus.fromBase64(encode(state)).errorCode, 'E33');
});
