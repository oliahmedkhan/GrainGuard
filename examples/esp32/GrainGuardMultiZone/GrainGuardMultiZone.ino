#include <ArduinoJson.h>
#include <DHT.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>
#include <set>
#include <vector>

#include <esp_system.h>

#if __has_include("grainguard_secrets.h")
#include "grainguard_secrets.h"
#else
#include "grainguard_secrets.example.h"
#define GRAINGUARD_USING_EXAMPLE_SECRETS 1
#endif

#if __has_include("grainguard_config.h")
#include "grainguard_config.h"
#else
#include "grainguard_config.example.h"
#define GRAINGUARD_USING_EXAMPLE_CONFIG 1
#endif

namespace {

constexpr size_t ZONE_COUNT = 3;
constexpr size_t HTTP_BODY_CAPACITY = 768;
constexpr uint32_t DEFAULT_SAMPLE_INTERVAL_MS = 60000;
constexpr uint32_t DEFAULT_MIN_FAN_ON_MS = 60000;
constexpr uint32_t DEFAULT_MIN_FAN_OFF_MS = 60000;
constexpr uint32_t DEFAULT_FAULT_HOLD_MS = 120000;
constexpr uint32_t DHT_MIN_SAMPLE_INTERVAL_MS = 2000;
constexpr uint8_t MAX_RETRY_ATTEMPTS = 5;

struct AnalogChannel {
  uint8_t gpio = 0;
};

struct OutputChannel {
  uint8_t gpio = 0;
  bool activeHigh = true;
};

struct ZoneProvisioning {
  const char* zoneId;
  const char* storageUnitId;
  const char* sensorCode;
  const char* deviceId;
  const char* apiKey;
};

struct ZoneHardware {
  uint8_t dhtGpio;
  uint8_t mq2Gpio;
  uint8_t fanGpio;
  uint8_t ledGpio;
};

constexpr ZoneProvisioning PROVISIONING[ZONE_COUNT] = {
    {GRAINGUARD_ZONE_1_ZONE_ID, GRAINGUARD_ZONE_1_STORAGE_UNIT_ID,
     GRAINGUARD_ZONE_1_SENSOR_CODE, GRAINGUARD_ZONE_1_DEVICE_ID,
     GRAINGUARD_ZONE_1_DEVICE_API_KEY},
    {GRAINGUARD_ZONE_2_ZONE_ID, GRAINGUARD_ZONE_2_STORAGE_UNIT_ID,
     GRAINGUARD_ZONE_2_SENSOR_CODE, GRAINGUARD_ZONE_2_DEVICE_ID,
     GRAINGUARD_ZONE_2_DEVICE_API_KEY},
    {GRAINGUARD_ZONE_3_ZONE_ID, GRAINGUARD_ZONE_3_STORAGE_UNIT_ID,
     GRAINGUARD_ZONE_3_SENSOR_CODE, GRAINGUARD_ZONE_3_DEVICE_ID,
     GRAINGUARD_ZONE_3_DEVICE_API_KEY},
};

constexpr ZoneHardware HARDWARE[ZONE_COUNT] = {
    {4, 34, 18, 25},
    {16, 35, 19, 26},
    {17, 32, 21, 27},
};

class Dht22SensorAdapter {
 public:
  void begin(uint8_t gpio) {
    sensor.reset(new DHT(gpio, DHT22));
    sensor->begin();
  }

  bool read(float& temperatureC, float& humidityPercent) {
    if (!sensor) return false;
    temperatureC = sensor->readTemperature();
    humidityPercent = sensor->readHumidity();
    return std::isfinite(temperatureC) &&
           temperatureC >= -40.0f &&
           temperatureC <= 80.0f &&
           std::isfinite(humidityPercent) &&
           humidityPercent >= 0.0f &&
           humidityPercent <= 100.0f;
  }

