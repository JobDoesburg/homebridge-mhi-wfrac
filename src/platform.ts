import {API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service} from 'homebridge';
import {randomUUID} from 'crypto';

import {PLATFORM_NAME, PLUGIN_NAME} from './settings.js';
import {parsePlatformConfig, WFRACPlatformConfig} from './config.js';
import {AccessoryContext, WFRACAccessory} from './platformAccessory.js';
import {DeviceClient} from './deviceClient.js';

const LEGACY_GENERATED_ID = /^homebridge-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export class HomebridgeMHIWFRACPlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly config: WFRACPlatformConfig;

  readonly accessories: PlatformAccessory<AccessoryContext>[] = [];

  constructor(
    readonly log: Logging,
    rawConfig: PlatformConfig,
    readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.config = parsePlatformConfig(rawConfig, log);

    if (!log.success) {
      log.success = log.info;
    }

    this.api.on('didFinishLaunching', () => this.configureDevices());
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory as PlatformAccessory<AccessoryContext>);
  }

  /**
   * One operator ID is shared by all devices, like one Smart M-Air app install. A configured ID is
   * mirrored as-is (no registration). Otherwise a UUID is generated once and persisted on the
   * accessories, and the plugin registers it on each device itself.
   */
  resolveOperatorId(): {operatorId: string; selfManaged: boolean} {
    if (this.config.operatorId) {
      return {operatorId: this.config.operatorId, selfManaged: false};
    }

    for (const accessory of this.accessories) {
      // Up to 2.5.x the registration was a bare flag; it always belonged to the generated ID.
      if (accessory.context.registered && accessory.context.generatedOperatorId && !accessory.context.registration) {
        accessory.context.registration = {operatorId: accessory.context.generatedOperatorId};
      }
      delete accessory.context.registered;
    }

    const registeredId = this.accessories.map(a => a.context.registration?.operatorId).find(id => !!id);
    const cachedId = registeredId ?? this.accessories.map(a => a.context.generatedOperatorId).find(id => !!id);
    if (cachedId) {
      // 2.5.x generated `homebridge-<uuid>`; WF-RAC firmware rejects IDs longer than a UUID. Keep it only
      // where it demonstrably worked, otherwise continue with the bare UUID so every device migrates alike.
      const legacy = LEGACY_GENERATED_ID.exec(cachedId);
      if (legacy && cachedId !== registeredId) {
        this.log.info(`Replacing the unregistered operator ID ${cachedId} by ${legacy[1]}`);
        return {operatorId: legacy[1], selfManaged: true};
      }
      return {operatorId: cachedId, selfManaged: true};
    }

    const generated = randomUUID();
    this.log.info(`No operatorId configured; generated ${generated} and registering it on each device`);
    return {operatorId: generated, selfManaged: true};
  }

  configureDevices() {
    if (this.config.devices.length === 0) {
      this.log.warn('No devices configured');
      return;
    }

    const {operatorId, selfManaged} = this.resolveOperatorId();
    const configuredUuids = new Set<string>();

    for (const device of this.config.devices) {
      const uuid = this.api.hap.uuid.generate(device.mac);
      configuredUuids.add(uuid);

      let accessory = this.accessories.find(a => a.UUID === uuid);
      const isNew = !accessory;
      if (accessory) {
        this.log.info('Restoring existing accessory from cache:', accessory.displayName);
      } else {
        this.log.info('Adding new accessory:', device.name);
        accessory = new this.api.platformAccessory<AccessoryContext>(device.name, uuid);
      }

      accessory.context.device = {
        ...accessory.context.device, name: device.name, mac: device.mac, ip: device.ip, deviceId: device.deviceId,
      };
      accessory.context.generatedOperatorId = selfManaged ? operatorId : undefined;
      if (!selfManaged) {
        delete accessory.context.registration;
      }

      new WFRACAccessory(this, accessory, device, operatorId, selfManaged);

      if (isNew) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      } else {
        this.api.updatePlatformAccessories([accessory]);
      }
    }

    const stale = this.accessories.filter(a => !configuredUuids.has(a.UUID));
    if (stale.length > 0) {
      void this.cleanupRemovedAccessories(stale);
    }
  }

  /** Devices that were cached but are no longer configured: free their remote slot, then remove them. */
  async cleanupRemovedAccessories(stale: PlatformAccessory<AccessoryContext>[]) {
    for (const accessory of stale) {
      this.log.info('Removing accessory no longer in config:', accessory.displayName);
      const {device, registration} = accessory.context;
      if (registration && device?.ip && device.mac) {
        const client = new DeviceClient({
          ip: device.ip,
          operatorId: registration.operatorId,
          deviceId: device.deviceId || device.mac,
          airconId: device.airconId || device.mac,
          protocol: device.protocol,
          log: this.log,
        });
        try {
          this.log.info(`Deregistering ${accessory.displayName} (operator ID ${registration.operatorId})`);
          await client.deregister();
        } catch (error) {
          this.log.warn(`Could not deregister ${accessory.displayName}: ${(error as Error).message}`);
        }
      }
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }
}
