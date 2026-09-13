import https from 'https';
import {Logging} from 'homebridge';
import axios, {AxiosError} from 'axios';

import {DeviceStatus} from './protocol/deviceStatus.js';
import {DeviceConnectionError, DeviceResponseError, NotRegisteredError, WriteRefusedError} from './errors.js';

export type Protocol = 'http' | 'https';

export interface DeviceClientOptions {
  ip: string;
  port?: number;
  /** Identifies this client as a remote control; must be registered before writing. */
  operatorId: string;
  /** Free-form client id; the device's 60-second write lock is keyed on it. */
  deviceId: string;
  /** The device-reported aircon id, or the MAC until getDeviceInfo has answered. */
  airconId: string;
  log: Logging;
  /** Protocol that worked before (e.g. from the accessory cache); it is tried first. */
  protocol?: Protocol | null;
  onProtocolDetected?: (protocol: Protocol) => void;
  requestTimeoutMs?: number;
  minRequestGapMs?: number;
}

export interface DeviceInfo {
  airconId: string;
  macAddress: string;
  apMode: number;
}

/** The fields the device sends alongside the airconStat blob. */
export interface StatusResponse {
  airconStat: string;
  numOfAccount?: number;
  remoteList?: (string | null)[];
  /** Unix time at which the current holder's 60-second write lock lapses. */
  expires?: number;
  updatedBy?: string;
  firmType?: string;
  wireless?: {firmVer?: string};
  mcu?: {firmVer?: string};
}

interface ApiResponse {
  command?: string;
  result?: number | string;
  contents?: Record<string, unknown>;
}

export type RegistrationResult = 'registered' | 'full';

/** setAirconStat results meaning "declined, try again later" rather than "unknown account". */
const WRITE_REFUSED_RESULTS = new Set([1, 11, 12]);
const RESULT_NOT_REGISTERED = 2;

/**
 * HTTP client for one WF-RAC module. Requests are serialized with at least a second between them:
 * the module handles a single connection at a time and drops connections that come faster.
 */
export class DeviceClient {
  static readonly DEFAULT_PORT = 51443;
  static readonly MIN_REQUEST_GAP_MS = 1000;
  /** The module is slow and regularly needs 10-20 s to answer. */
  static readonly DEFAULT_REQUEST_TIMEOUT_MS = 20000;

  private readonly ip: string;
  private readonly port: number;
  private readonly operatorId: string;
  private readonly deviceId: string;
  private airconId: string;
  private readonly log: Logging;
  private readonly requestTimeoutMs: number;
  private readonly minRequestGapMs: number;
  private readonly onProtocolDetected?: (protocol: Protocol) => void;

  /** Protocol known to work; null until detected or after a connection failure (re-detect next time). */
  private protocol: Protocol | null;
  /** Protocol to try first while detecting. */
  private preferredProtocol: Protocol | null;

  private queue: Promise<unknown> = Promise.resolve();
  private nextRequestAfter = 0;
  private inFlight = 0;

  /** Last state read from or confirmed by the device; null until the first successful read. */
  status: DeviceStatus | null = null;
  /** Metadata of the last status response (accounts, firmware, write lock expiry). */
  lastStatusResponse: StatusResponse | null = null;

