import {Buffer} from 'buffer';
import {Logging} from 'homebridge';
import axios from 'axios';

export class DeviceStatus {
  static outdoorTempList = [-50.0, -50.0, -50.0, -50.0, -50.0, -48.9, -46.0, -44.0, -42.0, -41.0, -39.0, -38.0, -37.0, -36.0, -35.0, -34.0, -33.0, -32.0, -31.0, -30.0, -29.0, -28.5, -28.0, -27.0, -26.0, -25.5, -25.0, -24.0, -23.5, -23.0, -22.5, -22.0, -21.5, -21.0, -20.5, -20.0, -19.5, -19.0, -18.5, -18.0, -17.5, -17.0, -16.5, -16.0, -15.5, -15.0, -14.6, -14.3, -14.0, -13.5, -13.0, -12.6, -12.3, -12.0, -11.5, -11.0, -10.6, -10.3, -10.0, -9.6, -9.3, -9.0, -8.6, -8.3, -8.0, -7.6, -7.3, -7.0, -6.6, -6.3, -6.0, -5.6, -5.3, -5.0, -4.6, -4.3, -4.0, -3.7, -3.5, -3.2, -3.0, -2.6, -2.3, -2.0, -1.7, -1.5, -1.2, -1.0, -0.6, -0.3, 0.0, 0.2, 0.5, 0.7, 1.0, 1.3, 1.6, 2.0, 2.2, 2.5, 2.7, 3.0, 3.2, 3.5, 3.7, 4.0, 4.2, 4.5, 4.7, 5.0, 5.2, 5.5, 5.7, 6.0, 6.2, 6.5, 6.7, 7.0, 7.2, 7.5, 7.7, 8.0, 8.2, 8.5, 8.7, 9.0, 9.2, 9.5, 9.7, 10.0, 10.2, 10.5, 10.7, 11.0, 11.2, 11.5, 11.7, 12.0, 12.2, 12.5, 12.7, 13.0, 13.2, 13.5, 13.7, 14.0, 14.2, 14.4, 14.6, 14.8, 15.0, 15.2, 15.5, 15.7, 16.0, 16.2, 16.5, 16.7, 17.0, 17.2, 17.5, 17.7, 18.0, 18.2, 18.5, 18.7, 19.0, 19.2, 19.4, 19.6, 19.8, 20.0, 20.2, 20.5, 20.7, 21.0, 21.2, 21.5, 21.7, 22.0, 22.2, 22.5, 22.7, 23.0, 23.2, 23.5, 23.7, 24.0, 24.2, 24.5, 24.7, 25.0, 25.2, 25.5, 25.7, 26.0, 26.2, 26.5, 26.7, 27.0, 27.2, 27.5, 27.7, 28.0, 28.2, 28.5, 28.7, 29.0, 29.2, 29.5, 29.7, 30.0, 30.2, 30.5, 30.7, 31.0, 31.3, 31.6, 32.0, 32.2, 32.5, 32.7, 33.0, 33.2, 33.5, 33.7, 34.0, 34.3, 34.6, 35.0, 35.2, 35.5, 35.7, 36.0, 36.3, 36.6, 37.0, 37.2, 37.5, 37.7, 38.0, 38.3, 38.6, 39.0, 39.3, 39.6, 40.0, 40.3, 40.6, 41.0, 41.3, 41.6, 42.0, 42.3, 42.6, 43.0];
  static indoorTempList = [-30.0, -30.0, -30.0, -30.0, -30.0, -30.0, -30.0, -30.0, -30.0, -30.0, -30.0, -30.0, -30.0, -30.0, -30.0, -30.0, -29.0, -28.0, -27.0, -26.0, -25.0, -24.0, -23.0, -22.5, -22.0, -21.0, -20.0, -19.5, -19.0, -18.0, -17.5, -17.0, -16.5, -16.0, -15.0, -14.5, -14.0, -13.5, -13.0, -12.5, -12.0, -11.5, -11.0, -10.5, -10.0, -9.5, -9.0, -8.6, -8.3, -8.0, -7.5, -7.0, -6.5, -6.0, -5.6, -5.3, -5.0, -4.5, -4.0, -3.6, -3.3, -3.0, -2.6, -2.3, -2.0, -1.6, -1.3, -1.0, -0.5, 0.0, 0.3, 0.6, 1.0, 1.3, 1.6, 2.0, 2.3, 2.6, 3.0, 3.2, 3.5, 3.7, 4.0, 4.3, 4.6, 5.0, 5.3, 5.6, 6.0, 6.3, 6.6, 7.0, 7.2, 7.5, 7.7, 8.0, 8.3, 8.6, 9.0, 9.2, 9.5, 9.7, 10.0, 10.3, 10.6, 11.0, 11.2, 11.5, 11.7, 12.0, 12.3, 12.6, 13.0, 13.2, 13.5, 13.7, 14.0, 14.2, 14.5, 14.7, 15.0, 15.3, 15.6, 16.0, 16.2, 16.5, 16.7, 17.0, 17.2, 17.5, 17.7, 18.0, 18.2, 18.5, 18.7, 19.0, 19.2, 19.5, 19.7, 20.0, 20.2, 20.5, 20.7, 21.0, 21.2, 21.5, 21.7, 22.0, 22.2, 22.5, 22.7, 23.0, 23.2, 23.5, 23.7, 24.0, 24.2, 24.5, 24.7, 25.0, 25.2, 25.5, 25.7, 26.0, 26.2, 26.5, 26.7, 27.0, 27.2, 27.5, 27.7, 28.0, 28.2, 28.5, 28.7, 29.0, 29.2, 29.5, 29.7, 30.0, 30.2, 30.5, 30.7, 31.0, 31.3, 31.6, 32.0, 32.2, 32.5, 32.7, 33.0, 33.2, 33.5, 33.7, 34.0, 34.2, 34.5, 34.7, 35.0, 35.3, 35.6, 36.0, 36.2, 36.5, 36.7, 37.0, 37.2, 37.5, 37.7, 38.0, 38.3, 38.6, 39.0, 39.2, 39.5, 39.7, 40.0, 40.3, 40.6, 41.0, 41.2, 41.5, 41.7, 42.0, 42.3, 42.6, 43.0, 43.2, 43.5, 43.7, 44.0, 44.3, 44.6, 45.0, 45.3, 45.6, 46.0, 46.2, 46.5, 46.7, 47.0, 47.3, 47.6, 48.0, 48.3, 48.6, 49.0, 49.3, 49.6, 50.0, 50.3, 50.6, 51.0, 51.3, 51.6, 52.0];

