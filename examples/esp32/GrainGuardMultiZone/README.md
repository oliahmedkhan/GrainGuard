# GrainGuard dynamic multi-zone ESP32

This Arduino sketch reads a runtime `zones.json` file from LittleFS. The zone count is not compiled into the firmware: edit the configuration and upload it again to add or remove zones. The actual number of usable zones is bounded by the ESP32's available direct GPIOs, ADC channels, I2C expanders, memory, wiring, and sensor timing—not by a three-zone constant.

The firmware makes one authenticated reading request per registered sensor/zone. It does not merge multiple zones into one API request. `zone_id`, `storage_unit_id`, `sensor_code`, `device_id`, and each `device_api_key` must come from the real GrainGuard database and registration response. All example identity/key fields are blank.

## Files and setup

- `GrainGuardMultiZone.ino`: complete Arduino sketch.
- `data/zones-3.example.json`, `data/zones-5.example.json`, `data/zones-10.example.json`: hardware maps. Copy one to `data/zones.json`, then fill in actual IDs and device keys.
- `grainguard_secrets.example.h`: Wi-Fi, API base URL, and trusted CA template. Copy it to `grainguard_secrets.h` and fill it locally. Never commit either credentials file.

Open the `GrainGuardMultiZone` folder as the sketch in Arduino IDE. Install the libraries listed below, select the exact ESP32 board, compile and upload the sketch, then upload `data/zones.json` to the board's LittleFS partition with a compatible ESP32 LittleFS filesystem uploader. The firmware rejects blank identifiers/keys, unsupported channels, conflicting pins/channels, invalid thresholds, and unsupported expander addresses.

The examples start with `"hardware_confirmed": false`; the firmware reports readings but forces fan outputs off. Keep it false until board variant, output polarity, wiring, power, and protection have been checked. Set it true only for supervised hardware testing.

The sketch expects `GRAINGUARD_API_BASE_URL` to contain only the HTTPS origin, for example `https://your-host.example`, without a trailing slash. The endpoint paths are appended by the firmware. TLS certificate validation is enabled; do not replace it with an insecure mode.

## Per-zone behavior

- Each zone independently reads one DHT22 and one MQ-2 analog input, controls its configured fan output and LED, and uses that zone's device key and IDs.
- Temperature demand turns on at or above 30°C and clears at or below 28°C. Each zone can override those two values in its configuration.
- Humidity demand turns on at or above 70% RH and clears at or below 65% RH. The values are independently configurable per zone. Humidity ventilation is inhibited unless a configured outside-air DHT22 reports lower relative humidity than that zone's inside reading. If outside humidity is equal or higher, humidity alone cannot keep the fan running; this safety inhibit can override the minimum-on interval.
- Temperature and humidity demands are combined with OR semantics. When a demand clears, the configured minimum ON/OFF intervals prevent unnecessary switching.
- If a zone DHT22, configured MQ-2 input, or configured shared outside-air DHT22 is invalid/unavailable, that zone stops making automatic decisions and holds its last fan output for 120 seconds. It then forces the output OFF and persists a `SENSOR_FAULT` latch across reboot. A healthy sample before the timeout resolves the event and resumes automatic control. After a latch, healthy sensor readings alone do not clear it.
- After physical inspection and healthy readings, clear a latched fault over the USB serial console with `RESET_FAULT <actual-zone-uuid>`. This resets the fault latch only; it is not a fan override.
- Fault/recovery events are sent to `POST /api/v1/sensors/faults`. The API derives the zone from the authenticated registered sensor and writes `sensor_fault_events`. The existing dashboard UI is unchanged and does not display these events.
- `GET /api/v1/sensors/status` uses the last sensor reading to report each zone as `ONLINE`, `DEGRADED`, `OFFLINE`, or `UNMONITORED`. Its default offline threshold is 180 seconds and can be changed with `SENSOR_OFFLINE_AFTER_SECONDS`. This API does not add a visible dashboard indicator.
- The reading's `fan_status` reports the last commanded ESP32/MCP23017 output state. The specified hardware has no tachometer or fan-current feedback, so firmware cannot confirm that a fan physically spun.
- No remote/manual fan-command endpoint or polling mechanism exists. Manual override is not implemented; a future one must take priority over automatic control.

Fan control is local and continues independently of network requests. The firmware queues HTTP work in a separate FreeRTOS task, uses HTTPS with a trusted CA, and retries queued requests while connectivity is unavailable. A prolonged outage can consume device memory; bench-test queueing and recovery before deployment.

## Hardware compatibility report

The maps target a **classic ESP32-WROOM-style development board** as examples only. GPIO exposure and restrictions vary by module and carrier board. GPIOs 6–11 are typically connected to flash; GPIOs 34–39 are input-only; GPIOs 0, 2, 5, 12, and 15 have boot-strapping roles. The firmware only permits a conservative set of direct pins for this target, but that is not a substitute for checking the exact board schematic.

