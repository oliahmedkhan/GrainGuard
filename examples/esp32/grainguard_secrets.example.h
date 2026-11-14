#pragma once

#define GRAINGUARD_WIFI_SSID "replace-with-wifi-name"
#define GRAINGUARD_WIFI_PASSWORD "replace-with-wifi-password"
#define GRAINGUARD_API_URL "https://your-host.example/api/v1/sensors/readings"
#define GRAINGUARD_DEVICE_API_KEY "replace-with-one-time-device-key"
#define GRAINGUARD_DEVICE_ID "GG-ESP32-001"
#define GRAINGUARD_SENSOR_CODE "GG-SENSOR-001"
#define GRAINGUARD_STORAGE_UNIT_ID "replace-with-storage-unit-uuid"
#define GRAINGUARD_ZONE_ID "replace-with-zone-uuid"

#define ROOT_CA_CERT R"PEM(
-----BEGIN CERTIFICATE-----
REPLACE_WITH_THE_TRUSTED_CA_CERTIFICATE_FOR_YOUR_API_HOST
-----END CERTIFICATE-----
)PEM"
