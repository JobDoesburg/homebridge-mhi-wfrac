import { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { WFRACAccessory } from './platformAccessory.js';

export class HomebridgeMHIWFRACPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
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
      // run the method to discover / register your devices as accessories
      this.configureDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  configureDevices() {

    interface DeviceConfig {
      mac: string;
      deviceId?: string;
      ip: string;
      name: string;
      hideDehumidifier?: boolean;
    }

    const deviceConfigs: DeviceConfig[] = this.config.devices ?? [];
    if (deviceConfigs.length === 0) {
      this.log.warn('No devices configured for HomebridgeMHIWFRACPlatform');
      return;
    }

    deviceConfigs.forEach((device) => {
      const uuid = this.api.hap.uuid.generate(device.mac);

      // Check if this accessory has already been registered
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

      if (existingAccessory) {
        // Accessory exists, restore from cache
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
        existingAccessory.context.device.mac = device.mac;
        existingAccessory.context.device.deviceId = device.deviceId || device.mac;
        existingAccessory.context.device.hideDehumidifier = device.hideDehumidifier || false;
        new WFRACAccessory(this, existingAccessory, device.ip);
      } else {
        // Accessory does not exist, create a new one
        this.log.info('Adding new accessory:', device.name);
        const accessory = new this.api.platformAccessory(device.name, uuid);

        // Store device details in accessory.context
        accessory.context.device = {
          name: device.name,
          mac: device.mac,
          deviceId: device.deviceId || device.mac,
          uniqueId: uuid,
          hideDehumidifier: device.hideDehumidifier || false,
        };

        // Create the accessory handler
        new WFRACAccessory(this, accessory, device.ip);

        // Register the accessory with Homebridge
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    });
  }
}