  static AIRFLOW: {
    0: 'auto';
    1: 'lowest';
    2: 'low';
    3: 'high';
    4: 'highest';
  };

  static HORIZONTAL_POSITIONS: {
    0: 'auto';
    1: 'left-left';
    2: 'left-center';
    3: 'center-center';
    4: 'center-right';
    5: 'right-right';
    6: 'left-right';
    7: 'right-left';
  };

  static OPERATION_MODE_AUTO: 0;
  static OPERATION_MODE_COOL: 1;
  static OPERATION_MODE_HEAT: 2;
  static OPERATION_MODE_FAN: 3;
  static OPERATION_MODE_DRY: 4;

  static OPERATION_MODES: {
    AUTO: 0;
    COOL: 1;
    HEAT: 2;
    FAN: 3;
    DRY: 4;
  };

  static VERTICAL_POSITIONS: {
        0: 'auto';
        1: 'highest';
        2: 'middle';
        3: 'normal';
        4: 'lowest';
    };

  airFlow: number;
  coolHotJudge: boolean;
  electric: number;
  entrust: boolean;
  errorCode: string;
  indoorTemp: number | null;
  isAutoHeating: boolean;
  isSelfCleanOperation: boolean;
  isSelfCleanReset: boolean;
  isVacantProperty: number;
  modelNo: number;
  operation: boolean;
  operationMode: number | null;
  outdoorTemp: number | null;
  presetTemp: number | null;
  windDirectionLR: number;
  windDirectionUD: number;

