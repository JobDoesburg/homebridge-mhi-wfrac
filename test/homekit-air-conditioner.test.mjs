import assert from 'node:assert/strict';
import test from 'node:test';

import {Accessory, Characteristic, Service, uuid} from 'hap-nodejs';

import {DeviceClient} from '../dist/device.js';
import {WFRACAccessory} from '../dist/platformAccessory.js';

const log = {
  debug() {},
  error() {},
  info() {},
  warn() {},
};

const platform = {
  Service,
  Characteristic,
  config: {ignoreConnectionErrors: false},
  log,
};

const initialStatus = {
  operation: true,
  operationMode: 1,
  airFlow: 2,
  coolHotJudge: false,
  entrust: true,
  indoorTemp: 24.5,
  presetTemp: 22,
};

const createAccessory = async (withCachedThermostat = false) => {
  const accessory = new Accessory('Test AC', uuid.generate('test-ac'));
  accessory.context = {};
  accessory.context.device = {
    name: 'Test AC',
    mac: '001122334455',
    deviceId: 'test-device',
    hideDehumidifier: false,
  };
  if (withCachedThermostat) {
    accessory.addService(Service.Thermostat).setPrimaryService();
  }

  const originalGetDeviceStatus = DeviceClient.prototype.getDeviceStatus;
  DeviceClient.prototype.getDeviceStatus = async function () {
    Object.assign(this.status, initialStatus);
    return this.status;
  };

  const controller = new WFRACAccessory(
    platform,
    accessory,
    '192.0.2.1',
    '1234567890',
    false,
  );
  await new Promise(resolve => setImmediate(resolve));
  DeviceClient.prototype.getDeviceStatus = originalGetDeviceStatus;
  clearTimeout(controller.refreshTimeout);

  return {accessory, controller};
};

test('migrates the primary HomeKit service from Thermostat to HeaterCooler', async () => {
  const {accessory, controller} = await createAccessory(true);
  const heaterCooler = accessory.getService(Service.HeaterCooler);

  assert.ok(heaterCooler);
  assert.equal(heaterCooler.isPrimaryService, true);
  assert.equal(accessory.getService(Service.Thermostat), undefined);
  assert.equal(heaterCooler.getCharacteristic(Characteristic.Active).value, Characteristic.Active.ACTIVE);
  assert.equal(
    heaterCooler.getCharacteristic(Characteristic.CurrentHeaterCoolerState).value,
    Characteristic.CurrentHeaterCoolerState.COOLING,
  );
  assert.equal(
    heaterCooler.getCharacteristic(Characteristic.TargetHeaterCoolerState).value,
    Characteristic.TargetHeaterCoolerState.COOL,
  );
  assert.equal(heaterCooler.getCharacteristic(Characteristic.CurrentTemperature).value, 24.5);
  assert.equal(heaterCooler.getCharacteristic(Characteristic.CoolingThresholdTemperature).value, 22);
  assert.equal(heaterCooler.getCharacteristic(Characteristic.HeatingThresholdTemperature).value, 22);
  assert.equal(heaterCooler.getCharacteristic(Characteristic.RotationSpeed).value, 50);
  assert.equal(heaterCooler.getCharacteristic(Characteristic.SwingMode).value, Characteristic.SwingMode.SWING_ENABLED);

  clearTimeout(controller.refreshTimeout);
});

test('maps HomeKit AC controls to the same state mutations used by Home Assistant', async () => {
  const {controller} = await createAccessory();
  const calls = [];
  const device = controller.device;

  device.setDeviceStatus = async status => {
    calls.push({
      operation: status.operation,
      operationMode: status.operationMode,
      presetTemp: status.presetTemp,
      airFlow: status.airFlow,
      entrust: status.entrust,
    });
    return status;
  };

  await Promise.all([
    controller.setHeaterCoolerActive(Characteristic.Active.INACTIVE),
    controller.setTargetHeaterCoolerState(Characteristic.TargetHeaterCoolerState.HEAT),
    controller.setTargetTemperature(23.5),
    controller.setHeaterCoolerRotationSpeed(75),
    controller.setSwingMode(Characteristic.SwingMode.SWING_DISABLED),
  ]);

  assert.deepEqual(calls, [
    {
      operation: false,
      operationMode: 2,
      presetTemp: 23.5,
      airFlow: 3,
      entrust: false,
    },
  ]);

  clearTimeout(controller.refreshTimeout);
});

test('maps auto, fan-only, dry, and off states to valid HeaterCooler states', async () => {
  const {accessory, controller} = await createAccessory();
  const heaterCooler = accessory.getService(Service.HeaterCooler);
  const dehumidifier = accessory.getService(Service.HumidifierDehumidifier);
  const status = controller.device.status;

  Object.assign(status, {operation: true, operationMode: 0, coolHotJudge: true});
  controller.updateStatus();
  assert.equal(
    heaterCooler.getCharacteristic(Characteristic.CurrentHeaterCoolerState).value,
    Characteristic.CurrentHeaterCoolerState.HEATING,
  );
  assert.equal(
    heaterCooler.getCharacteristic(Characteristic.TargetHeaterCoolerState).value,
    Characteristic.TargetHeaterCoolerState.AUTO,
  );

  Object.assign(status, {operationMode: 3});
  controller.updateStatus();
  assert.equal(
    heaterCooler.getCharacteristic(Characteristic.CurrentHeaterCoolerState).value,
    Characteristic.CurrentHeaterCoolerState.IDLE,
  );

  Object.assign(status, {operationMode: 4});
  controller.updateStatus();
  assert.equal(
    heaterCooler.getCharacteristic(Characteristic.CurrentHeaterCoolerState).value,
    Characteristic.CurrentHeaterCoolerState.IDLE,
  );
  assert.equal(
    dehumidifier.getCharacteristic(Characteristic.Active).value,
    Characteristic.Active.ACTIVE,
  );

  Object.assign(status, {operation: false});
  controller.updateStatus();
  assert.equal(heaterCooler.getCharacteristic(Characteristic.Active).value, Characteristic.Active.INACTIVE);
  assert.equal(
    heaterCooler.getCharacteristic(Characteristic.CurrentHeaterCoolerState).value,
    Characteristic.CurrentHeaterCoolerState.INACTIVE,
  );

  clearTimeout(controller.refreshTimeout);
});
