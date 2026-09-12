import { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { randomUUID } from 'crypto';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { WFRACAccessory } from './platformAccessory.js';
import { DeviceClient } from './device.js';

export class HomebridgeMHIWFRACPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.info('Finished initializing platform:', 'Homebridge MHI WFRAC');

    if (!log.success) {
      log.success = log.info;
    }

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      this.configureDevices();
    });

    this.api.on('shutdown', () => {
      this.log.info('Homebridge is shutting down — leaving registrations in place.');
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  /**
   * The operator ID is shared across the whole installation, mirroring the Smart M-Air app behaviour.
   * If the user provided one in config we use that ("mirror" mode — no register/deregister).
   * Otherwise we generate one once and persist it on accessory contexts ("self-register" mode).
   */
  resolveOperatorId(): { operatorId: string; selfManaged: boolean } {
    const configured = (this.config.operatorId as string | undefined)?.trim();
    if (configured && configured !== 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx') {
      return { operatorId: configured, selfManaged: false };
    }

    const fromCache = this.accessories
      .map(a => a.context.generatedOperatorId as string | undefined)
      .find(v => !!v);
    if (fromCache) {
      return { operatorId: fromCache, selfManaged: true };
    }

    const generated = `homebridge-${randomUUID()}`;
    this.log.info(`No operatorId configured — generated a new one: ${generated}`);
    return { operatorId: generated, selfManaged: true };
  }

  configureDevices() {

    interface DeviceConfig {
      mac: string;
      deviceId?: string;
      ip: string;
      name: string;
      hideDehumidifier?: boolean;
      indoorTemperatureOffset?: number;
    }

    const deviceConfigs: DeviceConfig[] = this.config.devices ?? [];
    if (deviceConfigs.length === 0) {
      this.log.warn('No devices configured for HomebridgeMHIWFRACPlatform');
      return;
    }

    const { operatorId, selfManaged } = this.resolveOperatorId();
    const configuredUuids = new Set<string>();

    deviceConfigs.forEach((device) => {
      const uuid = this.api.hap.uuid.generate(device.mac);
      configuredUuids.add(uuid);

      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
        existingAccessory.context.device.mac = device.mac;
        existingAccessory.context.device.deviceId = device.deviceId || device.mac;
        existingAccessory.context.device.hideDehumidifier = device.hideDehumidifier || false;
        existingAccessory.context.device.indoorTemperatureOffset = device.indoorTemperatureOffset ?? 0;
        existingAccessory.context.generatedOperatorId = selfManaged ? operatorId : undefined;
        new WFRACAccessory(this, existingAccessory, device.ip, operatorId, selfManaged);
      } else {
        this.log.info('Adding new accessory:', device.name);
        const accessory = new this.api.platformAccessory(device.name, uuid);

        accessory.context.device = {
          name: device.name,
          mac: device.mac,
          deviceId: device.deviceId || device.mac,
          uniqueId: uuid,
          hideDehumidifier: device.hideDehumidifier || false,
          indoorTemperatureOffset: device.indoorTemperatureOffset ?? 0,
        };
        accessory.context.generatedOperatorId = selfManaged ? operatorId : undefined;

        new WFRACAccessory(this, accessory, device.ip, operatorId, selfManaged);

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    });

    // Devices that were previously cached but are no longer in config: deregister & remove.
    const stale = this.accessories.filter(a => !configuredUuids.has(a.UUID));
    if (stale.length > 0) {
      this.cleanupRemovedAccessories(stale);
    }
  }

  private async cleanupRemovedAccessories(stale: PlatformAccessory[]) {
    for (const accessory of stale) {
      this.log.info('Removing accessory no longer in config:', accessory.displayName);
      const operatorId = accessory.context.generatedOperatorId as string | undefined;
      const ip = accessory.context.device?.ip as string | undefined;
      const mac = accessory.context.device?.mac as string | undefined;
      const deviceId = (accessory.context.device?.deviceId as string | undefined) || mac;
      if (operatorId && accessory.context.registered && ip && mac && deviceId) {
        try {
          const client = new DeviceClient(ip, 51443, operatorId, deviceId, mac, this.log, true);
          this.log.info(`Deregistering ${accessory.displayName} (account ${operatorId})`);
          await client.deleteAccountInfo();
        } catch (error) {
          this.log.warn(`Could not deregister ${accessory.displayName}: ${(error as Error).message}`);
        }
      }
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }
}
