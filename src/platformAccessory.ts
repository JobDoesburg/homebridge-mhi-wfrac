import {Service, PlatformAccessory, CharacteristicValue} from 'homebridge';
import {DeviceClient, DeviceStatus} from './device.js';
import {HomebridgeMHIWFRACPlatform} from './platform.js';


export class WFRACAccessory {
  static REFRESH_INTERVAL = 10000;

  private readonly deviceName: string;
  private readonly deviceMac: string;
  private readonly deviceId: string;
  private readonly ipAddress: string;
  private readonly port = 51443;
  private readonly operatorId : string;

  private device: DeviceClient;

  private thermostatService: Service;
  private fanService: Service;
  private dehumidifierService: Service | null = null;
  private refreshTimeout: NodeJS.Timeout | null = null;

  private readonly selfManaged: boolean;

  constructor(
    private readonly platform: HomebridgeMHIWFRACPlatform,
    private readonly accessory: PlatformAccessory,
    ip: string,
    operatorId: string,
    selfManaged: boolean,
  ) {
    this.deviceName = accessory.context.device.name;
    this.deviceMac = accessory.context.device.mac;
    this.deviceId = accessory.context.device.deviceId || accessory.context.device.mac;
    this.ipAddress = ip;
    this.operatorId = operatorId;
    this.selfManaged = selfManaged;

    accessory.context.device.ip = ip;

    const airconId = (accessory.context.device.airconId as string | undefined) || this.deviceMac;

    this.device = new DeviceClient(
      this.ipAddress,
      this.port,
      this.operatorId,
      this.deviceId,
      airconId,
      this.platform.log,
      this.platform.config.ignoreConnectionErrors,
    );

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Mitsubishi Heavy Industries.')
      .setCharacteristic(this.platform.Characteristic.Model, 'WF-RAC Smart M-Air Series')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.deviceMac);

    this.thermostatService = this.accessory.getService(this.platform.Service.Thermostat)
      || this.accessory.addService(this.platform.Service.Thermostat);
    this.fanService = this.accessory.getService(this.platform.Service.Fanv2)
      || this.accessory.addService(this.platform.Service.Fanv2);

    // Remove leftover services from older versions (away mode, 3D auto swing, self-clean, etc.).
    // The accessory may have multiple services of the same type with different subtypes,
    // so we iterate the full service list rather than relying on getService().
    const obsoleteServiceUuids = new Set<string>([
      this.platform.Service.Switch.UUID,
      this.platform.Service.FilterMaintenance.UUID,
    ]);
    for (const service of [...this.accessory.services]) {
      if (obsoleteServiceUuids.has(service.UUID)) {
        this.accessory.removeService(service);
      }
    }

    // Conditionally create/remove dehumidifier service
    const hideDehumidifier = this.accessory.context.device.hideDehumidifier || false;
    if (hideDehumidifier) {
      // Remove dehumidifier service if it exists
      const existingDehumidifierService = this.accessory.getService(this.platform.Service.HumidifierDehumidifier);
      if (existingDehumidifierService) {
        this.accessory.removeService(existingDehumidifierService);
      }
      this.dehumidifierService = null;
    } else {
      // Create or get dehumidifier service
      this.dehumidifierService = this.accessory.getService(this.platform.Service.HumidifierDehumidifier)
        || this.accessory.addService(this.platform.Service.HumidifierDehumidifier);
    }

    this.thermostatService.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(() => this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS);
    this.thermostatService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .setProps({minValue: DeviceStatus.indoorTempList.at(0), maxValue: DeviceStatus.indoorTempList.at(-1), minStep: 0.1});
    this.thermostatService.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .setProps({minValue: 18, maxValue: 30, minStep: 0.5});

