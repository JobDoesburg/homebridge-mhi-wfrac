# Homebridge MHI WF-RAC

[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![npm](https://img.shields.io/npm/v/homebridge-mhi-wfrac)](https://www.npmjs.com/package/homebridge-mhi-wfrac)
[![npm](https://img.shields.io/npm/dt/homebridge-mhi-wfrac)](https://www.npmjs.com/package/homebridge-mhi-wfrac)

This is a Homebridge plugin for Mitsubishi WF-RAC air conditioners controlled by the Smart M-Air app.
This plugin exposes three services to HomeKit as one device: a thermostat service for HEATing and COOLing (or AUTO), a fan (additional to the thermostat, or standalone for FAN mode), and a dehumidifier.

## Prerequisites

1. **Smart M-Air App Configuration**: First, configure the devices with the Smart M-Air app according to the normal instructions provided by Mitsubishi.
2. **Homebridge Setup**: Ensure you have Homebridge installed and set up on your system.
3. **Static IP Configuration**: Configure your router to assign static IP addresses to your air conditioners via DHCP reservation. This prevents connection issues when the device IP changes.

## Installation

1. **Install the Plugin**: Install this plugin using Homebridge Config UI X or via the command line.
   ```sh
   npm install -g homebridge-mhi-wfrac
   ```

2. **Update Homebridge Configuration**: Add the platform and configure your devices (name, MAC and IP). Leave `operatorId` out (or blank) to let the plugin register itself on each device.
   ```json
     {
         "platforms": [
            {
                "platform": "HomebridgeMHIWFRACPlatform",
                "pollInterval": 60,
                "devices": [
                   {
                       "name": "Living Room",
                       "mac": "000000000000",
                       "ip": "192.168.1.100",
                       "indoorTemperatureOffset": 0
                   }
                ]
            }
         ]
     }
   ```

   | Option | Default | Meaning |
   | --- | --- | --- |
   | `operatorId` | *(none)* | Mirror an existing Smart M-Air remote instead of self-registering, see below. |
   | `pollInterval` | `60` | Seconds between status reads (minimum 10), the same as the Home Assistant integration. The module is slow and handles one connection at a time. |
   | `ignoreConnectionErrors` | `true` | Log connection errors at debug level only. Becoming unreachable and reachable again is always logged once. |
   | `devices[].mac` | | MAC address without separators, e.g. `1234567890ab`. |
   | `devices[].ip` | | IP address; use a DHCP reservation. |
   | `devices[].deviceId` | the MAC | Client identifier sent with every request. |
   | `devices[].hideDehumidifier` | `false` | Do not expose the dehumidifier service. |
   | `devices[].indoorTemperatureOffset` | `0` | Added to the room temperature shown in HomeKit (°C), see below. |

### Operator ID

The Operator ID identifies a remote control to the air conditioner. The device allows up to four registered remotes. There are two ways to set this up:

**Self-register (recommended, no config required).** Leave `operatorId` out. The plugin generates a UUID once, registers it as a new remote on each device on first contact (`updateAccountInfo`) and keeps it across restarts. When you remove a device from the config, the plugin deregisters itself (`deleteAccountInfo`) so the remote slot is freed. Versions 2.5.x generated a longer `homebridge-…` ID that the `WF-RAC-HTTPS` firmware rejects; such an ID is replaced by a plain UUID automatically on upgrade, unless it had been accepted by your device.

**Mirror an existing remote.** If you'd rather reuse the operator ID of your Smart M-Air app (so the plugin doesn't take its own remote slot), set `operatorId` in the config to that value. In this mode the plugin will not register or deregister anything — it simply impersonates the Smart M-Air app.

To find your Smart M-Air app's Operator ID for the mirror approach, you can do a simple `curl` request to the air conditioner's IP address. The command name must be included in the URL path (`/beaver/command/<command>`).

If your device runs the legacy firmware, use HTTP:
```sh
curl http://<air-conditioner-ip>:51443/beaver/command/getAirconStat -d '{"apiVer":"1.0","command":"getAirconStat","deviceId":"<deviceName>","operatorId":"1234567890","timestamp":1722259820}'
```

If your device runs the newer WF-RAC-HTTPS firmware, use HTTPS (the `-k` flag is needed because the device uses a self-signed certificate):
```sh
curl -k https://<air-conditioner-ip>:51443/beaver/command/getAirconStat -d '{"apiVer":"1.0","command":"getAirconStat","deviceId":"<deviceName>","operatorId":"1234567890","timestamp":1722259820}'
```

If one returns `Page Not Found` or an empty reply, try the other. The plugin itself auto-detects which protocol your device uses, so you only need to identify the right one for this manual `curl` step.

This will return a JSON response with the current status of the air conditioner, including a `remoteList` array with the Operator ID(s) that are registered to the air conditioner.
Notice that for getting the device status, you also need to provide a `operatorId` in the request, but it can be any random string.
Also, the `timestamp` can be any number, but it must be a valid UNIX timestamp.
For setting the status of the air conditioner, you will need to use the Operator ID that is registered to the air conditioner and a valid recent timestamp.

## Specific Homekit behavior
- **Thermostat**: turning the thermostat off will turn off the air conditioner. Turning it to heat, cool or auto will turn on the air conditioner and switch to the corresponding mode as expected.
- **Fan**: turning the fan on while the thermostat is turned off, will turn on the air conditioner and switch to fan mode. The thermostat will be displayed as off in this case.
- **Fan speed**: Fan speed 0% means auto mode, 25% means low speed, 50% means medium speed, 75% means high and 100% means highest speed. In fan mode, however, switching to 0% will turn off the fan. So, even though the device supports it, you cannot set your air conditioner to fan mode with fan speed auto via Homekit. Notice that Homekit does know an AUTO TargetFanState (which we try to support), but it doesn't seem to be implemented as nicely in the Home app as we would like it.
- **Dehumidifier**: turning the dehumidifier on will turn on the air conditioner and switch to dehumidifier mode. The thermostat will be displayed as auto mode in this case (as you are able to set a target temperature in drying mode), and effectively cooling or heating depending on the current and target temperature. Controlling the fan is not possible in dehumidifier mode as the air conditioner does not support it.
- **Temperature**: For some reason, temperatures are not reported on .1 decimals in Homekit, even though we know a more accurate value. The target temperature should be between 18 and 30 degrees, with 0.5 degree increments.
- **Humidity**: We do not have humidity sensors in the air conditioner, so the humidity is not reported, resulting in a Homekit value of 0%.
- **Outdoor temperature**: We do not (yet) report the outdoor temperature, though we could provide a separate accessory for it.

## Room temperature

The temperature sensor sits in the unit's return-air path. While the unit is off it drifts towards the casing temperature and typically reads one to three degrees high. Set `indoorTemperatureOffset` (for example `-2`) to correct what HomeKit shows; it does not change the reading the unit itself regulates on. HomeKit's Thermostat service always shows a current temperature, so it cannot be hidden.

## Connection Reliability

The WF-RAC module is a slow embedded device that handles one connection at a time, so the plugin:
- sends at most one request per second per device, with a 20 second timeout, and polls every `pollInterval` seconds (60 by default);
- merges HomeKit changes made within a moment of each other (e.g. mode and temperature) into a single command;
- logs once when a device stops answering and once when it is back, instead of logging every failed poll. The module reconnects to Wi-Fi about once an hour and is unreachable for a short while when it does; that is normal.

If a device stays unreachable, check that the IP address is right and reserved in your router, that port 51443 is not blocked, and that the module is connected to Wi-Fi (the Smart M-Air app can reach it).

## Commands refused by the device

Every `setAirconStat` response carries a `result`. The plugin understands the ones that matter:
- **`result: 2`** — the operator ID is not registered on the device. In self-register mode the plugin registers again and retries; with a configured `operatorId` it logs which remotes the device does list. If the device already has four remotes, registration fails: remove an unused remote in the Smart M-Air app or mirror an existing one.
- **`result: 1`, `11`, `12`** — the device refused the command. Usually another controller (the Smart M-Air app on a phone) sent a command within the last 60 seconds and holds the device's exclusive write access for that long. The plugin waits until that lock lapses and retries once.

On start-up the plugin logs the firmware type and versions of each device (`WF-RAC`, `WF-RAC-HTTPS` or `WCBN4612L` plus the wireless and MCU version) and its model number; please include that line in bug reports.

## Limitations

- **Fan Direction Control**: The horizontal and vertical direction of the fan cannot be managed via Homebridge, as HomeKit does not provide a suitable service for this. There is RotationDirection and SwingMode, but they seem too limited for this purpose (though perhaps the 3D auto swing could be implemented as a SwingMode). You should configure these settings in the Smart M-Air app or via the remote control, Homebridge will not override these settings.
- **Outdoor Temperature**: The outdoor temperature is not implemented yet (we should provide a separate accessory for it).
- **Error codes**: The plugin does not provide device error codes or other status information yet (firmware version, electricity usage, etc.), though it could be implemented in the future because the air conditioner does provide this information.


## Contributing

We welcome contributions to this project. If you have an idea for a new feature or have found a bug, please open an issue or submit a pull request.

## License

This project is licensed under the Apache-2.0 License. See the [LICENSE](LICENSE) file for details.

## Acknowledgements

This plugin was developed taking inspiration from the https://github.com/edwinvdpol/com.mhi.wfrac Homey app by Edwin van de Pol. The protocol details (frame layout, result codes, the 60 second write lock) follow the [Home Assistant integration](https://github.com/jeatheak/Mitsubishi-WF-RAC-Integration) and its [module reference](https://github.com/jeatheak/Mitsubishi-WF-RAC-Integration/blob/main/docs/wf-rac-module-reference.md); the encoder is tested against its `pywfrac` library.
