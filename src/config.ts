import {Logging, PlatformConfig} from 'homebridge';

export interface DeviceConfig {
  name: string;
  /** MAC address without separators, also used as the serial number and default deviceId. */
  mac: string;
  ip: string;
  /** Client identifier sent with every request; defaults to the MAC. */
  deviceId: string;
  hideDehumidifier: boolean;
  /** Added to the reported indoor temperature before it is shown in HomeKit (°C). */
  indoorTemperatureOffset: number;
}

export interface WFRACPlatformConfig {
  /** Operator ID to mirror; null to self-register a generated one. */
  operatorId: string | null;
  ignoreConnectionErrors: boolean;
  pollIntervalMs: number;
  devices: DeviceConfig[];
}

export const DEFAULT_POLL_INTERVAL_S = 60;
export const MIN_POLL_INTERVAL_S = 10;
const OPERATOR_ID_PLACEHOLDER = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';

interface RawDeviceConfig {
  name?: string;
  mac?: string;
  ip?: string;
  deviceId?: string;
  hideDehumidifier?: boolean;
  indoorTemperatureOffset?: number | string;
}

export function parsePlatformConfig(config: PlatformConfig, log: Logging): WFRACPlatformConfig {
  const configuredOperatorId = typeof config.operatorId === 'string' ? config.operatorId.trim() : '';

  const pollIntervalS = Number(config.pollInterval ?? DEFAULT_POLL_INTERVAL_S);
  const pollInterval = Number.isFinite(pollIntervalS) && pollIntervalS >= MIN_POLL_INTERVAL_S
    ? pollIntervalS
    : DEFAULT_POLL_INTERVAL_S;
  if (pollInterval !== pollIntervalS) {
    log.warn(`Invalid pollInterval ${config.pollInterval}; using ${pollInterval} seconds (minimum ${MIN_POLL_INTERVAL_S})`);
  }

  const rawDevices: RawDeviceConfig[] = Array.isArray(config.devices) ? config.devices : [];
  const devices: DeviceConfig[] = [];
  for (const raw of rawDevices) {
    // Kept exactly as configured: the accessory UUID is derived from it, so normalizing it would
    // turn every existing accessory into a new one.
    const mac = (raw.mac ?? '').trim();
    if (!/^[0-9a-f]{12}$/i.test(mac) || !raw.ip) {
      log.error(`Skipping device "${raw.name ?? '?'}": a 12-character MAC address and an IP address are required`);
      continue;
    }
    const offset = Number(raw.indoorTemperatureOffset ?? 0);
    devices.push({
      name: raw.name || mac,
      mac,
      ip: raw.ip,
      deviceId: raw.deviceId?.trim() || mac,
      hideDehumidifier: raw.hideDehumidifier === true,
      indoorTemperatureOffset: Number.isFinite(offset) ? offset : 0,
    });
  }

  return {
    operatorId: configuredOperatorId && configuredOperatorId !== OPERATOR_ID_PLACEHOLDER ? configuredOperatorId : null,
    ignoreConnectionErrors: config.ignoreConnectionErrors !== false,
    pollIntervalMs: pollInterval * 1000,
    devices,
  };
}
