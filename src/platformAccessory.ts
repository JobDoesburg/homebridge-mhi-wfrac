import {CharacteristicValue, PlatformAccessory, Service} from 'homebridge';

import {DeviceClient, Protocol} from './deviceClient.js';
import {DeviceConfig} from './config.js';
import {AIRFLOW_AUTO, AirconSettings, DeviceStatus, OPERATION_MODE} from './protocol/deviceStatus.js';
import {INDOOR_TEMPERATURES} from './protocol/temperatureTables.js';
import {DeviceConnectionError, NotRegisteredError, WriteRefusedError} from './errors.js';
import {HomebridgeMHIWFRACPlatform} from './platform.js';

/** What is persisted in the Homebridge accessory cache. */
export interface AccessoryContext {
  device: {
    name: string;
    mac: string;
    ip: string;
    deviceId: string;
    /** Device-reported aircon id, learned from getDeviceInfo. */
    airconId?: string;
    /** Protocol the device answered on, so restarts skip detection. */
    protocol?: Protocol;
  };
  /** Self-register mode: the generated operator ID shared by all devices. */
  generatedOperatorId?: string;
  /** Self-register mode: the operator ID this accessory registered on its device. */
  registration?: {operatorId: string};
  /** Registration flag of versions up to 2.5.x; migrated into `registration`. */
  registered?: boolean;
}

const TARGET_TEMPERATURE_MIN = 18;
const TARGET_TEMPERATURE_MAX = 30;
/** HomeKit sends related characteristics one by one; changes this close together become one write. */
const WRITE_COALESCE_MS = 300;
/** Polls that may fail before the device is reported unreachable (the module drops off Wi-Fi about hourly). */
const UNAVAILABLE_AFTER_FAILURES = 3;
const WRITE_LOCK_MIN_WAIT_S = 2;
const WRITE_LOCK_MAX_WAIT_S = 61;
const WRITE_LOCK_FALLBACK_WAIT_S = 10;
const REGISTRATION_RETRY_WHEN_FULL_MS = 10 * 60 * 1000;

/**
 * One WF-RAC unit as a HomeKit accessory: a thermostat (auto/cool/heat), a fan (fan speed, and fan-only
 * mode when the thermostat is off) and optionally a dehumidifier (dry mode).
 */
export class WFRACAccessory {
  readonly device: DeviceClient;

  private readonly thermostat: Service;
  private readonly fan: Service;
  private readonly dehumidifier: Service | null;

  private pollTimer: NodeJS.Timeout | null = null;
  private pendingChanges: Partial<AirconSettings> = {};
  private pendingWrite: Promise<void> | null = null;

  private consecutiveFailures = 0;
  private unavailable = false;
  private lastLoggedError: string | null = null;
  private registrationBlockedUntil = 0;
  private firmwareLogged = false;
  private operatorIdChecked = false;