  constructor() {
    this.airFlow = -1;
    this.coolHotJudge = false;
    this.electric = 0;
    this.entrust = false;
    this.errorCode = '';
    this.indoorTemp = null;
    this.isAutoHeating = false;
    this.isSelfCleanOperation = false;
    this.isSelfCleanReset = false;
    this.isVacantProperty = 0;
    this.modelNo = 0;
    this.operation = false;
    this.operationMode = null;
    this.outdoorTemp = null;
    this.presetTemp = null;
    this.windDirectionLR = -1;
    this.windDirectionUD = -1;
  }

  static fromBase64(base64: string): DeviceStatus {
    const deviceStatus = new DeviceStatus();

    const statByte = Buffer.from(base64.replace('\n', ''), 'base64').toString('binary');
    const statByteArray = [];

    for (let i = 0; i < statByte.length; i++) {
      const h = statByte.charCodeAt(i);
      if (h > 127) {
        statByteArray.push(-1 * (256-h));
      } else {
        statByteArray.push(h);
      }
    }

    const r3 = 18;
    const dataStart = statByteArray[r3] * 4 + 21;
    const dataLength = statByteArray.length - 2;
    const data = statByteArray.slice(dataStart, dataLength);
    const code = data[6] & 127;

    const zeroPad = (num:number, places:number) => String(num).padStart(places, '0');
    const wosoFindMatch = (value:number, posVals: number[], p = 0) => {
      const ret = -1;
      for (let i = 0; i < posVals.length; i++) {
        if (posVals[i] === value) {
          return i + p;
        }
      }
      return ret;
    };

    deviceStatus.operation = (3 & data[2]) === 1;
    deviceStatus.presetTemp = data[4] / 2;
    deviceStatus.operationMode = wosoFindMatch(60 & data[2], [8, 16, 12, 4], 1);
    deviceStatus.airFlow = wosoFindMatch(15 & data[3], [7, 0, 1, 2, 6]);
    deviceStatus.windDirectionUD = (data[2] & 192) === 64 ? 0 : wosoFindMatch(240 & data[3], [0, 16, 32, 48], 1);
    deviceStatus.windDirectionLR = (data[12] & 3) === 1 ? 0 : wosoFindMatch(31 & data[11], [0, 1, 2, 3, 4, 5, 6], 1);
    deviceStatus.entrust = (12 & data[12]) === 4;
    deviceStatus.coolHotJudge = (data[8] & 8) <= 0;
    deviceStatus.modelNo = wosoFindMatch(data[0] & 127, [0, 1, 2]);
    deviceStatus.isVacantProperty = data[10] & 1;

    if (code === 0) {
      deviceStatus.errorCode = '00';
    } else if ((data[6] & -128) <= 0) {
      deviceStatus.errorCode = `M${zeroPad(code, 2)}`;
    } else {
      deviceStatus.errorCode = `E${code}`;
    }

    let c = 0;
    const vals = [];

    for (let i = dataStart + 19; i < statByteArray.length - 2; i++) {
      vals[c] = statByteArray[i]; c++;
    }

    deviceStatus.electric = 0;

    for (let i = 0; i < vals.length; i += 4) {
      if ((vals[i] === -128) && (vals[i + 1] === 16)) {
        deviceStatus.outdoorTemp = this.outdoorTempList[vals[i + 2] & 0xFF];
      }

      if ((vals[i] === -128) && (vals[i + 1] === 32)) {
        deviceStatus.indoorTemp = this.indoorTempList[vals[i + 2] & 0xFF];
      }

      if ((vals[i] === -108) && (vals[i + 1] === 16)) {
        const bytes = new Uint8Array([vals[i + 2], vals[i + 3], 0, 0]);
        const uint = new Uint32Array(bytes.buffer)[0];
        deviceStatus.electric = uint * 0.25;
      }
    }
    return deviceStatus;
  }

