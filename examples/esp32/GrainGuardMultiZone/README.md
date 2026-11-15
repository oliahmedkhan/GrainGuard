# GrainGuard three-zone ESP32 firmware

This sketch compiles a fixed three-zone configuration into the normal Arduino firmware. It does not mount LittleFS, read `zones.json`, or require a separate filesystem upload. The older `data/zones-*.example.json` files are not used by this sketch.

## Fixed classic ESP32 pin map

| Zone | DHT22 DATA | MQ-2 AO (ADC1) | D4184 IN/PWM | LED |
|---|---:|---:|---:|---:|
| 1 | GPIO 4 | GPIO 34 | GPIO 18 | GPIO 25 |
| 2 | GPIO 16 | GPIO 35 | GPIO 19 | GPIO 26 |
| 3 | GPIO 17 | GPIO 32 | GPIO 21 | GPIO 27 |

Each pin is unique. GPIO21 is used only as Zone 3 fan control; this build has no I2C bus, so it is not also SDA. GPIO34 and GPIO35 are input-only ADC1 pins. The selected pins are available on a typical ESP32 Dev Module, but check the exact board/module schematic before wiring.

## Local configuration and registration

The sketch uses two private local headers:

- `grainguard_secrets.h`: Wi-Fi SSID/password, HTTPS API origin, and trusted root CA certificate.
- `grainguard_config.h`: three actual registration mappings and fan-safety settings.

Both are ignored by Git. Safe templates are `grainguard_secrets.example.h` and `grainguard_config.example.h`; they contain placeholders only. Keep an existing private `grainguard_secrets.h`; do not overwrite it. If the private configuration header is absent, copy `grainguard_config.example.h` to `grainguard_config.h` and fill it locally. If either private header is absent, the sketch compiles using its example template; without real registrations telemetry is disabled.

For each zone, copy the actual values from the authorized GrainGuard registration:

- `zone_id` and `storage_unit_id` UUIDs.
- `sensor_code` (the readings API's `sensor_id` value).
- `esp32_device_id` (the API's `device_id` value).
- That sensor's one-time `device_api_key`.

Do not substitute the Supabase sensor UUID for `sensor_code`. The database stores only the device-key hash, so a lost key cannot be recovered. An authorized owner/admin can explicitly call `POST /api/v1/sensors/{sensor-record-uuid}/credentials/rotate` to issue a replacement; this immediately invalidates the old key. Do not rotate unless you intend to reprovision that sensor. Never put a Supabase service-role key on the ESP32.

The local configuration template defaults `GRAINGUARD_HARDWARE_CONFIRMED` and `GRAINGUARD_FAN_POLARITY_CONFIRMED` to `false`. Fan automation remains disabled and fan GPIOs are released (input/high-impedance) until the exact D4184 module polarity, wiring, external safe-state circuitry, and board have been verified. Set the fan active level to the measured module behavior before confirming it. The physical D4184 board and wiring were not available for inspection, so polarity is not verified here.

## Sensor and control behavior

- Three independent DHT22 instances provide Celsius temperature and RH; each zone is read on a 60-second schedule.
- MQ-2 uses 12-bit ADC1 reads with 11 dB attenuation. The payload reports the raw integer only, never gas ppm. A raw conversion in the 0–4095 range is not proof that the MQ-2 is physically connected or calibrated.
- Use a suitable voltage divider/protection circuit so the MQ-2 AO voltage stays below 3.0 V at the ESP32 ADC pin under worst-case sensor output. Do not connect a 5 V-powered MQ-2 analog output directly to an ESP32 pin. Supply the MQ-2 heater from a correctly rated source, not a GPIO.
- A DHT22 or ADC conversion failure affects that zone only. Other zones continue sampling and sending. Missing measurements are sent as JSON `null` when the rest of the payload is available; the existing API records them as partial readings.
- On a sensor fault, the affected zone holds its last fan command for up to 120 seconds, then releases/commands the fan off and latches `SENSOR_FAULT` until healthy readings and an inspection reset (`RESET_FAULT <actual-zone-uuid>` over Serial).
- Temperature control uses hysteresis: ON at or above 30°C; OFF at or below 28°C. Minimum ON/OFF intervals are 60 seconds. When hardware is confirmed, `fan_status` is the commanded output state, not measured fan rotation/current. Before confirmation, it is sent as `null` because the fan GPIO is released.
- Humidity is measured and uploaded, but humidity-only ventilation is inhibited. There is no outside-air humidity sensor in this three-zone pin map, and ventilating with more humid outside air can worsen storage conditions.
- The LED follows the commanded fan state and blinks during a zone sensor fault.

Each zone sends its own JSON request to `POST /api/v1/sensors/readings`, using `Authorization: Bearer <that sensor's device API key>`. The payload uses the registered `sensor_code` for `sensor_id`, plus `device_id`, storage/zone UUIDs, timestamp, unique message ID, temperature, humidity, raw gas ADC value, and fan status. HTTPS certificate verification is enabled with `WiFiClientSecure::setCACert`; do not replace it with an insecure TLS mode.

Network work runs separately from sensor polling. Failed transport, timeout, HTTP 408/429, and server errors are retried with bounded per-request backoff. A failed request for one zone is requeued so the other zones still get their own attempts. HTTP 401/403 errors are reported without printing credentials. Duplicate-message responses from the existing endpoint are treated as already stored.

## Libraries and compile

The inspected installation contains ESP32 Arduino Core **3.3.12** and these required Arduino libraries:

- DHT sensor library **1.4.7**
- Adafruit Unified Sensor **1.1.15**
- ArduinoJson **7.4.3**

Wi-Fi, HTTPS/HTTPClient, Preferences, and FreeRTOS APIs come from the ESP32 core. ADS1115, MCP23017, Wire, and LittleFS are not used by this direct-GPIO build.

To compile without uploading, from PowerShell:

```powershell
$buildDir = Join-Path $env:TEMP "grainguard-esp32-build"
& "C:\Users\DELL\AppData\Local\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe" compile `
  --fqbn esp32:esp32:esp32 `
  --build-path $buildDir `
  --warnings all `
  "D:\Research\GrainGuard_Kaggle_Complete\IoT App\grainguard\examples\esp32\GrainGuardMultiZone"
```

In Arduino IDE, open `GrainGuardMultiZone.ino`, select **ESP32 Dev Module** and the board's correct port (the requested COM11, if that is still the connected board), then click **Upload**. No filesystem tool or second upload is required.

Before deploying, run the host checks from the project root:

```powershell
node --test tests/multizone-config.test.mjs
```

## Verification and limitations

The backend authenticates the device key hash, checks the sensor/device/location mapping, and stores each accepted reading in `sensor_readings`; it does not accept direct ESP32 access to Supabase. Successful integration requires three existing active registrations, correct local mapping values/keys, a valid trusted CA for the API host, working Wi-Fi, and a reachable backend.

No authorized live Supabase credentials/session or registration export was available during this implementation. Therefore the actual registrations, device keys, database inserts, dashboard display, physical sensor operation, voltage-divider performance, D4184 polarity, and fan operation have not been verified. Do not treat compilation or serial/API status messages as proof of hardware or database success.
