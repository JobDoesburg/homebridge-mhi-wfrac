// A WF-RAC module emulated at the axios.post level, so the client and accessory can be exercised end to end.
import assert from 'node:assert/strict';
import axios from 'axios';

import {DeviceStatus} from '../dist/protocol/deviceStatus.js';
import {appendCrc16} from '../dist/protocol/crc16.js';

/** Indoor 21.5 °C, outdoor 22.2 °C, 0.5 kWh: the pushed segments of the sample capture. */
const SEGMENTS = [3, 0x80, 0x20, 0x91, 0xFF, 0x80, 0x10, 0xB4, 0xFF, 0x94, 0x10, 0x02, 0x00];

/** Encodes a state the way the module reports it: receive block followed by the pushed segments. */
export function encodeReport(status) {
  const command = appendCrc16([...status.commandBytes(), 1, 0xFF, 0xFF, 0xFF, 0xFF]);
  const receive = appendCrc16([...status.receiveBytes(), ...SEGMENTS]);
  return Buffer.from([...command, ...receive]).toString('base64');
}

export const SAMPLE_STATUS = 'AAeriaj/AAAAAAARigAAAAAAAf/////vW4EECQEokQAAiAIAAQAAAAAAAAOAIJH/gBC0/5QQAgCQsQ==';

export class FakeDevice {
  constructor({ip = '192.0.2.1', protocol = 'https', accounts = [], mac = '001122334455'} = {}) {
    this.ip = ip;
    this.protocol = protocol;
    this.accounts = new Set(accounts);
    this.mac = mac;
    this.requests = [];
    this.status = DeviceStatus.fromBase64(SAMPLE_STATUS);
    this.expires = 0;
    this.lockedBy = null;
    this.offline = false;
    /** setAirconStat result to answer regardless of state, or null for normal behaviour. */
    this.forceSetResult = null;
    this.malformedForOperatorIds = new Set();
  }

  json(request, extra = {}) {
    return {data: JSON.stringify({command: request.command, apiVer: '1.0', operatorId: request.operatorId,
      deviceId: request.deviceId, timestamp: request.timestamp, ...extra})};
  }

  statusContents() {
    return {
      airconId: this.mac, airconStat: encodeReport(this.status), expires: this.expires, updatedBy: this.lockedBy ?? 'local',
      firmType: 'WF-RAC-HTTPS', wireless: {firmVer: '025'}, mcu: {firmVer: '200'},
      remoteList: [...this.accounts].filter(a => a.startsWith('app-')), numOfAccount: this.accounts.size,
    };
  }

  async handle(url, body) {
    const {protocol, hostname, pathname} = new URL(url);
    assert.equal(hostname, this.ip);
    if (this.offline) {
      const error = new axios.AxiosError('timeout of 20000ms exceeded', 'ECONNABORTED');
      throw error;
    }
    if (protocol.replace(':', '') !== this.protocol) {
      throw new axios.AxiosError('socket hang up', 'ECONNRESET');
    }
    const request = JSON.parse(body);
    this.requests.push(request);
    assert.equal(pathname, `/beaver/command/${request.command}`);
    assert.equal(typeof request.timestamp, 'number');
    if (this.malformedForOperatorIds.has(request.operatorId)) {
      return {status: 200, data: `{"command":"${request.command}","apiVer":"1.0","deviceId":"","operatorId":"","timestamp":,"result":1}`};
    }
    switch (request.command) {
      case 'getDeviceInfo':
        return {status: 200, ...this.json(request, {result: 0, contents: {airconId: this.mac, macAddress: this.mac, apMode: 0}})};
      case 'getAirconStat':
        assert.equal(request.contents.airconId, this.mac);
        return {status: 200, ...this.json(request, {result: 0, contents: this.statusContents()})};
      case 'updateAccountInfo':
        assert.equal(request.contents.accountId, request.operatorId);
        if (this.accounts.size >= 4 && !this.accounts.has(request.operatorId)) {
          return {status: 200, ...this.json(request, {result: 2})};
        }
        this.accounts.add(request.operatorId);
        return {status: 200, ...this.json(request, {result: 0})};
      case 'deleteAccountInfo':
        this.accounts.delete(request.operatorId);
        return {status: 200, ...this.json(request, {result: 0})};
      case 'setAirconStat': {
        if (this.forceSetResult !== null) {
          return {status: 200, ...this.json(request, {result: this.forceSetResult, contents: this.statusContents()})};
        }
        if (!this.accounts.has(request.operatorId)) {
          return {status: 200, ...this.json(request, {result: 2, contents: this.statusContents()})};
        }
        if (this.lockedBy && this.lockedBy !== request.deviceId && this.expires >= request.timestamp) {
          return {status: 200, ...this.json(request, {result: 12, contents: this.statusContents()})};
        }
        const written = DeviceStatus.fromBase64(request.contents.airconStat);
        // The unit applies the command block; use the receive half the client built as its new state.
        this.status = written;
        this.lockedBy = request.deviceId;
        this.expires = request.timestamp + 60;
        return {status: 200, ...this.json(request, {result: 0, contents: this.statusContents()})};
      }
      default:
        assert.fail(`unexpected command ${request.command}`);
    }
  }
}

/** Routes axios.post to the fake devices for the duration of the test. */
export function installFakeDevices(t, devices) {
  t.mock.method(axios, 'post', async (url, body) => {
    const host = new URL(url).hostname;
    const device = devices.find(d => d.ip === host);
    assert.ok(device, `no fake device at ${host}`);
    return device.handle(url, body);
  });
}

export const quietLog = {info() {}, warn() {}, error() {}, debug() {}, success() {}};

export function recordingLog() {
  const lines = [];
  const log = {lines};
  for (const level of ['info', 'warn', 'error', 'debug', 'success']) {
    log[level] = (...args) => lines.push(`${level}: ${args.join(' ')}`);
  }
  return log;
}