 private:
  std::unique_ptr<DHT> sensor;
};

struct ZoneConfig {
  String zoneId;
  String storageUnitId;
  String sensorCode;
  String deviceId;
  String apiKey;
  uint8_t dhtGpio = 0;
  AnalogChannel mq2;
  OutputChannel fan;
  OutputChannel led;
  float temperatureOnC = 30.0f;
  float temperatureOffC = 28.0f;
  float humidityOnPercent = 70.0f;
  float humidityOffPercent = 65.0f;
  bool registrationValid = false;
};

struct ZoneRuntime {
  ZoneConfig config;
  Dht22SensorAdapter dht;
  bool fanOn = false;
  bool temperatureDemand = false;
  bool humidityDemand = false;
  bool faultActive = false;
  bool faultLatched = false;
  bool sampleValid = false;
  bool temperatureValid = false;
  bool humidityValid = false;
  bool gasValid = false;
  bool ledState = false;
  float temperatureC = NAN;
  float humidityPercent = NAN;
  uint16_t gasRaw = 0;
  uint32_t lastSampleAt = 0;
  uint32_t lastGoodSampleAt = 0;
  uint32_t faultStartedAt = 0;
  uint32_t lastFanSwitchAt = 0;
  String lastFaultCode;
  char fanStateKey[12] = {};
  char faultStateKey[12] = {};
};

struct PendingRequest {
  size_t zoneIndex = 0;
  char path[32] = {};
  char body[HTTP_BODY_CAPACITY] = {};
  uint8_t attempts = 0;
  uint32_t nextAttemptAt = 0;
};

std::vector<ZoneRuntime> zones;
QueueHandle_t readingsQueue = nullptr;
QueueHandle_t faultQueue = nullptr;
Preferences stateStore;
bool configurationValid = false;
bool hardwareConfirmed = false;
bool networkConfigurationValid = false;
bool wifiWasConnected = false;
uint32_t sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS;
uint32_t minFanOnMs = DEFAULT_MIN_FAN_ON_MS;
uint32_t minFanOffMs = DEFAULT_MIN_FAN_OFF_MS;
uint32_t faultHoldMs = DEFAULT_FAULT_HOLD_MS;
uint32_t nextSampleAt = 0;
uint32_t nextWifiAttemptAt = 0;
uint32_t messageCounter = 0;
uint32_t bootMessageId = 0;
String serialCommand;

bool isOutputGpio(int gpio) {
  switch (gpio) {
    case 4:
    case 13:
    case 14:
    case 16:
    case 17:
    case 18:
    case 19:
    case 21:
    case 22:
    case 23:
    case 25:
    case 26:
    case 27:
    case 32:
    case 33:
      return true;
    default:
      return false;
  }
}

bool isAdc1Gpio(int gpio) {
  switch (gpio) {
    case 32:
    case 33:
    case 34:
    case 35:
    case 36:
    case 39:
      return true;
    default:
      return false;
  }
}

bool isUuid(const String& value) {
  if (value.length() != 36) return false;
  for (size_t index = 0; index < value.length(); index++) {
    const char character = value[index];
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (character != '-') return false;
    } else if (!isxdigit(static_cast<unsigned char>(character))) {
      return false;
    }
  }
  return true;
}

bool isCode(const String& value, size_t minimum, size_t maximum) {
  if (value.length() < minimum || value.length() > maximum) return false;
  for (size_t index = 0; index < value.length(); index++) {
    const char character = value[index];
    if (!isAlphaNumeric(static_cast<unsigned char>(character)) &&
        character != '.' && character != '_' && character != '-') {
      return false;
    }
  }
  return true;
}

bool claimGpio(std::set<int>& usedGpios, int gpio, bool output) {
  if (output ? !isOutputGpio(gpio) : !isAdc1Gpio(gpio)) return false;
  return usedGpios.insert(gpio).second;
}

uint32_t zoneHash(const String& zoneId) {
  uint32_t hash = 2166136261UL;
  for (size_t index = 0; index < zoneId.length(); index++) {
    hash ^= static_cast<uint8_t>(zoneId[index]);
    hash *= 16777619UL;
  }
  return hash;
}

void makeStateKeys(ZoneRuntime& zone, size_t index) {
  const uint32_t hash = isUuid(zone.config.zoneId)
                            ? zoneHash(zone.config.zoneId)
                            : static_cast<uint32_t>(index + 1);
  snprintf(zone.fanStateKey, sizeof(zone.fanStateKey), "f%08lx", static_cast<unsigned long>(hash));
  snprintf(zone.faultStateKey, sizeof(zone.faultStateKey), "l%08lx", static_cast<unsigned long>(hash));
}

bool isPlaceholder(const char* value) {
  if (value == nullptr || value[0] == '\0') return true;
  return strstr(value, "your-") != nullptr ||
         strstr(value, "REPLACE_WITH") != nullptr ||
         strstr(value, ".example") != nullptr;
}

