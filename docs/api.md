# GrainGuard API

All IDs in the API are UUIDs from the central Supabase schema. The sensor's `sensor_id` field is its registered `sensor_code` (not the UUID primary key).

## Register a sensor

`POST /api/v1/sensors/register`

Requires a Supabase user access token:

```http
Authorization: Bearer <user_access_token>
Content-Type: application/json
```

Example request:

```json
{
  "storage_unit_id": "<storage-unit-uuid>",
  "zone_id": "<zone-uuid>",
  "sensor_code": "GG-SENSOR-001",
  "sensor_type": "DHT22_MQ2",
  "esp32_device_id": "GG-ESP32-001",
  "device_name": "North wall monitor",
  "installation_location": "Zone center"
}
```

The route verifies the Supabase user and confirms the unit and zone belong together and are owned by that user. A successful response (`201`) returns the device-specific `device_api_key` exactly once. Store it securely on that device. The response never includes the service-role key.

## Rotate an existing sensor credential

`POST /api/v1/sensors/{sensor-record-uuid}/credentials/rotate`

Requires a Supabase user access token for the storage-unit owner or an account whose protected profile role is `admin`:

```http
Authorization: Bearer <user_access_token>
```

The path uses the sensor table's UUID primary key, not `sensor_code`. The route verifies the sensor, storage-unit, and zone relationships and updates the existing credential hash; it does not create another sensor registration. The response includes the sensor's identifiers and the new `device_api_key`, returned once with `Cache-Control: no-store`. The previous key stops working immediately. Update the device's private `zones.json` with the returned key before expecting readings from that sensor to authenticate. Lost keys cannot be recovered from the database because only their SHA-256 hashes are stored. Concurrent rotations are guarded so only one request can replace a given current credential.

Do not invoke this endpoint unless you intend to rotate that sensor's key. Never send the returned key to logs, source control, or an untrusted client.

## Submit a sensor reading

`POST /api/v1/sensors/readings`

Requires the device-specific key from sensor registration:

```http
Authorization: Bearer <device_api_key>
Content-Type: application/json
```

```json
{
  "device_id": "GG-ESP32-001",
  "sensor_id": "GG-SENSOR-001",
  "storage_unit_id": "<storage-unit-uuid>",
  "zone_id": "<zone-uuid>",
  "temperature": 28.5,
  "humidity": 72.4,
  "gas_raw_value": 1250,
  "fan_status": false,
  "recorded_at": "2026-11-14T10:30:00+06:00",
  "message_id": "GG-ESP32-001-unique-message"
}
```

Temperature, humidity, gas raw value, fan state, voltage, current, and power can be omitted/null when a measurement is unavailable; at least one measurement is required. `recorded_at` must be ISO 8601 with a timezone. The database stores both the parsed timestamp and the exact submitted string, separately from server `received_at`. Environmental values are range-checked and `gas_raw_value` is an integer from 0 to 4095. This is an ADC raw value, not ppm. DHT22 values are air temperature and relative humidity, not grain moisture.

Successful ingestion returns `201` with the reading ID and both timestamps. The database updates `sensors.last_seen_at` in the same transaction as the reading insert. Duplicate `(sensor_id, message_id)` submissions return `409`; they never overwrite history.

Expected error codes include `401 DEVICE_AUTH_REQUIRED`, `401 INVALID_DEVICE_CREDENTIALS`, `403 SENSOR_LOCATION_MISMATCH`, `413 PAYLOAD_TOO_LARGE`, `422 INVALID_PAYLOAD`, `429 RATE_LIMITED`, `409 DUPLICATE_MESSAGE_ID`, and `503 SENSOR_INGESTION_NOT_CONFIGURED`.

The API records sanitized rejection reason codes for authenticated devices; it does not store raw rejected payloads or log bearer credentials.

## Report a sensor fault or recovery

`POST /api/v1/sensors/faults`

Requires the same device-specific bearer key as reading ingestion:

```http
Authorization: Bearer <device_api_key>
Content-Type: application/json
```

Fault event:

```json
{
  "event": "fault",
  "device_id": "<registered-device-id>",
  "sensor_id": "<registered-sensor-code>",
  "fault_code": "DHT22_INVALID"
}
```

The firmware may send `event: "recovered"` after valid readings return before the 120-second fault hold expires, or `event: "manual_reset"` after a latched fault is physically inspected and reset. `fault_code` is an uppercase code containing letters, digits, and underscores. The API derives `sensor_id` and `zone_id` from the device credential and registration; clients cannot choose a different zone. The server timestamps the event. Repeated fault reports while that sensor already has an open `SENSOR_FAULT` event do not create another open row.

The API writes to `sensor_fault_events`; `zone_id` and `resolution_reason` are added by the `202611140002_sensor_fault_zone_metadata.sql` migration. Owners can read the rows under the existing RLS policy, including `resolution_status`, `resolution_reason`, and `resolved_at`. The dashboard UI does not currently display them.

## Read sensor/zone connectivity

`GET /api/v1/sensors/status`

Requires a Supabase user access token:

```http
Authorization: Bearer <user_access_token>
```

The endpoint returns only sensors allowed by the user's row-level security policy. Connectivity is computed from `sensors.last_seen_at` (updated when a reading is stored); it defaults to `OFFLINE` after 180 seconds without a reading. Set `SENSOR_OFFLINE_AFTER_SECONDS` to an integer from 60 through 86400 to change the threshold. Zones with multiple registered sensors are `ONLINE`, `DEGRADED`, `OFFLINE`, or `UNMONITORED`. This is an API data interface; the existing UI is unchanged.

## Fan commands

There is no dashboard manual-control API, command table, or ESP32 command-polling endpoint. `fan_status` is only a reported output state attached to each sensor reading; it does not issue a command or confirm physical fan rotation.

## Configure a device with a user access token

For manual provisioning, sign in through the UI and obtain the user's access token through Supabase Auth. Keep the token private. Then call the registration endpoint, replacing placeholders:

```powershell
$headers = @{
  Authorization = "Bearer <user_access_token>"
  "Content-Type" = "application/json"
}
$body = @{
  storage_unit_id = "<storage-unit-uuid>"
  zone_id = "<zone-uuid>"
  sensor_code = "GG-SENSOR-001"
  sensor_type = "DHT22_MQ2"
  esp32_device_id = "GG-ESP32-001"
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/v1/sensors/register" -Headers $headers -Body $body
```

The `device_api_key` from the response is for the sensor only. Never place the service-role key in the request or device firmware.
