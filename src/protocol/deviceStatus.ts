import {appendCrc16} from './crc16.js';
import {INDOOR_TEMPERATURES, OUTDOOR_TEMPERATURES} from './temperatureTables.js';

export const OPERATION_MODE = {
  AUTO: 0,
  COOL: 1,
  HEAT: 2,
  FAN: 3,
  DRY: 4,
} as const;
export type OperationMode = typeof OPERATION_MODE[keyof typeof OPERATION_MODE];

/** 0 = auto, 1..4 = lowest..highest. */
export const AIRFLOW_AUTO = 0;

/**
 * The settings a client can write. Every setAirconStat carries the complete state, so a change is
 * always applied on top of the last state read from the device (see {@link DeviceStatus.with}).
 */
export interface AirconSettings {
  operation: boolean;
  operationMode: OperationMode;
  airFlow: number;
  presetTemp: number;
  windDirectionUD: number;
  windDirectionLR: number;
  entrust: boolean;
  isVacantProperty: boolean;
}

const STATE_LENGTH = 18;
/** Segment count 1, one segment with code 0xFF: "nothing to request". */
const EMPTY_TRAILER = [1, 0xFF, 0xFF, 0xFF, 0xFF];
const SEGMENT_TEMPERATURE = 0x80;
const SEGMENT_ENERGY = 0x94;
const SEGMENT_OUTDOOR = 0x10;
const SEGMENT_INDOOR = 0x20;

const CMD_MODE_BITS: Record<number, number> = {0: 0x20, 1: 0x28, 2: 0x30, 3: 0x2C, 4: 0x24};
const RCV_MODE_BITS: Record<number, number> = {0: 0x00, 1: 0x08, 2: 0x10, 3: 0x0C, 4: 0x04};
const CMD_AIRFLOW_BITS: Record<number, number> = {0: 0x0F, 1: 0x08, 2: 0x09, 3: 0x0A, 4: 0x0E};
const RCV_AIRFLOW_BITS: Record<number, number> = {0: 0x07, 1: 0x00, 2: 0x01, 3: 0x02, 4: 0x06};
/** windDirectionUD -> [byte 2 bits, byte 3 bits] */
const CMD_WIND_UD_BITS: Record<number, [number, number]> = {
  0: [0xC0, 0x80], 1: [0x80, 0x80], 2: [0x80, 0x90], 3: [0x80, 0xA0], 4: [0x80, 0xB0],
};
/** windDirectionLR -> [byte 12 bits, byte 11 bits] */
const CMD_WIND_LR_BITS: Record<number, [number, number]> = {
  0: [0x03, 0x10], 1: [0x02, 0x10], 2: [0x02, 0x11], 3: [0x02, 0x12],
  4: [0x02, 0x13], 5: [0x02, 0x14], 6: [0x02, 0x15], 7: [0x02, 0x16],
};

const indexOf = (value: number, candidates: readonly number[]): number => candidates.indexOf(value);

/**
 * The decoded WF-RAC state ("airconStat"), plus the encoder that turns it back into a command.
 *
 * The blob is two blocks back to back, each with its own CRC: a COMMAND block (what the last writer
 * asked for) and a RECEIVE block (what the unit currently is). Only the receive block is parsed.
 * When writing, the command block carries the MHI set-bits for every field (a value without its
 * set-bit is ignored by the unit), and the receive block echoes the state as the official app does.
 */
export class DeviceStatus implements AirconSettings {
  operation = false;
  operationMode: OperationMode = OPERATION_MODE.AUTO;
  airFlow = AIRFLOW_AUTO;
  presetTemp = 25;
  windDirectionUD = 0;
  windDirectionLR = 0;
  entrust = false;
  isVacantProperty = false;

  /** True when the unit decided to heat in auto mode ("cool/hot judge"). */
  coolHotJudge = false;
  /** Raw model byte as reported by the unit; it is echoed verbatim in the receive block of a command. */
  modelNoRaw = 0;
  /** Protocol variant: 0, 1 or 2; -1 for models whose byte layout is unknown. */
  modelNo = 0;
  isSelfCleanOperation = false;
  isSelfCleanReset = false;
  errorCode = '00';
  indoorTemp: number | null = null;
  outdoorTemp: number | null = null;
  /** Energy of the current run in kWh, in 0.25 kWh steps. */
  electric = 0;