bool validZoneRegistration(const ZoneProvisioning& provisioning) {
  const String zoneId = provisioning.zoneId == nullptr ? "" : provisioning.zoneId;
  const String storageUnitId =
      provisioning.storageUnitId == nullptr ? "" : provisioning.storageUnitId;
  const String sensorCode = provisioning.sensorCode == nullptr ? "" : provisioning.sensorCode;
  const String deviceId = provisioning.deviceId == nullptr ? "" : provisioning.deviceId;
  const String apiKey = provisioning.apiKey == nullptr ? "" : provisioning.apiKey;
  return isUuid(zoneId) &&
         isUuid(storageUnitId) &&
         isCode(sensorCode, 3, 64) &&
         isCode(deviceId, 3, 100) &&
         apiKey.length() >= 32 &&
         apiKey.length() <= 128 &&
         !isPlaceholder(apiKey.c_str());
}

bool hasConflictingRegistration(size_t index) {
  for (size_t other = 0; other < ZONE_COUNT; other++) {
    if (other == index) continue;
    if ((PROVISIONING[index].zoneId[0] != '\0' &&
         strcmp(PROVISIONING[index].zoneId, PROVISIONING[other].zoneId) == 0) ||
        (PROVISIONING[index].sensorCode[0] != '\0' &&
         strcmp(PROVISIONING[index].sensorCode, PROVISIONING[other].sensorCode) == 0) ||
        (PROVISIONING[index].apiKey[0] != '\0' &&
         strcmp(PROVISIONING[index].apiKey, PROVISIONING[other].apiKey) == 0)) {
      return true;
    }
    if (PROVISIONING[index].deviceId[0] != '\0' &&
        PROVISIONING[other].deviceId[0] != '\0' &&
        strcmp(PROVISIONING[index].deviceId, PROVISIONING[other].deviceId) != 0) {
      return true;
    }
  }
  return false;
}

bool networkSettingsReady() {
  const char* url = GRAINGUARD_API_BASE_URL;
  const char* ssid = GRAINGUARD_WIFI_SSID;
  const char* password = GRAINGUARD_WIFI_PASSWORD;
  const char* certificate = ROOT_CA_CERT;
  return !isPlaceholder(url) &&
         strncmp(url, "https://", 8) == 0 &&
         url[strlen(url) - 1] != '/' &&
         !isPlaceholder(ssid) &&
         !isPlaceholder(password) &&
         strstr(certificate, "-----BEGIN CERTIFICATE-----") != nullptr &&
         strstr(certificate, "REPLACE_WITH") == nullptr;
}

bool loadConfiguration() {
  hardwareConfirmed =
      GRAINGUARD_HARDWARE_CONFIRMED && GRAINGUARD_FAN_POLARITY_CONFIRMED;
  sampleIntervalMs = GRAINGUARD_SAMPLE_INTERVAL_MS;
  minFanOnMs = GRAINGUARD_MIN_FAN_ON_MS;
  minFanOffMs = GRAINGUARD_MIN_FAN_OFF_MS;
  faultHoldMs = GRAINGUARD_SENSOR_FAULT_HOLD_MS;
  if (sampleIntervalMs < DHT_MIN_SAMPLE_INTERVAL_MS ||
      sampleIntervalMs > 3600000UL ||
      minFanOnMs > 86400000UL ||
      minFanOffMs > 86400000UL ||
      faultHoldMs < 1000UL ||
      faultHoldMs > 3600000UL) {
    Serial.println("Invalid compile-time timing configuration.");
    return false;
  }

  std::set<int> usedGpios;
  zones.reserve(ZONE_COUNT);
  for (size_t index = 0; index < ZONE_COUNT; index++) {
    const ZoneHardware& hardware = HARDWARE[index];
    if (!claimGpio(usedGpios, hardware.dhtGpio, true) ||
        !claimGpio(usedGpios, hardware.mq2Gpio, false) ||
        !claimGpio(usedGpios, hardware.fanGpio, true) ||
        !claimGpio(usedGpios, hardware.ledGpio, true)) {
      Serial.printf("Invalid or conflicting hardware mapping in zone %u.\n",
                    static_cast<unsigned>(index + 1));
      return false;
    }

    ZoneRuntime zone;
    const ZoneProvisioning& registration = PROVISIONING[index];
    zone.config.zoneId = registration.zoneId;
    zone.config.storageUnitId = registration.storageUnitId;
    zone.config.sensorCode = registration.sensorCode;
    zone.config.deviceId = registration.deviceId;
    zone.config.apiKey = registration.apiKey;
    zone.config.dhtGpio = hardware.dhtGpio;
    zone.config.mq2.gpio = hardware.mq2Gpio;
    zone.config.fan.gpio = hardware.fanGpio;
    zone.config.fan.activeHigh = GRAINGUARD_FAN_ACTIVE_HIGH;
    zone.config.led.gpio = hardware.ledGpio;
    zone.config.led.activeHigh = true;
    zone.config.registrationValid =
        validZoneRegistration(registration) && !hasConflictingRegistration(index);
    if (!zone.config.registrationValid) {
      Serial.printf("Zone %u registration missing or invalid; telemetry disabled for this zone.\n",
                    static_cast<unsigned>(index + 1));
    }
    makeStateKeys(zone, index);
    zones.push_back(std::move(zone));
  }

  networkConfigurationValid = networkSettingsReady();
  return true;
}

