# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Homebridge plugin for Mitsubishi WF-RAC air conditioners controlled by the Smart M-Air app. The plugin exposes three HomeKit services: thermostat (for heating/cooling/auto), fan (for FAN mode), and dehumidifier.

## Development Commands

### Build and Development
- `npm run build` - Compiles TypeScript to JavaScript in the `dist/` directory
- `npm run watch` - Builds and links for development, then watches for changes using nodemon
- `npm run lint` - Runs ESLint with zero warnings tolerance
- `npm run prepublishOnly` - Runs lint and build (executed before publishing)

### Testing
- `npm test` - Lints, builds and runs `node --test test/*.test.mjs`. The tests import the compiled `dist/`.
- `test/vectors.json` holds encode/decode vectors generated with `pywfrac` (the Home Assistant integration's protocol library); `test/fakeDevice.mjs` emulates a module at the `axios.post` level for client and accessory tests.

## Code Architecture

### Core Components

**Entry Point (`src/index.ts`)** registers the platform with Homebridge.

**Config (`src/config.ts`)** parses and validates the platform config into `WFRACPlatformConfig` / `DeviceConfig` (operator ID, poll interval, per-device temperature offset, …).

**Platform (`src/platform.ts`)** - `HomebridgeMHIWFRACPlatform`
- Resolves the operator ID: configured → mirror mode; otherwise a generated UUID persisted on the accessory contexts (self-register mode), migrating the `homebridge-<uuid>` IDs of 2.5.x.
- Creates/restores one `WFRACAccessory` per device (UUID from the MAC exactly as configured) and deregisters removed devices.

**Protocol (`src/protocol/`)**
- `deviceStatus.ts` - `DeviceStatus` decodes the `airconStat` blob and encodes a full state back into the two-block command (command block with MHI set-bits + echoed receive block). `AirconSettings` is the writable subset; `status.with(changes)` builds the next state.
- `crc16.ts`, `temperatureTables.ts`.

**Device Client (`src/deviceClient.ts`)** - `DeviceClient`: HTTP(S) to port 51443, protocol detection (HTTPS first, remembered in the accessory cache, re-detected after connection failures), request serialization with a 1 s gap, typed errors from `src/errors.ts` (`DeviceConnectionError`, `DeviceResponseError`, `WriteRefusedError` for result 1/11/12, `NotRegisteredError` for result 2).

**Accessory (`src/platformAccessory.ts`)** - `WFRACAccessory`
- Thermostat, Fanv2 and optional HumidifierDehumidifier services.
- Polls every `pollInterval` seconds; reports unreachable/reachable transitions once.
- Coalesces HomeKit writes (300 ms) into one `setAirconStat` on top of the last read state; waits for the device's 60 s write lock and retries once; re-registers on result 2 in self-register mode.

### Configuration

**Plugin Configuration (`config.schema.json`)**
- Defines JSON schema for Homebridge Config UI X
- `operatorId` is optional (blank = self-register), `pollInterval`, `ignoreConnectionErrors`
- Device array with name, MAC address (12 hex characters, regex-validated), IP, optional `deviceId`, `hideDehumidifier`, `indoorTemperatureOffset`


## Key Technical Details

### Device Protocol
- Uses base64-encoded binary protocol for device communication
- Temperature values use lookup tables for conversion
- Operation modes: 0=auto, 1=cool, 2=heat, 3=fan, 4=dry
- Airflow levels: 0=auto, 1=lowest, 2=low, 3=high, 4=highest

- Model byte (`state[0] & 0x7F`) selects the byte layout: models 1/2 (and 3 = ZT) carry self-clean flags in byte 12 of both blocks; the raw model byte is echoed in the receive block
- `setAirconStat` result 2 = operator ID not registered; 1/11/12 = refused (another client's 60 s write lock keyed on `deviceId`, or the indoor unit declined)

### HomeKit Integration
- Temperature range: 18-30°C with 0.5°C increments
- Fan speed mapping: 0%=auto, 25%=low, 50%=medium, 75%=high, 100%=highest
- Dehumidifier mode maps to device dry mode with auto temperature control

## TypeScript Configuration

- Target: ES2022 with ES module output
- Strict mode enabled with comprehensive type checking
- Source maps enabled for debugging
- Output directory: `dist/`

## Development Notes

- This is a platform plugin (not accessory plugin)
- Uses Homebridge dynamic platform architecture
- Requires network connectivity to WF-RAC devices; there is no hardware in CI, so protocol changes must be checked against the pywfrac vectors
- Device discovery is manual via configuration (no auto-discovery)
- Operator ID: generated and self-registered by default; a Smart M-Air app ID can be mirrored instead