  static fromBase64(base64: string): DeviceStatus {
    const bytes = [...Buffer.from(base64.trim(), 'base64')];
    const commandSegments = bytes[STATE_LENGTH];
    const receiveStart = commandSegments * 4 + STATE_LENGTH + 3;
    const state = bytes.slice(receiveStart, receiveStart + STATE_LENGTH);
    if (state.length < STATE_LENGTH) {
      throw new Error(`airconStat too short (${bytes.length} bytes)`);
    }
    const segments = bytes.slice(receiveStart + STATE_LENGTH + 1, bytes.length - 2);

    const status = new DeviceStatus();
    status.operation = (state[2] & 0x03) === 0x01;
    status.operationMode = Math.max(0, indexOf(state[2] & 0x3C, [0x08, 0x10, 0x0C, 0x04]) + 1) as OperationMode;
    status.airFlow = indexOf(state[3] & 0x0F, [0x07, 0x00, 0x01, 0x02, 0x06]);
    status.windDirectionUD = (state[2] & 0xC0) === 0x40 ? 0 : indexOf(state[3] & 0xF0, [0x00, 0x10, 0x20, 0x30]) + 1;
    // Units on the legacy bus protocol pin byte 12 to 1, so they never report the LR vane or 3D auto.
    status.windDirectionLR = (state[12] & 0x03) === 0x01 ? 0 : indexOf(state[11] & 0x1F, [0, 1, 2, 3, 4, 5, 6]) + 1;
    status.presetTemp = state[4] / 2;
    status.entrust = (state[12] & 0x0C) === 0x04;
    status.coolHotJudge = (state[8] & 0x08) === 0;
    status.modelNoRaw = state[0] & 0x7F;
    // The ZT series (raw 3) shares the byte layout of model 2.
    status.modelNo = status.modelNoRaw === 3 ? 2 : indexOf(status.modelNoRaw, [0, 1, 2]);
    status.isVacantProperty = (state[10] & 0x01) !== 0;
    if (status.modelNo === 1 || status.modelNo === 2) {
      status.isSelfCleanOperation = (state[15] & 0x01) !== 0;
    }

    const code = state[6] & 0x7F;
    if (state[6] & 0x80) {
      status.errorCode = `M${String(code).padStart(2, '0')}`;
    } else {
      status.errorCode = code === 0 ? '00' : `E${code}`;
    }

    for (let i = 0; i + 3 < segments.length; i += 4) {
      const [tag, sub, value, high] = segments.slice(i, i + 4);
      if (tag === SEGMENT_TEMPERATURE && sub === SEGMENT_OUTDOOR) {
        status.outdoorTemp = OUTDOOR_TEMPERATURES[value];
      } else if (tag === SEGMENT_TEMPERATURE && sub === SEGMENT_INDOOR) {
        status.indoorTemp = INDOOR_TEMPERATURES[value];
      } else if (tag === SEGMENT_ENERGY && sub === SEGMENT_OUTDOOR) {
        status.electric = ((high << 8) | value) * 0.25;
      }
    }
    return status;
  }

  /** A copy of this status with the given settings applied; the original is left untouched. */
  with(changes: Partial<AirconSettings>): DeviceStatus {
    const next = new DeviceStatus();
    Object.assign(next, this, changes);
    return next;
  }

  toBase64(): string {
    const command = appendCrc16([...this.commandBytes(), ...EMPTY_TRAILER]);
    const receive = appendCrc16([...this.receiveBytes(), ...EMPTY_TRAILER]);
    return Buffer.from([...command, ...receive]).toString('base64');
  }

  private emptyState(): number[] {
    const state = new Array<number>(STATE_LENGTH).fill(0);
    state[5] = 0xFF; // room temperature override: 0xFF = keep using the internal sensor
    return state;
  }

  /** The command block: every value travels with its set-bit, so the unit applies the whole state. */
  commandBytes(): number[] {
    const state = this.emptyState();
    state[2] |= this.operation ? 0x03 : 0x02;
    state[2] |= CMD_MODE_BITS[this.operationMode] ?? 0;
    state[3] |= CMD_AIRFLOW_BITS[this.airFlow] ?? CMD_AIRFLOW_BITS[AIRFLOW_AUTO];
    const [ud2, ud3] = CMD_WIND_UD_BITS[this.windDirectionUD] ?? [0, 0];
    state[2] |= ud2;
    state[3] |= ud3;
    const [lr12, lr11] = CMD_WIND_LR_BITS[this.windDirectionLR] ?? [0, 0];
    state[12] |= lr12;
    state[11] |= lr11;
    state[4] |= Math.floor(this.presetTemp / 0.5) | 0x80;
    state[12] |= this.entrust ? 0x0C : 0x08;
    if (!this.coolHotJudge) {
      state[8] |= 0x08;
    }
    if (this.modelNo === 1) {
      state[10] |= this.isVacantProperty ? 0x01 : 0;
    }
    if (this.modelNo === 1 || this.modelNo === 2) {
      state[10] |= this.isSelfCleanReset ? 0x04 : 0;
      state[12] |= this.isSelfCleanOperation ? 0x90 : 0x80;
    }
    return state;
  }

  /** The receive block: the state as the unit reports it, echoed back like the official app does. */
  receiveBytes(): number[] {
    const state = this.emptyState();
    state[0] |= this.modelNoRaw & 0x7F;
    if (this.operation) {
      state[2] |= 0x01;
    }
    state[2] |= RCV_MODE_BITS[this.operationMode] ?? 0;
    state[3] |= RCV_AIRFLOW_BITS[this.airFlow] ?? RCV_AIRFLOW_BITS[AIRFLOW_AUTO];
    if (this.windDirectionUD === 0) {
      state[2] |= 0x40;
    } else if (this.windDirectionUD >= 2 && this.windDirectionUD <= 4) {
      state[3] |= (this.windDirectionUD - 1) * 0x10;
    }
    if (this.windDirectionLR === 0) {
      state[12] |= 0x01;
    } else if (this.windDirectionLR >= 1 && this.windDirectionLR <= 7) {
      state[11] |= this.windDirectionLR - 1;
    }
    state[4] |= Math.floor(this.presetTemp / 0.5);
    if (this.entrust) {
      state[12] |= 0x04;
    }
    if (!this.coolHotJudge) {
      state[8] |= 0x08;
    }
    if (this.modelNo === 1) {
      state[10] |= this.isVacantProperty ? 0x01 : 0;
    }
    if (this.modelNo === 1 || this.modelNo === 2) {
      state[12] |= this.isSelfCleanOperation ? 0x90 : 0x80;
    }
    return state;
  }
}