class FanControllerAdapter {
 public:
  bool begin(const OutputChannel& output, bool active) {
    const bool level = active ? output.activeHigh : !output.activeHigh;
    digitalWrite(output.gpio, level ? HIGH : LOW);
    pinMode(output.gpio, OUTPUT);
    digitalWrite(output.gpio, level ? HIGH : LOW);
    return true;
  }

  void release(const OutputChannel& output) {
    pinMode(output.gpio, INPUT);
  }

  bool set(const OutputChannel& output, bool active) {
    const bool level = active ? output.activeHigh : !output.activeHigh;
    digitalWrite(output.gpio, level ? HIGH : LOW);
    return true;
  }
};

class Mq2SensorAdapter {
 public:
  bool readRaw(const AnalogChannel& channel, uint16_t& value) const {
    const int reading = analogRead(channel.gpio);
    if (reading < 0 || reading > 4095) return false;
    value = static_cast<uint16_t>(reading);
    return true;
  }
};

FanControllerAdapter fanController;
Mq2SensorAdapter mq2Sensor;

bool initializeHardware() {
  for (size_t index = 0; index < zones.size(); index++) {
    ZoneRuntime& zone = zones[index];
    zone.dht.begin(zone.config.dhtGpio);
    analogSetPinAttenuation(zone.config.mq2.gpio, ADC_11db);
    if (hardwareConfirmed) fanController.begin(zone.config.fan, false);
    else fanController.release(zone.config.fan);
    fanController.begin(zone.config.led, false);
    Serial.printf("Zone %u DHT22: initialized on GPIO %u\n",
                  static_cast<unsigned>(index + 1),
                  static_cast<unsigned>(zone.config.dhtGpio));
    Serial.printf("Zone %u MQ-2 ADC1: initialized on GPIO %u\n",
                  static_cast<unsigned>(index + 1),
                  static_cast<unsigned>(zone.config.mq2.gpio));
  }
  return true;
}

bool enqueueRequest(
    QueueHandle_t queue,
    size_t zoneIndex,
    const char* path,
    JsonDocument& document) {
  PendingRequest request;
  request.zoneIndex = zoneIndex;
  snprintf(request.path, sizeof(request.path), "%s", path);
  const size_t bodyLength = serializeJson(document, request.body, sizeof(request.body));
  if (bodyLength == 0 || bodyLength >= sizeof(request.body)) return false;
  const TickType_t wait = queue == faultQueue ? pdMS_TO_TICKS(100) : 0;
  return xQueueSend(queue, &request, wait) == pdTRUE;
}

void enqueueFaultEvent(size_t zoneIndex, const char* event, const String& faultCode) {
  if (!zones[zoneIndex].config.registrationValid || !networkConfigurationValid) return;
  JsonDocument document;
  document["event"] = event;
  document["device_id"] = zones[zoneIndex].config.deviceId;
  document["sensor_id"] = zones[zoneIndex].config.sensorCode;
  document["fault_code"] = faultCode;
  if (!enqueueRequest(faultQueue, zoneIndex, "/api/v1/sensors/faults", document)) {
    Serial.printf("Could not queue fault event for zone %s.\n", zones[zoneIndex].config.zoneId.c_str());
  }
}