    this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed).setProps({minValue: 0, maxValue: 100, minStep: 25});

    if (this.dehumidifierService) {
      this.dehumidifierService.getCharacteristic(this.platform.Characteristic.TargetHumidifierDehumidifierState)
        .setProps({validValues: [this.platform.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER]});
      this.dehumidifierService.getCharacteristic(this.platform.Characteristic.CurrentHumidifierDehumidifierState)
        .setProps({validValues: [
          this.platform.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE,
          this.platform.Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING,
        ]});
    }

    this.thermostatService.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onSet(this.setTargetHeatingCoolingState.bind(this));
    this.thermostatService.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onSet(this.setTargetTemperature.bind(this));
    this.fanService.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setFanActive.bind(this));
    this.fanService.getCharacteristic(this.platform.Characteristic.TargetFanState)
      .onSet(this.setTargetFanState.bind(this));
    this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onSet(this.setRotationSpeed.bind(this));

    if (this.dehumidifierService) {
      this.dehumidifierService.getCharacteristic(this.platform.Characteristic.Active)
        .onSet(this.setHumidifierActive.bind(this));
    }

    // We do not implement the target humidifier state, since we only accept DEHUMIDIFIER as a valid value.

    this.refreshStatus();

  }

  private async ensureRegistered(): Promise<void> {
    if (!this.selfManaged || this.accessory.context.registered) {
      return;
    }
    try {
      // Mirror the Home Assistant flow: fetch the device-reported airconId first.
      // Some firmware (notably the HTTPS variant) returns an airconId that differs
      // from the MAC, and updateAccountInfo must be called with the device-reported
      // value or registration silently fails.
      if (!this.accessory.context.device.airconId) {
        const info = await this.device.getDeviceInfo();
        this.accessory.context.device.airconId = info.airconId;
        this.platform.log.info(`${this.deviceName}: airconId=${info.airconId}`);
      }

      const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const result = await this.device.updateAccountInfo(tz);
      if (result === 2) {
        this.platform.log.error(
          `${this.deviceName}: device has reached the 4-account limit. ` +
          'Remove an unused remote in the Smart M-Air app, then restart Homebridge.',
        );
        return;
      }
      // Match HA behaviour: treat any non-2 response as success. Some firmware
      // versions return the result code as a string, omit it on success, or
      // include extra fields. Being permissive here avoids spurious "registered=false"
      // states that block all subsequent commands.
      if (result !== 0 && result !== undefined) {
        this.platform.log.warn(`${this.deviceName}: updateAccountInfo returned result=${result} — proceeding optimistically`);
      }
      this.accessory.context.registered = true;
      this.platform.log.info(`${this.deviceName}: registered (operatorId=${this.operatorId})`);
    } catch (error) {
      if (this.platform.config.ignoreConnectionErrors && this.device.isConnectionError(error as Error)) {
        this.platform.log.debug(`${this.deviceName}: registration deferred (${(error as Error).message})`);
        return;
      }
      this.platform.log.warn(`${this.deviceName}: registration failed: ${(error as Error).message}`);
    }
  }

  private handleSetError(action: string, error: unknown) {
    const err = error as Error;
    if (this.platform.config.ignoreConnectionErrors && this.device.isConnectionError(err)) {
      this.platform.log.debug(`Ignoring connection error while ${action} for ${this.deviceName}: ${err.message}`);
      return;
    }
    this.platform.log.error(`Error ${action} for ${this.deviceName}: ${err}`);
    throw err;
  }

  private async runSetCommand(action: string, fn: () => Promise<void>) {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
      this.refreshTimeout = null;
    }
    try {
      await this.ensureRegistered();
      await fn();
      this.updateStatus();
    } catch (error) {
      this.handleSetError(action, error);
    } finally {
      this.refreshTimeout = setTimeout(() => this.refreshStatus(), WFRACAccessory.REFRESH_INTERVAL);
    }
  }

  refreshStatus() {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
    }

    // Skip status refresh if a command is in progress to avoid race conditions
    if (!this.device.isCommandInProgress) {
      this.ensureRegistered()
        .then(() => this.device.getDeviceStatus())
        .then(() => this.updateStatus())
        .catch((error) => {
          if (!this.platform.config.ignoreConnectionErrors || !this.device.isConnectionError(error)) {
            this.platform.log.error(`Error getting status for ${this.deviceName}: ${error}`);
          }
        });
    }

    this.refreshTimeout = setTimeout(() => this.refreshStatus(), WFRACAccessory.REFRESH_INTERVAL);
  }

  updateStatus() {
    if (this.device.status.indoorTemp !== null) {
      this.thermostatService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.device.status.indoorTemp);
    }
    if (this.device.status.presetTemp !== null && this.device.status.operationMode !== 3) {
      const clamped = Math.min(30, Math.max(18, this.device.status.presetTemp));
      this.thermostatService.updateCharacteristic(this.platform.Characteristic.TargetTemperature, clamped);
    }

    let currentHeatingCoolingState = this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    let targetHeatingCoolingState = this.platform.Characteristic.TargetHeatingCoolingState.OFF;

    let currentFanActive = this.platform.Characteristic.Active.INACTIVE;
    let currentFanState = this.platform.Characteristic.CurrentFanState.INACTIVE;
    let fanSpeed = 0;
    let targetFanState = this.platform.Characteristic.TargetFanState.AUTO;

    let currentDehumidifierActive = this.platform.Characteristic.Active.INACTIVE;
    let currentHumidifierDehumidifierState = this.platform.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE;
    let targetHumidifierDehumidifierState = this.platform.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER;

    if (this.device.status.operation) {
      currentFanActive = this.platform.Characteristic.Active.ACTIVE;
      fanSpeed = this.device.status.airFlow * 25;
      currentFanState = (this.device.status.airFlow === 0) ?
        this.platform.Characteristic.CurrentFanState.IDLE : this.platform.Characteristic.CurrentFanState.BLOWING_AIR;
      targetFanState = (this.device.status.airFlow === 0) ?
        this.platform.Characteristic.TargetFanState.AUTO : this.platform.Characteristic.TargetFanState.MANUAL;
      if (this.device.status.operationMode === 0 || this.device.status.operationMode === -1) {
        targetHeatingCoolingState = this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
        if (this.device.status.coolHotJudge) {
          currentHeatingCoolingState = this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
        } else {
          currentHeatingCoolingState = this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
        }
      } else if (this.device.status.operationMode === 1) {
        targetHeatingCoolingState = this.platform.Characteristic.TargetHeatingCoolingState.COOL;
        currentHeatingCoolingState = this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
      } else if (this.device.status.operationMode === 2) {
        targetHeatingCoolingState = this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
        currentHeatingCoolingState = this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
      } else if (this.device.status.operationMode === 3) {
        currentHeatingCoolingState = this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
        targetHeatingCoolingState = this.platform.Characteristic.TargetHeatingCoolingState.OFF;
      } else if (this.device.status.operationMode === 4) {
        currentDehumidifierActive = this.platform.Characteristic.Active.ACTIVE;
        currentHumidifierDehumidifierState = this.platform.Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING;
        targetHumidifierDehumidifierState = this.platform.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER;

        if (this.device.status.presetTemp! < this.device.status.indoorTemp!) {
          currentHeatingCoolingState = this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
        } else {
          currentHeatingCoolingState = this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
        }
        targetHeatingCoolingState = this.platform.Characteristic.TargetHeatingCoolingState.AUTO;

        currentFanActive = this.platform.Characteristic.Active.INACTIVE;
        currentFanState = this.platform.Characteristic.CurrentFanState.BLOWING_AIR;
        fanSpeed = 0;
        targetFanState = this.platform.Characteristic.TargetFanState.AUTO;
      }
    }

    this.thermostatService.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, currentHeatingCoolingState);
    this.thermostatService.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, targetHeatingCoolingState);

    this.fanService.updateCharacteristic(this.platform.Characteristic.Active, currentFanActive);
    this.fanService.updateCharacteristic(this.platform.Characteristic.CurrentFanState, currentFanState);
    this.fanService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, fanSpeed);
    this.fanService.updateCharacteristic(this.platform.Characteristic.TargetFanState, targetFanState);

    if (this.dehumidifierService) {
      this.dehumidifierService.updateCharacteristic(this.platform.Characteristic.Active, currentDehumidifierActive);
      this.dehumidifierService.updateCharacteristic(
        this.platform.Characteristic.CurrentHumidifierDehumidifierState, currentHumidifierDehumidifierState,
      );
      this.dehumidifierService.updateCharacteristic(
        this.platform.Characteristic.TargetHumidifierDehumidifierState, targetHumidifierDehumidifierState,
      );
    }
  }

  async setTargetHeatingCoolingState(value: CharacteristicValue) {
    return this.runSetCommand('setting heating/cooling state', async () => {
      switch (value) {
        case this.platform.Characteristic.TargetHeatingCoolingState.OFF:
          this.platform.log.info(`Turning ${this.deviceName} off`);
          await this.device.setOperation(false);
          break;
        case this.platform.Characteristic.TargetHeatingCoolingState.HEAT:
          this.platform.log.info(`Setting ${this.deviceName} to heating mode`);
          await this.device.setOperationMode(2);
          if (!this.device.status.operation) {
            this.platform.log.info(`Turning ${this.deviceName} on`);
            await this.device.setOperation(true);
          }
          break;
        case this.platform.Characteristic.TargetHeatingCoolingState.COOL:
          this.platform.log.info(`Setting ${this.deviceName} to cooling mode`);
          await this.device.setOperationMode(1);
          if (!this.device.status.operation) {
            this.platform.log.info(`Turning ${this.deviceName} on`);
            await this.device.setOperation(true);
          }
          break;
        case this.platform.Characteristic.TargetHeatingCoolingState.AUTO:
          this.platform.log.info(`Setting ${this.deviceName} to auto cooling/heating mode`);
          await this.device.setOperationMode(0);
          if (!this.device.status.operation) {
            this.platform.log.info(`Turning ${this.deviceName} on`);
            await this.device.setOperation(true);
          }
          this.platform.log.info(`Setting ${this.deviceName} fan speed to auto`);
          await this.device.setAirflow(0);
          break;
      }
    });
  }

  async setTargetTemperature(value: CharacteristicValue) {
    return this.runSetCommand('setting temperature', async () => {
      const temperature = value as number;
      this.platform.log.info(`Setting ${this.deviceName} temperature to ${temperature}°C`);
      await this.device.setPresetTemp(temperature);
    });
  }

  async setFanActive(value: CharacteristicValue) {
    return this.runSetCommand('setting fan active', async () => {
      switch (value) {
        case this.platform.Characteristic.Active.INACTIVE:
          if (this.device.status.operationMode === 3) {
            this.platform.log.info(`Turning ${this.deviceName} off after setting fan inactive`);
            await this.device.setOperation(false);
          } else {
            this.platform.log.info(`Setting ${this.deviceName} fan speed to AUTO`);
            await this.device.setAirflow(0);
          }
          break;
        case this.platform.Characteristic.Active.ACTIVE:
          if (!this.device.status.operation) {
            this.platform.log.info(`Turning ${this.deviceName} on and setting operation mode to fan mode`);
            await this.device.setOperationMode(3);
            await this.device.setOperation(true);
          } else {
            this.platform.log.info(`Setting ${this.deviceName} fan speed to AUTO`);
            await this.device.setAirflow(0);
          }
          break;
      }
    });
  }

  async setTargetFanState(value: CharacteristicValue) {
    return this.runSetCommand('setting target fan state', async () => {
      switch (value) {
        case this.platform.Characteristic.TargetFanState.AUTO:
          this.platform.log.info(`Setting ${this.deviceName} fan speed to AUTO`);
          await this.device.setAirflow(0);
          break;
        case this.platform.Characteristic.TargetFanState.MANUAL:
          break;
      }
    });
  }

  async setRotationSpeed(value: CharacteristicValue) {
    return this.runSetCommand('setting rotation speed', async () => {
      if (value === 0) {
        this.platform.log.info(`Setting fan speed for ${this.deviceName} to auto`);
        await this.device.setAirflow(0);
      } else {
        this.platform.log.info(`Setting fan speed for ${this.deviceName} to ${value}`);
        await this.device.setAirflow(Math.round(value as number / 25));
      }
      if (!this.device.status.operation) {
        this.platform.log.info(`Turning ${this.deviceName} on and setting operation mode to fan mode`);
        await this.device.setOperationMode(3);
        await this.device.setOperation(true);
      }
    });
  }

  async setHumidifierActive(value: CharacteristicValue) {
    return this.runSetCommand('setting dehumidifier active', async () => {
      switch (value) {
        case this.platform.Characteristic.Active.INACTIVE:
          this.platform.log.info(`Setting ${this.deviceName} dehumidifier inactive`);
          await this.device.setOperationMode(0);
          break;
        case this.platform.Characteristic.Active.ACTIVE:
          this.platform.log.info(`Setting ${this.deviceName} dehumidifier active`);
          await this.device.setOperationMode(4);
          if (!this.device.status.operation) {
            this.platform.log.info(`Turning ${this.deviceName} on`);
            await this.device.setOperation(true);
          }
          break;
      }
    });
  }
}