  constructor(
    private readonly platform: HomebridgeMHIWFRACPlatform,
    readonly accessory: PlatformAccessory<AccessoryContext>,
    private readonly config: DeviceConfig,
    readonly operatorId: string,
    readonly selfManaged: boolean,
  ) {
    const context = accessory.context;
    this.device = new DeviceClient({
      ip: config.ip,
      operatorId,
      deviceId: config.deviceId,
      airconId: context.device.airconId || config.mac,
      protocol: context.device.protocol,
      onProtocolDetected: protocol => {
        context.device.protocol = protocol;
        this.persistContext();
      },
      log: platform.log,
    });

    const {Service, Characteristic} = platform;
    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Mitsubishi Heavy Industries')
      .setCharacteristic(Characteristic.Model, 'WF-RAC Smart M-Air Series')
      .setCharacteristic(Characteristic.SerialNumber, config.mac);

    this.thermostat = accessory.getService(Service.Thermostat) || accessory.addService(Service.Thermostat);
    this.fan = accessory.getService(Service.Fanv2) || accessory.addService(Service.Fanv2);

    // Services of older versions (away mode switch, filter maintenance) and, when hidden, the dehumidifier.
    const obsolete = new Set([Service.Switch.UUID, Service.FilterMaintenance.UUID]);
    if (config.hideDehumidifier) {
      obsolete.add(Service.HumidifierDehumidifier.UUID);
    }
    for (const service of [...accessory.services]) {
      if (obsolete.has(service.UUID)) {
        accessory.removeService(service);
      }
    }
    this.dehumidifier = config.hideDehumidifier
      ? null
      : accessory.getService(Service.HumidifierDehumidifier) || accessory.addService(Service.HumidifierDehumidifier);

    this.thermostat.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => Characteristic.TemperatureDisplayUnits.CELSIUS);
    this.thermostat.getCharacteristic(Characteristic.CurrentTemperature).setProps({
      minValue: INDOOR_TEMPERATURES[0] + config.indoorTemperatureOffset,
      maxValue: INDOOR_TEMPERATURES[INDOOR_TEMPERATURES.length - 1] + config.indoorTemperatureOffset,
      minStep: 0.1,
    });
    // HAP's default target temperature (10 °C) is below our minimum; move it first so narrowing the range
    // does not log an "illegal value" warning.
    const targetTemperature = this.thermostat.getCharacteristic(Characteristic.TargetTemperature);
    if (typeof targetTemperature.value !== 'number' || targetTemperature.value < TARGET_TEMPERATURE_MIN
        || targetTemperature.value > TARGET_TEMPERATURE_MAX) {
      targetTemperature.updateValue(clampTargetTemperature(targetTemperature.value));
    }
    targetTemperature.setProps({minValue: TARGET_TEMPERATURE_MIN, maxValue: TARGET_TEMPERATURE_MAX, minStep: 0.5});
    this.fan.getCharacteristic(Characteristic.RotationSpeed).setProps({minValue: 0, maxValue: 100, minStep: 25});
    if (this.dehumidifier) {
      // Same as the target temperature: HAP's default (0) is not among the valid values below.
      this.dehumidifier.getCharacteristic(Characteristic.TargetHumidifierDehumidifierState)
        .updateValue(Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER)
        .setProps({validValues: [Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER]});
      this.dehumidifier.getCharacteristic(Characteristic.CurrentHumidifierDehumidifierState)
        .setProps({validValues: [
          Characteristic.CurrentHumidifierDehumidifierState.INACTIVE,
          Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING,
        ]});
    }

    this.thermostat.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .onSet(value => this.handleSet('heating/cooling state', () => this.setTargetHeatingCoolingState(value)));
    this.thermostat.getCharacteristic(Characteristic.TargetTemperature)
      .onSet(value => this.handleSet('target temperature', () => this.setTargetTemperature(value)));
    this.fan.getCharacteristic(Characteristic.Active)
      .onSet(value => this.handleSet('fan active', () => this.setFanActive(value)));
    this.fan.getCharacteristic(Characteristic.TargetFanState)
      .onSet(value => this.handleSet('fan state', () => this.setTargetFanState(value)));
    this.fan.getCharacteristic(Characteristic.RotationSpeed)
      .onSet(value => this.handleSet('fan speed', () => this.setRotationSpeed(value)));
    this.dehumidifier?.getCharacteristic(Characteristic.Active)
      .onSet(value => this.handleSet('dehumidifier active', () => this.setDehumidifierActive(value)));

