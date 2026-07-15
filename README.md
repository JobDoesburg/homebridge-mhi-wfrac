# Homebridge MHI WF-RAC

[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![npm](https://img.shields.io/npm/v/homebridge-mhi-wfrac)](https://www.npmjs.com/package/homebridge-mhi-wfrac)
[![npm](https://img.shields.io/npm/dt/homebridge-mhi-wfrac)](https://www.npmjs.com/package/homebridge-mhi-wfrac)

This is a Homebridge plugin for Mitsubishi WF-RAC air conditioners controlled by the Smart M-Air app.
This plugin exposes three services to HomeKit as one device: an air conditioner for heating, cooling, and auto mode, a fan for fan-only mode, and a dehumidifier for dry mode.

## Prerequisites

1. **Smart M-Air App Configuration**: First, configure the devices with the Smart M-Air app according to the normal instructions provided by Mitsubishi.
2. **Homebridge Setup**: Ensure you have Homebridge installed and set up on your system.
3. **Static IP Configuration**: Configure your router to assign static IP addresses to your air conditioners via DHCP reservation. This prevents connection issues when the device IP changes.

## Installation

1. **Install the Plugin**: Install this plugin using Homebridge Config UI X or via the command line.
   ```sh
   npm install -g homebridge-mhi-wfrac
   ```

2. **Update Homebridge Configuration**: Update your Homebridge `config.json` file with the platform configuration, setting the Operator ID that corresponds to your Smart M-Air app, and configuring all the devices you want to configure (name, mac and ip).
   ```json
     {
         "platforms": [
            {
                "platform": "HomebridgeMHIWFRACPlatform",
                "operatorId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
                "devices": [
                   {
                       "name": "Living Room",
                       "mac": "00:00:00:00:00:00",
                       "ip": ""
                   }
                ]
            }
         ]
     }
   ```      

### Operator ID

The Operator ID identifies a remote control to the air conditioner. The device allows up to four registered remotes. There are two ways to set this up:

**Self-register (recommended, no config required).** Leave the `operatorId` field blank. The plugin will generate its own ID, register itself as a new remote on each device on first contact (via `updateAccountInfo`), and persist the ID across restarts. When you remove a device from the plugin's config, the plugin deregisters itself (via `deleteAccountInfo`) so the device's remote slot is freed.

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
- **Air conditioner**: the primary HomeKit service is a Heater/Cooler, so the Home app displays the device as an AC unit. Its power, auto/heat/cool mode, target temperature, fan speed, and 3D auto swing controls map directly to the corresponding WF-RAC state fields.
- **Fan**: turning on the separate fan service while the air conditioner is off turns on the unit in fan-only mode. HomeKit does not include fan-only in its Heater/Cooler target-mode characteristic, so this remains a separate service.
- **Fan speed**: Fan speed 0% means auto mode, 25% means low speed, 50% means medium speed, 75% means high and 100% means highest speed. In fan mode, however, switching to 0% will turn off the fan. So, even though the device supports it, you cannot set your air conditioner to fan mode with fan speed auto via Homekit. Notice that Homekit does know an AUTO TargetFanState (which we try to support), but it doesn't seem to be implemented as nicely in the Home app as we would like it.
- **Dehumidifier**: turning the dehumidifier on turns on the air conditioner in dry mode. HomeKit does not include dry mode in its Heater/Cooler target-mode characteristic, so this remains a separate service. Controlling the fan is not possible in dry mode because the air conditioner does not support it.
- **Temperature**: For some reason, temperatures are not reported on .1 decimals in Homekit, even though we know a more accurate value. The target temperature should be between 18 and 30 degrees, with 0.5 degree increments.
- **Humidity**: We do not have humidity sensors in the air conditioner, so the humidity is not reported, resulting in a Homekit value of 0%.
- **Outdoor temperature**: We do not (yet) report the outdoor temperature, though we could provide a separate accessory for it.

## Connection Reliability

The plugin includes automatic retry logic with exponential backoff to handle transient network issues:
- **Automatic retries**: Up to 3 attempts for failed requests (1s → 2s → 4s delays)
- **Supported errors**: Connection timeouts, socket hang ups, connection refused, and other network errors
- **Status polling**: Automatically skips during active commands to prevent conflicts
- **Consolidated writes**: HomeKit changes received within 500 ms are merged into the last read state and sent as one `setAirconStat` packet, matching the Home Assistant integration's write flow

If you experience persistent connection errors (ECONNREFUSED, socket hang up, etc.), check the following:
- Verify the air conditioner IP address is correct and reachable
- Ensure you configured static IP addresses via DHCP reservation in your router
- Check that port 51443 is not blocked by a firewall
- Verify the device is powered on and connected to WiFi
- Try restarting the air conditioner's WiFi module

## Limitations

- **Fan Direction Control**: HomeKit's Swing Mode control maps to the WF-RAC 3D auto (`Entrust`) setting. Individual horizontal and vertical vane positions are not exposed because HomeKit has no equivalent controls; configure those positions in Smart M-Air or with the remote.
- **Outdoor Temperature**: The outdoor temperature is not implemented yet (we should provide a separate accessory for it).
- **Error codes**: The plugin does not provide device error codes or other status information yet (firmware version, electricity usage, etc.), though it could be implemented in the future because the air conditioner does provide this information.


## Contributing

We welcome contributions to this project. If you have an idea for a new feature or have found a bug, please open an issue or submit a pull request.

## License

This project is licensed under the Apache-2.0 License. See the [LICENSE](LICENSE) file for details.

## Acknowledgements

This plugin was developed taking inspiration from the https://github.com/edwinvdpol/com.mhi.wfrac Homey app by Edwin van de Pol.
