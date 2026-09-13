/** The device could not be reached at all (timeout, refused, reset, unreachable host). */
export class DeviceConnectionError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'DeviceConnectionError';
  }
}

/** The device answered, but with an HTTP error status, an unparsable body or a refused command. */
export class DeviceResponseError extends Error {
  constructor(message: string, readonly response?: unknown) {
    super(message);
    this.name = 'DeviceResponseError';
  }
}

/**
 * setAirconStat answered result 1, 11 or 12: the unit declined to apply the command. The usual cause
 * is the 60-second exclusive write lock another controller (e.g. the Smart M-Air app) holds after
 * its own last write.
 */
export class WriteRefusedError extends DeviceResponseError {
  constructor(message: string, readonly result: number, readonly expires: number | null) {
    super(message);
    this.name = 'WriteRefusedError';
  }
}

/** setAirconStat answered result 2: the operator ID is not in the unit's account table. */
export class NotRegisteredError extends DeviceResponseError {
  constructor(message: string) {
    super(message);
    this.name = 'NotRegisteredError';
  }
}