  private static crc16ccitt(dataIn: number[]) {
    const data = [];

    for (let i = 0; i < dataIn.length; i++) {
      if (dataIn[i] > 127) {
        data[i] = (256 - dataIn[i]) * (-1);
      } else {
        data[i] = dataIn[i];
      }
    }

    let i = 65535;

    for (let i1 = 0; i1 < data.length; i1++) {
      const b = data[i1];

      for (let i2 = 0; i2 < 8; i2++) {
        let z = true;
        const z2 = ((b >> (7 - i2)) & 1) === 1;

        if (((i >> 15) & 1) !== 1) {
          z = false;
        }

        i <<= 1;

        if (z2 !== z) {
          i ^= 4129;
        }
      }
    }

    return (i & 65535);
  }


  toBase64(): string {
    let hb = this.commandToByte();
    let hhb = hb.concat([1, 255, 255, 255, 255]);

    const crc = DeviceStatus.crc16ccitt(hhb);
    const arTo1 = hhb.concat([(crc & 255), ((crc >> 8) & 255)]);

    hb = DeviceStatus.receiveToBytes(this);
    hhb = hb.concat([1, 255, 255, 255, 255]);

    const crc2 = DeviceStatus.crc16ccitt(hhb);
    const arTo2 = hhb.concat([(crc2 & 255), ((crc2 >> 8) & 255)]);

    const newAR = arTo1.concat(arTo2);

    const byteArrayToBinaryStr = (byteArray: number[]) => {
      let ret = '';
      for (let i = 0; i < byteArray.length; i++) {
        ret += String.fromCharCode(byteArray[i]);
      }
      return ret;
    };
    const binary = byteArrayToBinaryStr(newAR);

    let ret = Buffer.from(binary, 'binary').toString('base64');
    ret = ret.replace('\n', '');
    return ret;

  }


