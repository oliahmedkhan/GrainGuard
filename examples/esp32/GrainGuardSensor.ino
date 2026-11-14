#include <ArduinoJson.h>
#include <DHT.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <time.h>

#include "grainguard_secrets.h"

#ifndef DHT_PIN
#define DHT_PIN 4
#endif

#ifndef MQ2_PIN
#define MQ2_PIN 34
#endif

#ifndef SENSOR_INTERVAL_MS
#define SENSOR_INTERVAL_MS 60000UL
#endif

#ifndef ROOT_CA_CERT
#error "Define ROOT_CA_CERT in grainguard_secrets.h with the trusted TLS CA certificate."
#endif

#ifndef GRAINGUARD_API_URL
#error "Define GRAINGUARD_API_URL in grainguard_secrets.h."
#endif

#ifndef GRAINGUARD_DEVICE_API_KEY
#error "Define GRAINGUARD_DEVICE_API_KEY in grainguard_secrets.h."
#endif

#ifndef GRAINGUARD_DEVICE_ID
#error "Define GRAINGUARD_DEVICE_ID in grainguard_secrets.h."
#endif

#ifndef GRAINGUARD_SENSOR_CODE
#error "Define GRAINGUARD_SENSOR_CODE in grainguard_secrets.h."
#endif

#ifndef GRAINGUARD_STORAGE_UNIT_ID
#error "Define GRAINGUARD_STORAGE_UNIT_ID in grainguard_secrets.h."
#endif

#ifndef GRAINGUARD_ZONE_ID
#error "Define GRAINGUARD_ZONE_ID in grainguard_secrets.h."
#endif

DHT dht(DHT_PIN, DHT22);
uint32_t messageCounter = 0;
uint32_t lastSentAt = 0;

bool makeUtcTimestamp(char* output, size_t outputSize, time_t* epochSeconds) {
  const time_t now = time(nullptr);
  if (now < 1700000000) return false;

  struct tm utcTime;
  if (gmtime_r(&now, &utcTime) == nullptr) return false;
  if (strftime(output, outputSize, "%Y-%m-%dT%H:%M:%SZ", &utcTime) == 0) return false;
  *epochSeconds = now;
  return true;
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.begin(GRAINGUARD_WIFI_SSID, GRAINGUARD_WIFI_PASSWORD);
  const uint32_t startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < 20000UL) {
    delay(250);
  }
}

void sendReading() {
  if (WiFi.status() != WL_CONNECTED) return;

  char recordedAt[32];
  time_t epochSeconds = 0;
  if (!makeUtcTimestamp(recordedAt, sizeof(recordedAt), &epochSeconds)) return;

  StaticJsonDocument<512> document;
  document["device_id"] = GRAINGUARD_DEVICE_ID;
  document["sensor_id"] = GRAINGUARD_SENSOR_CODE;
  document["storage_unit_id"] = GRAINGUARD_STORAGE_UNIT_ID;
  document["zone_id"] = GRAINGUARD_ZONE_ID;
  document["recorded_at"] = recordedAt;
  document["gas_raw_value"] = analogRead(MQ2_PIN);

  const float temperature = dht.readTemperature();
  const float humidity = dht.readHumidity();
  if (!isnan(temperature)) document["temperature"] = temperature;
  if (!isnan(humidity)) document["humidity"] = humidity;

  char messageId[128];
  snprintf(
    messageId,
    sizeof(messageId),
    "%s-%lu-%lu",
    GRAINGUARD_DEVICE_ID,
    static_cast<unsigned long>(epochSeconds),
    static_cast<unsigned long>(messageCounter++)
  );
  document["message_id"] = messageId;

  WiFiClientSecure tlsClient;
  tlsClient.setCACert(ROOT_CA_CERT);
  HTTPClient http;
  if (!http.begin(tlsClient, GRAINGUARD_API_URL)) return;

  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + GRAINGUARD_DEVICE_API_KEY);
  String body;
  serializeJson(document, body);
  const int statusCode = http.POST(body);
  if (statusCode < 0) {
    Serial.printf("Sensor request failed: %s\n", HTTPClient::errorToString(statusCode).c_str());
  } else {
    Serial.printf("Sensor API responded with HTTP %d\n", statusCode);
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  dht.begin();
  connectWifi();
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
}

void loop() {
  connectWifi();
  if (WiFi.status() == WL_CONNECTED && millis() - lastSentAt >= SENSOR_INTERVAL_MS) {
    lastSentAt = millis();
    sendReading();
  }
  delay(250);
}