int sendRequest(const PendingRequest& request) {
  if (request.zoneIndex >= zones.size() || WiFi.status() != WL_CONNECTED) return -1;
  WiFiClientSecure tlsClient;
  tlsClient.setCACert(ROOT_CA_CERT);
  HTTPClient http;
  http.setConnectTimeout(5000);
  http.setTimeout(5000);
  const String url = String(GRAINGUARD_API_BASE_URL) + request.path;
  if (!http.begin(tlsClient, url)) return -1;

  http.addHeader("Content-Type", "application/json");
  http.addHeader(
      "Authorization",
      String("Bearer ") + zones[request.zoneIndex].config.apiKey);
  const int statusCode = http.POST(
      reinterpret_cast<uint8_t*>(const_cast<char*>(request.body)),
      strlen(request.body));
  if (statusCode == 409) {
    const String responseBody = http.getString();
    if (responseBody.indexOf("DUPLICATE_MESSAGE_ID") >= 0) {
      http.end();
      return 208;
    }
  }
  http.end();
  return statusCode;
}

void networkTask(void*) {
  bool preferFault = true;
  for (;;) {
    PendingRequest request;
    QueueHandle_t queue = nullptr;
    if (preferFault) {
      if (xQueueReceive(faultQueue, &request, 0) == pdTRUE) queue = faultQueue;
      else if (xQueueReceive(readingsQueue, &request, 0) == pdTRUE) queue = readingsQueue;
    } else {
      if (xQueueReceive(readingsQueue, &request, 0) == pdTRUE) queue = readingsQueue;
      else if (xQueueReceive(faultQueue, &request, 0) == pdTRUE) queue = faultQueue;
    }
    preferFault = !preferFault;

    if (queue == nullptr) {
      vTaskDelay(pdMS_TO_TICKS(50));
      continue;
    }

    const uint32_t now = millis();
    if (static_cast<int32_t>(now - request.nextAttemptAt) < 0) {
      if (xQueueSend(queue, &request, 0) != pdTRUE) {
        Serial.printf("Retry queue full for zone %u; request dropped.\n",
                      static_cast<unsigned>(request.zoneIndex + 1));
      }
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }

    const int statusCode = sendRequest(request);
    if ((statusCode >= 200 && statusCode < 300) || statusCode == 208) {
      Serial.printf("Zone %u API Status: %d%s\n",
                    static_cast<unsigned>(request.zoneIndex + 1),
                    statusCode,
                    statusCode == 208 ? " (duplicate already stored)" : "");
      continue;
    }

    if (statusCode == 401) {
      Serial.printf("Zone %u API authentication failed; check its registered device key.\n",
                    static_cast<unsigned>(request.zoneIndex + 1));
    } else if (statusCode == 403) {
      Serial.printf("Zone %u API rejected its device or registration mapping.\n",
                    static_cast<unsigned>(request.zoneIndex + 1));
    } else if (statusCode < 0) {
      Serial.printf("Zone %u HTTP transport/TLS failure: %d\n",
                    static_cast<unsigned>(request.zoneIndex + 1), statusCode);
    } else {
      Serial.printf("Zone %u API Status: %d\n",
                    static_cast<unsigned>(request.zoneIndex + 1), statusCode);
    }

    const bool retryable =
        statusCode < 0 || statusCode == 408 || statusCode == 429 || statusCode >= 500;
    if (!retryable || request.attempts >= MAX_RETRY_ATTEMPTS) {
      Serial.printf("Zone %u request discarded after %u attempts.\n",
                    static_cast<unsigned>(request.zoneIndex + 1),
                    static_cast<unsigned>(request.attempts + 1));
      continue;
    }

    constexpr uint32_t RETRY_BACKOFF_MS[MAX_RETRY_ATTEMPTS] = {
        2000, 5000, 10000, 20000, 30000};
    request.nextAttemptAt = millis() + RETRY_BACKOFF_MS[request.attempts];
    request.attempts++;
    if (xQueueSend(queue, &request, 0) != pdTRUE) {
      Serial.printf("Retry queue full for zone %u; request dropped.\n",
                    static_cast<unsigned>(request.zoneIndex + 1));
    }
  }
}

bool makeUtcTimestamp(char* output, size_t outputSize, time_t* epochSeconds) {
  const time_t now = time(nullptr);
  if (now < 1700000000) return false;
  struct tm utcTime;
  if (gmtime_r(&now, &utcTime) == nullptr) return false;
  if (strftime(output, outputSize, "%Y-%m-%dT%H:%M:%SZ", &utcTime) == 0) return false;
  *epochSeconds = now;
  return true;
}