  commandToByte() {
    const statByte = [0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    if (this.operation) {
      statByte[2] |= 3;
    } else {
      statByte[2] |= 2;
    }

    // Operating mode
    if (this.operationMode === 0) {
      statByte[2] |= 32;
    } else if (this.operationMode === 1) {
      statByte[2] |= 40;
    } else if (this.operationMode === 2) {
      statByte[2] |= 48;
    } else if (this.operationMode === 3) {
      statByte[2] |= 44;
    } else if (this.operationMode === 4) {
      statByte[2] |= 36;
    }

    // Air flow
    if (this.airFlow === 0) {
      statByte[3] |= 15;
    } else if (this.airFlow === 1) {
      statByte[3] |= 8;
    } else if (this.airFlow === 2) {
      statByte[3] |= 9;
    } else if (this.airFlow === 3) {
      statByte[3] |= 10;
    } else if (this.airFlow === 4) {
      statByte[3] |= 14;
    }

    // Vertical wind direction
    if (this.windDirectionUD === 0) {
      statByte[2] |= 192;
      statByte[3] |= 128;
    } else if (this.windDirectionUD === 1) {
      statByte[2] |= 128;
      statByte[3] |= 128;
    } else if (this.windDirectionUD === 2) {
      statByte[2] |= 128;
      statByte[3] |= 144;
    } else if (this.windDirectionUD === 3) {
      statByte[2] |= 128;
      statByte[3] |= 160;
    } else if (this.windDirectionUD === 4) {
      statByte[2] |= 128;
      statByte[3] |= 176;
    }

    // Horizontal wind direction
    if (this.windDirectionLR === 0) {
      statByte[12] |= 3;
      statByte[11] |= 16;
    } else if (this.windDirectionLR === 1) {
      statByte[12] |= 2;
      statByte[11] |= 16;
    } else if (this.windDirectionLR === 2) {
      statByte[12] |= 2;
      statByte[11] |= 17;
    } else if (this.windDirectionLR === 3) {
      statByte[12] |= 2;
      statByte[11] |= 18;
    } else if (this.windDirectionLR === 4) {
      statByte[12] |= 2;
      statByte[11] |= 19;
    } else if (this.windDirectionLR === 5) {
      statByte[12] |= 2;
      statByte[11] |= 20;
    } else if (this.windDirectionLR === 6) {
      statByte[12] |= 2;
      statByte[11] |= 21;
    } else if (this.windDirectionLR === 7) {
      statByte[12] |= 2;
      statByte[11] |= 22;
    }

    // Preset temperature
    let presetTemp = 25.0;
    if (this.operationMode !== 3 && this.presetTemp !== null) {
      presetTemp = this.presetTemp;
    }

    statByte[4] |= Math.floor(presetTemp / 0.5) + 128;

    statByte[12] |= this.entrust ? 12 : 8;

    if (this.modelNo === 1) {
      statByte[10] |= this.isVacantProperty ? 1 : 0;
    }

    if (this.modelNo !== 1 && this.modelNo !== 2) {
      return statByte;
    }

    statByte[10] |= this.isSelfCleanReset ? 4 : 0;
    statByte[10] |= this.isSelfCleanOperation ? 144 : 128;

    return statByte;
  }

  static receiveToBytes(status: DeviceStatus) {
    const statByte = [0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    if (status.operation) {
      statByte[2] |= 1;
    }

    // Operating mode
    if (status.operationMode === 1) {
      statByte[2] |= 8;
    } else if (status.operationMode === 2) {
      statByte[2] |= 16;
    } else if (status.operationMode === 3) {
      statByte[2] |= 12;
    } else if (status.operationMode === 4) {
      statByte[2] |= 4;
    }

    // Air flow
    if (status.airFlow === 0) {
      statByte[3] |= 7;
    } else if (status.airFlow === 2) {
      statByte[3] |= 1;
    } else if (status.airFlow === 3) {
      statByte[3] |= 2;
    } else if (status.airFlow === 4) {
      statByte[3] |= 6;
    }

    // Vertical wind direction
    if (status.windDirectionUD === 0) {
      statByte[2] |= 64;
    } else if (status.windDirectionUD === 2) {
      statByte[3] |= 16;
    } else if (status.windDirectionUD === 3) {
      statByte[3] |= 32;
    } else if (status.windDirectionUD === 4) {
      statByte[3] |= 48;
    }

    // Horizontal wind direction
    if (status.windDirectionLR === 0) {
      statByte[12] |= 1;
    } else if (status.windDirectionLR === 1) {
      statByte[11] |= 0;
    } else if (status.windDirectionLR === 2) {
      statByte[11] |= 1;
    } else if (status.windDirectionLR === 3) {
      statByte[11] |= 2;
    } else if (status.windDirectionLR === 4) {
      statByte[11] |= 3;
    } else if (status.windDirectionLR === 5) {
      statByte[11] |= 4;
    } else if (status.windDirectionLR === 6) {
      statByte[11] |= 5;
    } else if (status.windDirectionLR === 7) {
      statByte[11] |= 6;
    }

    // Preset temperature
    let presetTemp = 25.0;
    if (status.operationMode !== 3 && status.presetTemp !== null) {
      presetTemp = status.presetTemp;
    }

    statByte[4] |= Math.floor(presetTemp / 0.5);

    if (status.entrust) {
      statByte[12] |= 4;
    }

    if (!status.coolHotJudge) {
      statByte[8] |= 8;
    }

    if (status.modelNo === 1) {
      statByte[0] |= 1;
    } else if (status.modelNo === 2) {
      statByte[0] |= 2;
    }

    if (status.modelNo === 1) {
      statByte[10] |= status.isVacantProperty ? 1 : 0;
    }

    if (status.modelNo !== 1 && status.modelNo !== 2) {
      return statByte;
    }

    statByte[15] |= status.isSelfCleanOperation ? 1 : 0;

    return statByte;
  }
}

interface DeviceStatusRequest {
  airconId: string;
  airconStat: string;
}

interface DeviceStatusResponse {
  command: string;
  apiVer: string;
  operatorId: string;
  deviceId: string;
  timestamp: number;
  result: number;
  contents: {
    airconId: string;
    airconStat: string;
    logStat: number;
    updatedBy: string;
    expires: number;
    ledStat: number;
    autoHeating: number;
    highTemp: string;
    lowTemp: string;
    firmType: string;
    wireless: {
      firmVer: string;
    };
    mcu: {
      firmVer: string;
    };
    timezone: string;
    remoteList: string[];
    numOfAccount: number;
  };
}

export class DeviceClient {
  private readonly ipAddress: string;
  private readonly port: number;

  private readonly operatorId: string;
  private readonly deviceId: string;

  private readonly log: Logging;

  public status = new DeviceStatus();

  constructor(ipAddress: string, port: number, operatorId: string, deviceId: string, log: Logging) {
    this.ipAddress = ipAddress;
    this.port = port;
    this.operatorId = operatorId;
    this.deviceId = deviceId;
    this.log = log;
  }

  async getDeviceStatus(): Promise<DeviceStatus> {
    await this.call('getAirconStat')
      .then(data => this.status = DeviceStatus.fromBase64(data.contents.airconStat));
    return this.status;
  }

  async setAirflow(airFlow: number): Promise<DeviceStatus> {
    this.log(`Setting airflow to ${airFlow}`);
    this.status.airFlow = airFlow;
    return this.setDeviceStatus(this.status);
  }

  async setOperationMode(operationMode: number): Promise<DeviceStatus> {
    this.log(`Setting operation mode to ${operationMode}`);
    this.status.operationMode = operationMode;
    return this.setDeviceStatus(this.status);
  }

  async setOperation(operation: boolean): Promise<DeviceStatus> {
    this.log(`Setting operation to ${operation}`);
    this.status.operation = operation;

    // There should be a timeout after turning on the device before setting the status, so we use a different method
    const contents = {
      airconId: this.deviceId,
      airconStat: this.status.toBase64(),
    };
    await this.call('setAirconStat', contents);
    // setTimeout(() => this.getDeviceStatus(), 3000);
    return this.status;
  }

  async setPresetTemp(presetTemp: number): Promise<DeviceStatus> {
    this.log(`Setting preset temperature to ${presetTemp}`);
    this.status.presetTemp = presetTemp;
    return this.setDeviceStatus(this.status);
  }

  async setDeviceStatus(status: DeviceStatus): Promise<DeviceStatus> {
    this.log(`Setting device status to ${JSON.stringify(status)} (${status.toBase64()})`);

    const contents = {
      airconId: this.deviceId,
      airconStat: status.toBase64(),
    };
    await this.call('setAirconStat', contents)
      .then(data => this.status = DeviceStatus.fromBase64(data.contents.airconStat));
    return this.status;
  }

  async call(command: string, contents: DeviceStatusRequest|null = null): Promise<DeviceStatusResponse> {
    let data;
    if (contents) {
      data = {
        apiVer: '1.0',
        command: command,
        deviceId: this.deviceId,
        operatorId: this.operatorId,
        timestamp: Math.floor(new Date().valueOf() / 1000),
        contents: contents,
      };
    } else {
      data = {
        apiVer: '1.0',
        command: command,
        deviceId: this.deviceId,
        operatorId: this.operatorId,
        timestamp: Math.floor(new Date().valueOf() / 1000),
      };
    }
    const body = JSON.stringify(data);

    this.log(`Method: POST, URL: http://${this.ipAddress}:${this.port}/beaver/command, Body: ${body}`);

    // We must use axios, because fetch lowercases the headers, which the device does not like
    return await axios.post(`http://${this.ipAddress}:${this.port}/beaver/command`, body)
      .then(response => {
        if (response.status !== 200) {
          throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
        } else {
          return response.data;
        }
      });
  }
}