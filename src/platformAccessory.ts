import {Service, PlatformAccessory, CharacteristicValue} from 'homebridge';
import {DeviceClient} from './device.js';
import {HomebridgeMHIWFRACPlatform} from './platform.js';


export class WFRACAccessory {
  private readonly deviceName: string;
  private readonly ipAddress: string;
  private port = 51443;
  private operatorId = '12345';

  private device: DeviceClient;

  private airconService: Service;
  private fanService: Service;
  private dehumidifierService: Service;

  // private currentState = {
  //   TempInside: 21.5,
  //   TempoOutside: 28.0,
  //   TargetTemp: 21.5,
  //   On: false,
  //   Mode: Auto, Cool, Heat, Fan, Dry
  //   FanSpeed: Auto, Silent, Low, Medium, High,
  //   SwingModeVertical: All, Up, MiddleUp, MiddleDown, Down,
  //   SwingModeHorizontal: All, Left, MiddleLeft, Middle, MiddleRight, Right, Inside, Outside,
  //   Fan3D: false,
  //   EmptyHouse: false,
  // };

  constructor(
    private readonly platform: HomebridgeMHIWFRACPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly ip: string,
  ) {
    this.deviceName = accessory.context.device.name;
    this.ipAddress = ip;
    this.device = new DeviceClient(this.ipAddress, this.port, this.operatorId, this.deviceName, this.platform.log);

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Mitsubishi Heavy Industries.')
      .setCharacteristic(this.platform.Characteristic.Model, 'WF-RAC Smart M-Air Series')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.deviceName);

    this.airconService = this.accessory.getService(this.platform.Service.HeaterCooler) || this.accessory.addService(this.platform.Service.HeaterCooler);
    this.fanService = this.accessory.getService(this.platform.Service.Fanv2) || this.accessory.addService(this.platform.Service.Fanv2);
    this.dehumidifierService = this.accessory.getService(this.platform.Service.HumidifierDehumidifier) || this.accessory.addService(this.platform.Service.HumidifierDehumidifier);

    this.airconService.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.getActive.bind(this))
      .onSet(this.setActive.bind(this));

    setInterval(() => {
      this.device.getDeviceStatus().then((status) => {
        this.platform.log.info(`Status: ${JSON.stringify(status)}`);
      });
    }, 10000);

    // this.airconService.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
    //   .onGet(this.getCurrentHeaterCoolerState.bind(this));
    //
    // this.airconService.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
    //   .onGet(this.getTargetHeaterCoolerState.bind(this))
    //   .onSet(this.setTargetHeaterCoolerState.bind(this));
    //
    // this.airconService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
    //   .onGet(this.getCurrentTemperature.bind(this));

  }

  getActive(): CharacteristicValue {
    // this.checkValid();
    return this.device.status.operation ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;
  }

  setActive(value: CharacteristicValue) {
    // this.checkValid();
    this.platform.log.info(`Setting power to ${value}`);
    const newStatus = this.device.status;
    newStatus.operation = value === this.platform.Characteristic.Active.ACTIVE;
    this.device.setDeviceStatus(newStatus);
  }
}