void queueReading(size_t zoneIndex) {
  ZoneRuntime& zone = zones[zoneIndex];
  if (!zone.config.registrationValid || !networkConfigurationValid) return;
  char recordedAt[32];
  time_t epochSeconds = 0;
  if (!makeUtcTimestamp(recordedAt, sizeof(recordedAt), &epochSeconds)) {
    Serial.println("NTP time is not ready; sensor reading was not queued.");
    return;
  }

  JsonDocument document;
  document["device_id"] = zone.config.deviceId;
  document["sensor_id"] = zone.config.sensorCode;
  document["storage_unit_id"] = zone.config.storageUnitId;
  document["zone_id"] = zone.config.zoneId;
  if (zone.temperatureValid) document["temperature"] = zone.temperatureC;
  else document["temperature"] = nullptr;
  if (zone.humidityValid) document["humidity"] = zone.humidityPercent;
  else document["humidity"] = nullptr;
  if (zone.gasValid) document["gas_raw_value"] = zone.gasRaw;
  else document["gas_raw_value"] = nullptr;
  if (hardwareConfirmed) document["fan_status"] = zone.fanOn;
  else document["fan_status"] = nullptr;
  document["recorded_at"] = recordedAt;

  char messageId[128];
  snprintf(
      messageId,
      sizeof(messageId),
      "%s-%08lx-%lu-%lu",
      zone.config.sensorCode.c_str(),
      static_cast<unsigned long>(bootMessageId),
      static_cast<unsigned long>(epochSeconds),
      static_cast<unsigned long>(messageCounter++));
  document["message_id"] = messageId;

  Serial.printf("Sending Zone %u data...\n", static_cast<unsigned>(zoneIndex + 1));
  if (!enqueueRequest(readingsQueue, zoneIndex, "/api/v1/sensors/readings", document)) {
    Serial.printf("Reading queue full for zone %u; sample dropped.\n",
                  static_cast<unsigned>(zoneIndex + 1));
  }
}

bool setFanState(size_t zoneIndex, bool on, uint32_t now, bool ignoreMinimumInterval = false) {
  ZoneRuntime& zone = zones[zoneIndex];
  if (!hardwareConfirmed) {
    zone.fanOn = false;
    return true;
  }
  if (zone.fanOn == on) return fanController.set(zone.config.fan, on);
  if (!ignoreMinimumInterval) {
    const uint32_t minimum = zone.fanOn ? minFanOnMs : minFanOffMs;
    if (now - zone.lastFanSwitchAt < minimum) return true;
  }
  if (!fanController.set(zone.config.fan, on)) return false;
  zone.fanOn = on;
  zone.lastFanSwitchAt = now;
  stateStore.putBool(zone.fanStateKey, on);
  return true;
}

void setLedState(ZoneRuntime& zone, bool on) {
  if (zone.ledState == on) return;
  if (fanController.set(zone.config.led, on)) zone.ledState = on;
}

void beginFault(size_t zoneIndex, const String& faultCode, uint32_t now) {
  ZoneRuntime& zone = zones[zoneIndex];
  if (zone.faultLatched) return;
  if (!zone.faultActive) {
    zone.faultActive = true;
    zone.faultStartedAt = now;
    zone.lastFaultCode = faultCode;
    enqueueFaultEvent(zoneIndex, "fault", faultCode);
  }
}

bool parseZoneIdFromCommand(const String& command, String& zoneId) {
  const String prefix = "RESET_FAULT ";
  if (!command.startsWith(prefix)) return false;
  zoneId = command.substring(prefix.length());
  zoneId.trim();
  return isUuid(zoneId);
}

void processSerialCommands() {
  while (Serial.available() > 0) {
    const char character = static_cast<char>(Serial.read());
    if (character == '\r') continue;
    if (character != '\n') {
      if (serialCommand.length() < 100) serialCommand += character;
      continue;
    }

    serialCommand.trim();
    String zoneId;
    if (parseZoneIdFromCommand(serialCommand, zoneId)) {
      for (size_t index = 0; index < zones.size(); index++) {
        ZoneRuntime& zone = zones[index];
        if (zone.config.zoneId != zoneId) continue;
        const bool readingFresh =
            zone.sampleValid &&
            millis() - zone.lastGoodSampleAt <= sampleIntervalMs * 2U;
        if (!zone.faultLatched || !readingFresh) {
          Serial.println("Reset refused: fault must be latched and all zone sensors healthy.");
          break;
        }
        zone.faultLatched = false;
        zone.faultActive = false;
        zone.temperatureDemand = false;
        zone.humidityDemand = false;
        stateStore.putBool(zone.faultStateKey, false);
        enqueueFaultEvent(index, "manual_reset", "MANUAL_INSPECTION_RESET");
        Serial.printf("Fault reset accepted for zone %s.\n", zoneId.c_str());
        break;
      }
    } else if (serialCommand.length() > 0) {
      Serial.println("Use: RESET_FAULT <zone-uuid> after physical inspection.");
    }
    serialCommand = "";
  }
}