  // Newer WF-RAC firmware (HTTPS on 51443) links a 2016 mbedTLS: it needs TLS 1.2 with ALPN restricted
  // to http/1.1 and a self-signed certificate. Node's defaults (TLS 1.3, h2) make the handshake hang.
  private readonly httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    secureProtocol: 'TLSv1_2_method',
    ALPNProtocols: ['http/1.1'],
    keepAlive: false,
  });

  constructor(options: DeviceClientOptions) {
    this.ip = options.ip;
    this.port = options.port ?? DeviceClient.DEFAULT_PORT;
    this.operatorId = options.operatorId;
    this.deviceId = options.deviceId;
    this.airconId = options.airconId;
    this.log = options.log;
    this.protocol = options.protocol ?? null;
    this.preferredProtocol = options.protocol ?? null;
    this.onProtocolDetected = options.onProtocolDetected;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DeviceClient.DEFAULT_REQUEST_TIMEOUT_MS;
    this.minRequestGapMs = options.minRequestGapMs ?? DeviceClient.MIN_REQUEST_GAP_MS;
  }

  get label(): string {
    return `${this.deviceId} (${this.ip})`;
  }

  getAirconId(): string {
    return this.airconId;
  }

  /** True while a request is being sent or waiting for its turn. */
  get busy(): boolean {
    return this.inFlight > 0;
  }

  async getDeviceInfo(): Promise<DeviceInfo> {
    const response = await this.call('getDeviceInfo', null, {retries: 1});
    const contents = response.contents as Partial<DeviceInfo> | undefined;
    if (!contents?.airconId) {
      throw new DeviceResponseError(`getDeviceInfo failed for ${this.label}: ${JSON.stringify(response)}`, response);
    }
    if (contents.airconId !== this.airconId) {
      this.log.info(`Device ${this.label} reports airconId ${contents.airconId} (was ${this.airconId})`);
      this.airconId = contents.airconId;
    }
    return contents as DeviceInfo;
  }

  /**
   * Reads the current state. A non-zero result on getAirconStat only means the module had no fresh
   * data from the indoor unit; the blob it sends along is still the best known state, so it is parsed.
   */
  async getStatus(): Promise<DeviceStatus> {
    const response = await this.call('getAirconStat', {airconId: this.airconId}, {retries: 0});
    return this.applyStatusResponse('getAirconStat', response);
  }

  /** Writes the complete state and returns the state the device confirmed. */
  async setStatus(status: DeviceStatus): Promise<DeviceStatus> {
    const contents = {airconId: this.airconId, airconStat: status.toBase64()};
    const response = await this.call('setAirconStat', contents, {retries: 1});
    const result = resultCode(response);
    if (WRITE_REFUSED_RESULTS.has(result)) {
      const expires = (response.contents as StatusResponse | undefined)?.expires ?? null;
      throw new WriteRefusedError(
        `Device ${this.label} refused setAirconStat with result ${result} ` +
        '(another controller holds the write lock, or the indoor unit declined)', result, expires);
    }
    if (result === RESULT_NOT_REGISTERED) {
      throw new NotRegisteredError(
        `Device ${this.label} refused setAirconStat with result 2: operator ID ${this.operatorId} is not registered on it`);
    }
    return this.applyStatusResponse('setAirconStat', response);
  }

  async register(timezone: string): Promise<RegistrationResult> {
    const response = await this.call('updateAccountInfo', {
      accountId: this.operatorId,
      airconId: this.airconId,
      remote: 0,
      timezone,
    }, {retries: 1});
    // On updateAccountInfo result 2 means the four account slots are taken. Anything else is treated as
    // success: some firmware omits the result or reports it as a string.
    return resultCode(response) === RESULT_NOT_REGISTERED ? 'full' : 'registered';
  }

  async deregister(): Promise<void> {
    await this.call('deleteAccountInfo', {accountId: this.operatorId, airconId: this.airconId}, {retries: 1});
  }

  private applyStatusResponse(command: string, response: ApiResponse): DeviceStatus {
    const contents = response.contents as StatusResponse | undefined;
    if (typeof contents?.airconStat !== 'string') {
      throw new DeviceResponseError(`Device ${this.label} answered ${command} without a state: ${JSON.stringify(response)}`, response);
    }
    const result = resultCode(response);
    if (result !== 0) {
      this.log.debug(`Device ${this.label} answered ${command} with result ${result}; using the state it sent along`);
    }
    this.status = DeviceStatus.fromBase64(contents.airconStat);
    this.lastStatusResponse = contents;
    return this.status;
  }

  /**
   * Sends one command. Connection errors are retried `retries` times with a short backoff; a device that
   * answers (even with an error) is never retried here, that is the caller's decision.
   */
  private call(command: string, contents: Record<string, unknown> | null, options: {retries: number}): Promise<ApiResponse> {
    const run = async (): Promise<ApiResponse> => {
      this.inFlight++;
      try {
        let lastError: unknown;
        for (let attempt = 0; attempt <= options.retries; attempt++) {
          try {
            return await this.send(command, contents);
          } catch (error) {
            lastError = error;
            if (!(error instanceof DeviceConnectionError) || attempt === options.retries) {
              throw error;
            }
            const backoffMs = 1000 * 2 ** attempt;
            this.log.debug(`${command} to ${this.label} failed (${error.message}); retrying in ${backoffMs} ms`);
            await sleep(backoffMs);
          }
        }
        throw lastError;
      } finally {
        this.inFlight--;
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** One request, over the known protocol, or over both while detecting which one the device speaks. */
  private async send(command: string, contents: Record<string, unknown> | null): Promise<ApiResponse> {
    const body = JSON.stringify({
      apiVer: '1.0',
      command,
      deviceId: this.deviceId,
      operatorId: this.operatorId,
      // The module has no clock of its own: it takes the time from this field.
      timestamp: Math.floor(Date.now() / 1000),
      ...(contents ? {contents} : {}),
    });

    if (this.protocol) {
      try {
        return await this.post(this.protocol, command, body);
      } catch (error) {
        if (error instanceof DeviceConnectionError) {
          // The device may be down, or it may have switched protocol (firmware update): re-detect next time.
          this.preferredProtocol = this.protocol;
          this.protocol = null;
        }
        throw error;
      }
    }

    // Newer firmware is HTTPS-only; a plain-HTTP probe against it hangs until the timeout, so HTTPS goes first.
    const candidates: Protocol[] = this.preferredProtocol === 'http' ? ['http', 'https'] : ['https', 'http'];
    let lastError: unknown;
    let responseError: DeviceResponseError | null = null;
    for (const protocol of candidates) {
      try {
        const response = await this.post(protocol, command, body);
        if (protocol !== this.preferredProtocol) {
          this.log.info(`Device ${this.label}: using ${protocol.toUpperCase()}`);
        }
        this.protocol = protocol;
        this.preferredProtocol = protocol;
        this.onProtocolDetected?.(protocol);
        return response;
      } catch (error) {
        lastError = error;
        if (error instanceof DeviceResponseError) {
          responseError ??= error;
        }
        this.log.debug(`${protocol.toUpperCase()} ${command} to ${this.label} failed: ${(error as Error).message}`);
      }
    }
    // An answer, even a bad one, says more than a dropped connection on the other protocol.
    throw responseError ?? lastError;
  }

  private async post(protocol: Protocol, command: string, body: string): Promise<ApiResponse> {
    const waitMs = this.nextRequestAfter - Date.now();
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    const url = `${protocol}://${this.ip}:${this.port}/beaver/command/${command}`;
    try {
      // axios rather than fetch: fetch lowercases header names, which the module rejects.
      const response = await axios.post<string>(url, body, {
        timeout: this.requestTimeoutMs,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'User-Agent': 'smartmair_app[1.4.005]',
          'Accept': '*/*',
          'Connection': 'close',
        },
        // The body is parsed below: some modules send JSON as text/plain, and error statuses carry JSON too.
        responseType: 'text',
        transformResponse: [data => data],
        validateStatus: () => true,
        ...(protocol === 'https' ? {httpsAgent: this.httpsAgent} : {}),
      });
      return this.parseResponse(command, response.status, response.data);
    } catch (error) {
      if (error instanceof DeviceResponseError) {
        throw error;
      }
      const message = error instanceof AxiosError ? `${error.code ?? error.name}: ${error.message}` : String(error);
      throw new DeviceConnectionError(`Could not reach ${this.label} over ${protocol.toUpperCase()}: ${message}`, error);
    } finally {
      this.nextRequestAfter = Date.now() + this.minRequestGapMs;
    }
  }

  private parseResponse(command: string, httpStatus: number, body: unknown): ApiResponse {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (parsed === null || typeof parsed !== 'object') {
      // A rejected operator ID looks like this: firmware 025 answers `"timestamp":,` (broken JSON), firmware 010
      // answers HTTP 501 "Not supported this command".
      const body = httpStatus >= 400 ? `HTTP ${httpStatus}: ${text.slice(0, 300)}` : `a malformed body: ${text.slice(0, 300)}`;
      throw new DeviceResponseError(
        `Device ${this.label} answered ${command} with ${body}. ` +
        'The module answers like this when it rejects the operator ID (it must look like a UUID).', text);
    }
    if (httpStatus >= 400) {
      throw new DeviceResponseError(`Device ${this.label} answered ${command} with HTTP ${httpStatus}: ${text.slice(0, 300)}`, parsed);
    }
    return parsed as ApiResponse;
  }
}

function resultCode(response: ApiResponse): number {
  const raw = response.result;
  if (raw === undefined || raw === null) {
    return 0;
  }
  const code = Number(raw);
  return Number.isFinite(code) ? code : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