    void this.poll();
  }

  private get name(): string {
    return this.config.name;
  }

  private persistContext() {
    this.platform.api.updatePlatformAccessories([this.accessory]);
  }

  // ---------------------------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------------------------

  private schedulePoll() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    this.pollTimer = setTimeout(() => void this.poll(), this.platform.config.pollIntervalMs);
  }

  async poll() {
    try {
      await this.ensureRegistered();
      const status = await this.device.getStatus();
      this.recordSuccess();
      this.updateCharacteristics(status);
    } catch (error) {
      this.recordFailure(error as Error);
    } finally {
      this.schedulePoll();
    }
  }

  private recordSuccess() {
    this.consecutiveFailures = 0;
    this.lastLoggedError = null;
    if (this.unavailable) {
      this.unavailable = false;
      this.platform.log.info(`${this.name} is reachable again`);
    }
  }

  private recordFailure(error: Error) {
    this.consecutiveFailures++;
    const connectionError = error instanceof DeviceConnectionError;
    if (connectionError && this.platform.config.ignoreConnectionErrors) {
      this.platform.log.debug(`${this.name}: ${error.message}`);
    } else if (error.message !== this.lastLoggedError) {
      this.platform.log.error(`${this.name}: ${error.message}`);
      this.lastLoggedError = error.message;
    }
    if (connectionError && !this.unavailable && this.consecutiveFailures >= UNAVAILABLE_AFTER_FAILURES) {
      this.unavailable = true;
      this.platform.log.warn(
        `${this.name} has not answered ${this.consecutiveFailures} polls in a row (${error.message}). ` +
        'The WF-RAC module reconnects to Wi-Fi about once an hour; polling continues quietly until it is back.');
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------------------------

  /**
   * Learns the device-reported aircon id and, in self-register mode, registers our operator ID once.
   * Returns whether commands can be sent; reading status works either way.
   */
  private async ensureRegistered(): Promise<boolean> {
    const context = this.accessory.context;
    if (!context.device.airconId) {
      const info = await this.device.getDeviceInfo();
      context.device.airconId = info.airconId;
      this.persistContext();
    }
    if (!this.selfManaged || context.registration?.operatorId === this.operatorId) {
      return true;
    }
    if (Date.now() < this.registrationBlockedUntil) {
      return false;
    }

    const timezone = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const result = await this.device.register(timezone);
    if (result === 'full') {
      this.registrationBlockedUntil = Date.now() + REGISTRATION_RETRY_WHEN_FULL_MS;
      this.platform.log.error(
        `${this.name}: cannot register, the device already has four remotes. Remove an unused one in the ` +
        'Smart M-Air app, or set operatorId to the ID of an existing remote. Status is still shown; ' +
        `registration is retried in ${REGISTRATION_RETRY_WHEN_FULL_MS / 60000} minutes.`);
      return false;
    }
    context.registration = {operatorId: this.operatorId};
    this.persistContext();
    this.platform.log.info(`${this.name}: registered operator ID ${this.operatorId}`);
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // Writing
  // ---------------------------------------------------------------------------------------------

  private async handleSet(action: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      const err = error as Error;
      if (error instanceof DeviceConnectionError && this.platform.config.ignoreConnectionErrors) {
        this.platform.log.debug(`${this.name}: could not set ${action}: ${err.message}`);
      } else {
        this.platform.log.error(`${this.name}: could not set ${action}: ${err.message}`);
      }
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /** The state HomeKit is steering towards: the last known state plus whatever is still queued. */
  private get targetState(): Partial<AirconSettings> {
    return {...this.device.status, ...this.pendingChanges};
  }

  /**
   * Queues settings and writes them shortly after, together with everything else queued meanwhile.
   * The device expects a full state per write, so one write per user action beats one per characteristic.
   */
  private queueChanges(changes: Partial<AirconSettings>): Promise<void> {
    Object.assign(this.pendingChanges, changes);
    if (!this.pendingWrite) {
      this.pendingWrite = sleep(WRITE_COALESCE_MS).then(() => {
        const batch = this.pendingChanges;
        this.pendingChanges = {};
        this.pendingWrite = null;
        return this.applyChanges(batch);
      });
    }
    return this.pendingWrite;
  }

  private async applyChanges(changes: Partial<AirconSettings>, attempt = 0): Promise<void> {
    if (!await this.ensureRegistered()) {
      throw new Error('not registered on the device (all four remote slots are taken)');
    }
    const base = this.device.status ?? await this.device.getStatus();
    this.platform.log.info(`${this.name}: setting ${describeChanges(changes)}`);
    try {
      const confirmed = await this.device.setStatus(base.with(changes));
      this.recordSuccess();
      this.updateCharacteristics(confirmed);
    } catch (error) {
      if (error instanceof WriteRefusedError && attempt === 0) {
        const waitS = await this.writeLockWait(error);
        this.platform.log.warn(
          `${this.name}: the device refused the command (result ${error.result}). Another controller, e.g. the ` +
          `Smart M-Air app, keeps exclusive write access for 60 s after its last command; retrying in ${waitS} s`);
        setTimeout(() => {
          this.applyChanges(changes, 1).catch(err => this.platform.log.error(`${this.name}: retry failed: ${(err as Error).message}`));
        }, waitS * 1000);
        return;
      }
      if (error instanceof NotRegisteredError) {
        if (this.selfManaged && attempt === 0) {
          this.platform.log.warn(`${this.name}: the device no longer knows operator ID ${this.operatorId}; registering again`);
          delete this.accessory.context.registration;
          this.persistContext();
          return this.applyChanges(changes, 1);
        }
        throw new Error(`${error.message}. ${this.describeRemotes()}`, {cause: error});
      }
      throw error;
    }
  }

  /** Seconds until the current write lock lapses; asks the device, since reads do not take the lock. */
  private async writeLockWait(error: WriteRefusedError): Promise<number> {
    let expires = error.expires;
    try {
      // Also refreshes the state the retry is based on.
      const status = await this.device.getStatus();
      this.updateCharacteristics(status);
      expires = this.device.lastStatusResponse?.expires ?? expires;
    } catch {
      // The fallback delay below covers an unreachable device.
    }
    if (typeof expires !== 'number') {
      return WRITE_LOCK_FALLBACK_WAIT_S;
    }
    const remaining = Math.ceil(expires - Date.now() / 1000) + 1;
    return Math.min(WRITE_LOCK_MAX_WAIT_S, Math.max(WRITE_LOCK_MIN_WAIT_S, remaining));
  }

  private describeRemotes(): string {
    const remotes = (this.device.lastStatusResponse?.remoteList ?? []).filter(id => !!id);
    const listed = remotes.length > 0 ? `Registered app remotes: ${remotes.join(', ')}. ` : '';
    return this.selfManaged
      ? `${listed}Restart Homebridge to register again.`
      : `${listed}Configure the operator ID of a registered remote, or leave operatorId empty to let the plugin register itself.`;
  }

  // ---------------------------------------------------------------------------------------------
  // HomeKit -> device
  // ---------------------------------------------------------------------------------------------

  private async setTargetHeatingCoolingState(value: CharacteristicValue) {
    const {TargetHeatingCoolingState} = this.platform.Characteristic;
    switch (value) {
      case TargetHeatingCoolingState.OFF:
        return this.queueChanges({operation: false});
      case TargetHeatingCoolingState.HEAT:
        return this.queueChanges({operation: true, operationMode: OPERATION_MODE.HEAT});
      case TargetHeatingCoolingState.COOL:
        return this.queueChanges({operation: true, operationMode: OPERATION_MODE.COOL});
      case TargetHeatingCoolingState.AUTO:
        return this.queueChanges({operation: true, operationMode: OPERATION_MODE.AUTO, airFlow: AIRFLOW_AUTO});
    }
  }

  private async setTargetTemperature(value: CharacteristicValue) {
    return this.queueChanges({presetTemp: value as number});
  }

  private async setFanActive(value: CharacteristicValue) {
    const target = this.targetState;
    if (value === this.platform.Characteristic.Active.ACTIVE) {
      return target.operation
        ? this.queueChanges({airFlow: AIRFLOW_AUTO})
        : this.queueChanges({operation: true, operationMode: OPERATION_MODE.FAN});
    }
    return target.operationMode === OPERATION_MODE.FAN
      ? this.queueChanges({operation: false})
      : this.queueChanges({airFlow: AIRFLOW_AUTO});
  }

  private async setTargetFanState(value: CharacteristicValue) {
    if (value === this.platform.Characteristic.TargetFanState.AUTO) {
      return this.queueChanges({airFlow: AIRFLOW_AUTO});
    }
  }

  private async setRotationSpeed(value: CharacteristicValue) {
    const speed = value as number;
    const changes: Partial<AirconSettings> = {airFlow: speed === 0 ? AIRFLOW_AUTO : Math.round(speed / 25)};
    if (!this.targetState.operation) {
      changes.operation = true;
      changes.operationMode = OPERATION_MODE.FAN;
    }
    return this.queueChanges(changes);
  }

  private async setDehumidifierActive(value: CharacteristicValue) {
    return value === this.platform.Characteristic.Active.ACTIVE
      ? this.queueChanges({operation: true, operationMode: OPERATION_MODE.DRY})
      : this.queueChanges({operationMode: OPERATION_MODE.AUTO});
  }

  // ---------------------------------------------------------------------------------------------
  // Device -> HomeKit
  // ---------------------------------------------------------------------------------------------

  updateCharacteristics(status: DeviceStatus) {
    this.logDeviceDetailsOnce();
    const {Characteristic} = this.platform;

    if (status.indoorTemp !== null) {
      this.thermostat.updateCharacteristic(Characteristic.CurrentTemperature, status.indoorTemp + this.config.indoorTemperatureOffset);
    }
    if (status.operationMode !== OPERATION_MODE.FAN) {
      this.thermostat.updateCharacteristic(Characteristic.TargetTemperature, clampTargetTemperature(status.presetTemp));
    }

    let currentHeatingCooling = Characteristic.CurrentHeatingCoolingState.OFF;
    let targetHeatingCooling = Characteristic.TargetHeatingCoolingState.OFF;
    let fanActive = Characteristic.Active.INACTIVE;
    let fanState = Characteristic.CurrentFanState.INACTIVE;
    let fanSpeed = 0;
    let targetFanState = Characteristic.TargetFanState.AUTO;
    let dehumidifierActive = Characteristic.Active.INACTIVE;
    let dehumidifierState = Characteristic.CurrentHumidifierDehumidifierState.INACTIVE;

    if (status.operation) {
      fanActive = Characteristic.Active.ACTIVE;
      fanSpeed = Math.max(0, status.airFlow) * 25;
      fanState = status.airFlow === AIRFLOW_AUTO ? Characteristic.CurrentFanState.IDLE : Characteristic.CurrentFanState.BLOWING_AIR;
      targetFanState = status.airFlow === AIRFLOW_AUTO ? Characteristic.TargetFanState.AUTO : Characteristic.TargetFanState.MANUAL;

      switch (status.operationMode) {
        case OPERATION_MODE.AUTO:
          targetHeatingCooling = Characteristic.TargetHeatingCoolingState.AUTO;
          currentHeatingCooling = status.coolHotJudge
            ? Characteristic.CurrentHeatingCoolingState.HEAT
            : Characteristic.CurrentHeatingCoolingState.COOL;
          break;
        case OPERATION_MODE.COOL:
          targetHeatingCooling = Characteristic.TargetHeatingCoolingState.COOL;
          currentHeatingCooling = Characteristic.CurrentHeatingCoolingState.COOL;
          break;
        case OPERATION_MODE.HEAT:
          targetHeatingCooling = Characteristic.TargetHeatingCoolingState.HEAT;
          currentHeatingCooling = Characteristic.CurrentHeatingCoolingState.HEAT;
          break;
        case OPERATION_MODE.FAN:
          break;
        case OPERATION_MODE.DRY:
          dehumidifierActive = Characteristic.Active.ACTIVE;
          dehumidifierState = Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING;
          // Dry mode regulates on the setpoint too; shown as auto that is currently cooling or idle.
          targetHeatingCooling = Characteristic.TargetHeatingCoolingState.AUTO;
          currentHeatingCooling = status.indoorTemp !== null && status.presetTemp < status.indoorTemp
            ? Characteristic.CurrentHeatingCoolingState.COOL
            : Characteristic.CurrentHeatingCoolingState.OFF;
          // The fan cannot be controlled in dry mode.
          fanActive = Characteristic.Active.INACTIVE;
          fanState = Characteristic.CurrentFanState.BLOWING_AIR;
          fanSpeed = 0;
          targetFanState = Characteristic.TargetFanState.AUTO;
          break;
      }
    }

    this.thermostat.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, currentHeatingCooling);
    this.thermostat.updateCharacteristic(Characteristic.TargetHeatingCoolingState, targetHeatingCooling);
    this.fan.updateCharacteristic(Characteristic.Active, fanActive);
    this.fan.updateCharacteristic(Characteristic.CurrentFanState, fanState);
    this.fan.updateCharacteristic(Characteristic.RotationSpeed, fanSpeed);
    this.fan.updateCharacteristic(Characteristic.TargetFanState, targetFanState);
    if (this.dehumidifier) {
      this.dehumidifier.updateCharacteristic(Characteristic.Active, dehumidifierActive);
      this.dehumidifier.updateCharacteristic(Characteristic.CurrentHumidifierDehumidifierState, dehumidifierState);
      this.dehumidifier.updateCharacteristic(
        Characteristic.TargetHumidifierDehumidifierState, Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER);
    }
  }

  /** Firmware and account details help a lot in bug reports, so they are logged once per start. */
  private logDeviceDetailsOnce() {
    const response = this.device.lastStatusResponse;
    const status = this.device.status;
    if (!response || !status) {
      return;
    }
    if (!this.firmwareLogged) {
      this.firmwareLogged = true;
      this.platform.log.info(
        `${this.name}: firmware ${response.firmType ?? 'unknown'} (wireless ${response.wireless?.firmVer ?? '?'}, ` +
        `mcu ${response.mcu?.firmVer ?? '?'}), model ${status.modelNoRaw}, ${response.numOfAccount ?? '?'} registered remote(s)`);
    }
    if (!this.operatorIdChecked && !this.selfManaged) {
      // The list only names remotes registered by an app, which is exactly what a mirrored ID should be.
      const remotes = (response.remoteList ?? []).filter(id => !!id);
      if (remotes.length > 0) {
        this.operatorIdChecked = true;
        if (!remotes.includes(this.operatorId)) {
          this.platform.log.warn(
            `${this.name}: the configured operatorId ${this.operatorId} is not among the remotes the device lists ` +
            `(${remotes.join(', ')}); the device will refuse commands from it`);
        }
      }
    }
  }
}

function clampTargetTemperature(value: CharacteristicValue | null | undefined): number {
  const temperature = typeof value === 'number' && Number.isFinite(value) ? value : TARGET_TEMPERATURE_MIN;
  return Math.min(TARGET_TEMPERATURE_MAX, Math.max(TARGET_TEMPERATURE_MIN, temperature));
}

function describeChanges(changes: Partial<AirconSettings>): string {
  const modes = ['auto', 'cool', 'heat', 'fan', 'dry'];
  const parts: string[] = [];
  if (changes.operation !== undefined) {
    parts.push(changes.operation ? 'power on' : 'power off');
  }
  if (changes.operationMode !== undefined) {
    parts.push(`mode ${modes[changes.operationMode] ?? changes.operationMode}`);
  }
  if (changes.presetTemp !== undefined) {
    parts.push(`target ${changes.presetTemp}°C`);
  }
  if (changes.airFlow !== undefined) {
    parts.push(`fan ${changes.airFlow === AIRFLOW_AUTO ? 'auto' : changes.airFlow}`);
  }
  return parts.join(', ') || 'nothing';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