bool updateDemand(bool previous, float value, float onThreshold, float offThreshold) {
  if (value >= onThreshold) return true;
  if (value <= offThreshold) return false;
  return previous;
}

void sampleZone(size_t zoneIndex, uint32_t now) {
  ZoneRuntime& zone = zones[zoneIndex];
  zone.lastSampleAt = now;

  zone.temperatureValid = zone.dht.read(zone.temperatureC, zone.humidityPercent);
  zone.humidityValid = zone.temperatureValid;
  zone.gasValid = mq2Sensor.readRaw(zone.config.mq2, zone.gasRaw);

  zone.sampleValid = zone.temperatureValid && zone.humidityValid && zone.gasValid;
  Serial.printf("Zone %u DHT22: %s\n",
                static_cast<unsigned>(zoneIndex + 1),
                zone.temperatureValid ? "OK" : "READ FAILED");
  Serial.printf("Zone %u MQ-2 ADC: %s",
                static_cast<unsigned>(zoneIndex + 1),
                zone.gasValid ? "OK" : "READ FAILED");
  if (zone.gasValid) Serial.printf(" (%u raw)", static_cast<unsigned>(zone.gasRaw));
  Serial.println();
  if (!zone.sampleValid) {
    String faultCode = "ZONE_SENSOR_INVALID";
    if (!zone.temperatureValid || !zone.humidityValid) faultCode = "DHT22_INVALID";
    else if (!zone.gasValid) faultCode = "MQ2_ADC_UNAVAILABLE";
    beginFault(zoneIndex, faultCode, now);
  } else {
    zone.lastGoodSampleAt = now;
    if (zone.faultActive && !zone.faultLatched) {
      zone.faultActive = false;
      zone.lastFaultCode = "";
      enqueueFaultEvent(zoneIndex, "recovered", "SENSOR_RECOVERED");
    }
  }

  if (zone.faultLatched) {
    setFanState(zoneIndex, false, now, true);
    return;
  }
  if (zone.faultActive) {
    return;
  }

  if (!zone.sampleValid) return;
  if (!hardwareConfirmed) {
    setFanState(zoneIndex, false, now, true);
    return;
  }

  zone.temperatureDemand = updateDemand(
      zone.temperatureDemand,
      zone.temperatureC,
      zone.config.temperatureOnC,
      zone.config.temperatureOffC);

  zone.humidityDemand = false;
  if (!setFanState(zoneIndex, zone.temperatureDemand, now)) {
    beginFault(zoneIndex, "FAN_CONTROLLER_UNAVAILABLE", now);
  }
}

void enforceFaultTimeouts(uint32_t now) {
  for (size_t index = 0; index < zones.size(); index++) {
    ZoneRuntime& zone = zones[index];
    if (!zone.faultActive || zone.faultLatched || now - zone.faultStartedAt < faultHoldMs) {
      continue;
    }
    zone.faultLatched = true;
    stateStore.putBool(zone.faultStateKey, true);
    setFanState(index, false, now, true);
    Serial.printf("SENSOR_FAULT latched; fan forced OFF for zone %u.\n",
                  static_cast<unsigned>(index + 1));
  }
}

void updateZoneLed(ZoneRuntime& zone, uint32_t now) {
  const bool ledOn =
      zone.faultActive || zone.faultLatched
          ? ((now / 300U) % 2U) == 0U
          : zone.fanOn;
  setLedState(zone, ledOn);
}

void beginWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(GRAINGUARD_WIFI_SSID, GRAINGUARD_WIFI_PASSWORD);
  nextWifiAttemptAt = millis() + 10000U;
  Serial.println("Connecting to Wi-Fi...");
}