| Component | Supported connection | Important limits |
|---|---|---|
| DHT22 | One unique native ESP32 GPIO per DHT22; optional outside reference DHT22 also requires a native GPIO | Not supported through MCP23017. Its timing-sensitive single-wire protocol is not a general-purpose expander input. Each sensor needs correct 3.3V logic/pull-up and common ground. |
| MQ-2 | ESP32 ADC1 GPIO 32, 33, 34, 35, 36, or 39, or ADS1115 A0–A3 | ADC2 is avoided because it conflicts with Wi-Fi on classic ESP32. MQ-2 heater power is not supplied by GPIO. Protect every ADC input from overvoltage. |
| ADS1115 | I2C addresses `0x48`–`0x4B`, four single-ended inputs per chip; the 10-zone example uses three chips | ADS1115 inputs must remain within their supply/input limits. A 5V-powered MQ-2 analog output must not be connected directly; use a correctly designed divider/interface. The example scales ADS1115 full-scale codes to the API's 0–4095 raw field; it is not ppm calibration. |
| MCP23017 | I2C addresses `0x20`–`0x27`, 16 low-current digital channels per chip | Can drive a verified logic input or a suitably designed LED circuit, not a 12V fan. The 10-zone example uses two chips for ten fan-control inputs and ten LED outputs. Add external gate pull-downs so reset or expander disconnect defaults the MOSFET off. |
| D4184 / fan | ESP32 GPIO or MCP23017 output to the verified driver's logic input; separate appropriately rated 12V fan supply | Exact D4184 board, polarity, gate requirements, current rating, and flyback protection were not provided or tested. Follow the actual module schematic/datasheet; never power a fan from an ESP32/MCP pin. Common-ground and inductive-load protection may be required. |

### Example channel maps

All three JSON files contain empty database IDs and API keys. The GPIO/channel selections are illustrative, must match the installed hardware, and do not assert that physical hardware was tested.

**3 zones (the supplied initial direct-GPIO assignments):**

| Zone slot | DHT22 data | MQ-2 ADC1 | Fan control | LED |
|---|---:|---:|---:|---:|
| 1 | GPIO 4 | GPIO 34 | GPIO 18 | GPIO 25 |
| 2 | GPIO 16 | GPIO 35 | GPIO 19 | GPIO 26 |
| 3 | GPIO 17 | GPIO 36 | GPIO 21 | GPIO 27 |

This example adds an optional shared outside-air DHT22 on GPIO 32. That is an additional physical sensor, not part of the per-zone hardware list. Remove `outside_air` to inhibit humidity-based ventilation until outside RH is available.

**5 zones:** DHT22 data uses GPIO 4, 16, 17, 18, and 19; MQ-2 uses ADC1 GPIO 34, 35, 36, 39, and 32; fan controls use GPIO 21, 22, 23, 25, and 26; an MCP23017 at `0x20` drives the five LEDs on channels 0–4. The example's outside-air DHT22 uses GPIO 27.

**10 zones:** DHT22 data uses ten direct pins (4, 16, 17, 18, 19, 21, 22, 23, 25, and 26); three ADS1115s (`0x48`–`0x4A`) provide ten MQ-2 analog channels; two MCP23017s (`0x20`, `0x21`) provide ten fan-control and ten LED channels. The optional outside-air DHT22 uses GPIO 27. I2C is mapped to GPIO 13/14. Verify these pins against the exact board and avoid any pins used by attached peripherals.

There is no code-level three-zone cap. Expansion is still finite: classic ESP32 has a finite number of suitable direct DHT22 GPIOs; ADS1115 provides at most 16 input channels across its four standard addresses on one I2C bus; MCP23017 provides at most 128 digital channels across eight addresses. Beyond available channels, use another ESP32/gateway or a deliberately designed compatible sensor front end. Do not put DHT22 on an expander or assume unlimited analog inputs.

### Conceptual wiring

```text
Per-zone DHT22:
  ESP32 3V3 ---- DHT22 VCC
  ESP32 GPIO --- DHT22 DATA
       3V3 -- pull-up resistor -- DATA   (if the sensor board does not include one)
  ESP32 GND ---- DHT22 GND

Per-zone MQ-2:
  rated sensor supply ---- MQ-2 VCC (heater current is not from a GPIO)
  MQ-2 AO ---- voltage divider / protected interface ---- ESP32 ADC1 or ADS1115 input
  all grounds common; confirm the measured AO maximum before connecting

Per-zone fan (concept only; confirm actual D4184 module pinout and polarity):
  ESP32 GPIO or MCP23017 output ---- driver logic input
  separate 12V supply ------------- fan / MOSFET power path
  MCU, expander, driver, and supply grounds tied as required by the driver design
  external gate pull-down and suitable inductive-load protection

I2C expanders:
  ESP32 GPIO 13 (SDA) / GPIO 14 (SCL) ---- ADS1115 + MCP23017 bus
  3.3V-compatible logic, common ground, and suitable pull-ups
```

An LED connected directly to an ESP32/MCP23017 output needs a current-limiting resistor. An MCP23017 output is only a control signal; use a suitable transistor/driver for any load beyond its verified low-current limits.

## Libraries

Install through Arduino IDE Library Manager:

- Adafruit DHT sensor library
- Adafruit Unified Sensor
- ArduinoJson 7
- Adafruit ADS1X15
- Adafruit MCP23017 Arduino Library
- Adafruit BusIO (usually installed as a dependency)

The selected Espressif ESP32 Arduino core supplies Wi-Fi, HTTPS, HTTPClient, Wire, LittleFS, Preferences, and FreeRTOS. Use an Arduino IDE LittleFS filesystem uploader compatible with that core to upload `data/zones.json`.

## Validation status

The configuration examples can be JSON-validated locally. No Arduino CLI is installed in the inspected environment, and no ESP32, sensors, expanders, driver modules, fans, or confirmed board pinout were available. Therefore this firmware has **not** been compiled for a specific board or hardware-tested. Do not treat the sample pin maps or driver polarity as verified.