void maintainWifi(uint32_t now) {
  if (!networkConfigurationValid) return;
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiWasConnected) Serial.println("WiFi Connected");
    wifiWasConnected = true;
    return;
  }
  wifiWasConnected = false;
  if (static_cast<int32_t>(now - nextWifiAttemptAt) < 0) return;
  WiFi.disconnect();
  WiFi.begin(GRAINGUARD_WIFI_SSID, GRAINGUARD_WIFI_PASSWORD);
  nextWifiAttemptAt = now + 10000U;
  Serial.println("WiFi unavailable; retrying connection.");
}

void restoreZoneState(size_t zoneIndex) {
  ZoneRuntime& zone = zones[zoneIndex];
  zone.faultLatched = stateStore.getBool(zone.faultStateKey, false);
  zone.fanOn = hardwareConfirmed && !zone.faultLatched &&
               stateStore.getBool(zone.fanStateKey, false);
  if (hardwareConfirmed) fanController.begin(zone.config.fan, zone.fanOn);
  else fanController.release(zone.config.fan);
  fanController.begin(zone.config.led, false);
  zone.ledState = false;
  zone.lastFanSwitchAt = millis();
  if (zone.faultLatched) {
    zone.faultActive = true;
    zone.faultStartedAt = millis();
    enqueueFaultEvent(zoneIndex, "fault", "MANUAL_INSPECTION_REQUIRED");
  }
}

}  // namespace

void setup() {
  Serial.begin(115200);
  Serial.println("GrainGuard ESP32 Starting...");
  analogReadResolution(12);
  bootMessageId = esp_random();

  if (!loadConfiguration()) {
    Serial.println("Compile-time configuration rejected; sensors will not start.");
    return;
  }
  if (!initializeHardware()) {
    Serial.println("Hardware initialization failed; check sensor wiring.");
    return;
  }

  stateStore.begin("gg_zones", false);
  bool hasRegisteredZone = false;
  for (size_t index = 0; index < zones.size(); index++) {
    hasRegisteredZone = hasRegisteredZone || zones[index].config.registrationValid;
    restoreZoneState(index);
  }

  if (networkConfigurationValid && hasRegisteredZone) {
    const UBaseType_t readingsQueueLength = static_cast<UBaseType_t>((ZONE_COUNT * 4) + 8);
    const UBaseType_t faultQueueLength = static_cast<UBaseType_t>((ZONE_COUNT * 2) + 8);
    readingsQueue = xQueueCreate(readingsQueueLength, sizeof(PendingRequest));
    faultQueue = xQueueCreate(faultQueueLength, sizeof(PendingRequest));
    if (readingsQueue == nullptr || faultQueue == nullptr) {
      Serial.println("Network queue allocation failed; sensor polling remains active without telemetry.");
      networkConfigurationValid = false;
    } else {
      beginWifi();
      configTime(0, 0, "pool.ntp.org", "time.nist.gov");
      if (xTaskCreatePinnedToCore(networkTask, "gg-network", 8192, nullptr, 1, nullptr, 0) != pdPASS) {
        Serial.println("Network task creation failed; sensor polling remains active without telemetry.");
        networkConfigurationValid = false;
      }
    }
  } else {
    networkConfigurationValid = false;
    Serial.println("Telemetry disabled: provide valid Wi-Fi/TLS settings and actual sensor registrations.");
  }

  configurationValid = true;

  if (!hardwareConfirmed) {
    if (GRAINGUARD_HARDWARE_CONFIRMED && !GRAINGUARD_FAN_POLARITY_CONFIRMED) {
      Serial.println("Fan polarity is not confirmed: fan outputs are released and automation remains OFF.");
    } else {
      Serial.println("Hardware is unconfirmed: fan outputs are released and automation remains OFF.");
    }
  }
  Serial.println("No outside-air humidity sensor configured; humidity-only ventilation is inhibited.");
  Serial.printf("Initialized %u fixed zones.\n", static_cast<unsigned>(zones.size()));
}

void loop() {
  if (!configurationValid) {
    delay(1000);
    return;
  }

  processSerialCommands();
  const uint32_t now = millis();
  maintainWifi(now);

  if (static_cast<int32_t>(now - nextSampleAt) >= 0) {
    nextSampleAt = now + sampleIntervalMs;
    for (size_t index = 0; index < zones.size(); index++) {
      sampleZone(index, now);
      enforceFaultTimeouts(now);
      queueReading(index);
    }
  }

  enforceFaultTimeouts(now);
  for (ZoneRuntime& zone : zones) updateZoneLed(zone, now);
  delay(50);
}