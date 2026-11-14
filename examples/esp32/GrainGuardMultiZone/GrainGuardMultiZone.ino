#include <Adafruit_ADS1X15.h>
#include <Adafruit_MCP23X17.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <HTTPClient.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Wire.h>

#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

#include <array>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "grainguard_secrets.h"

#ifndef GRAINGUARD_WIFI_SSID
#error "Define GRAINGUARD_WIFI_SSID in grainguard_secrets.h."
#endif

#ifndef GRAINGUARD_WIFI_PASSWORD
#error "Define GRAINGUARD_WIFI_PASSWORD in grainguard_secrets.h."
#endif

#ifndef GRAINGUARD_API_BASE_URL
#error "Define GRAINGUARD_API_BASE_URL in grainguard_secrets.h."
#endif

#ifndef ROOT_CA_CERT
#error "Define ROOT_CA_CERT with the trusted TLS CA certificate."
#endif

namespace {

constexpr char CONFIG_PATH[] = "/zones.json";
constexpr size_t CONFIG_MAX_BYTES = 32 * 1024;
constexpr size_t HTTP_BODY_CAPACITY = 768;
constexpr uint8_t MAX_ADS1115_ADDRESSES = 4;
constexpr uint8_t MAX_MCP23017_ADDRESSES = 8;
constexpr uint32_t DEFAULT_SAMPLE_INTERVAL_MS = 60000;
constexpr uint32_t DEFAULT_MIN_FAN_ON_MS = 60000;
constexpr uint32_t DEFAULT_MIN_FAN_OFF_MS = 60000;
constexpr uint32_t DEFAULT_FAULT_HOLD_MS = 120000;
constexpr uint32_t DHT_MIN_SAMPLE_INTERVAL_MS = 2000;
constexpr uint8_t DEFAULT_I2C_SDA_GPIO = 13;
constexpr uint8_t DEFAULT_I2C_SCL_GPIO = 14;
enum class AnalogKind : uint8_t { Esp32Adc, Ads1115 };
enum class OutputKind : uint8_t { Gpio, Mcp23017 };

struct AnalogChannel {
  AnalogKind kind = AnalogKind::Esp32Adc;
  uint8_t gpio = 0;
  uint8_t address = 0;
  uint8_t channel = 0;
};

struct OutputChannel {
  OutputKind kind = OutputKind::Gpio;
  uint8_t gpio = 0;
  uint8_t address = 0;
  uint8_t channel = 0;
  bool activeHigh = true;
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
};

std::vector<ZoneRuntime> zones;
std::array<Adafruit_ADS1115, MAX_ADS1115_ADDRESSES> adsDevices;
std::array<Adafruit_MCP23X17, MAX_MCP23017_ADDRESSES> mcpDevices;
std::array<bool, MAX_ADS1115_ADDRESSES> adsReady = {};
std::array<bool, MAX_MCP23017_ADDRESSES> mcpReady = {};
Dht22SensorAdapter outsideAirDht;
QueueHandle_t readingsQueue = nullptr;
QueueHandle_t faultQueue = nullptr;
Preferences stateStore;
bool configurationValid = false;
bool hardwareConfirmed = false;
bool hasExpansionHardware = false;
bool hasOutsideAirDht = false;
bool outsideAirSampled = false;
uint8_t outsideAirGpio = 0;
uint8_t i2cSdaGpio = DEFAULT_I2C_SDA_GPIO;
uint8_t i2cSclGpio = DEFAULT_I2C_SCL_GPIO;
uint32_t sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS;
uint32_t minFanOnMs = DEFAULT_MIN_FAN_ON_MS;
uint32_t minFanOffMs = DEFAULT_MIN_FAN_OFF_MS;
uint32_t faultHoldMs = DEFAULT_FAULT_HOLD_MS;
uint32_t nextSampleAt = 0;
uint32_t nextWifiAttemptAt = 0;
uint32_t messageCounter = 0;
uint32_t lastOutsideReadAt = 0;
float outsideHumidityPercent = NAN;
bool outsideHumidityValid = false;
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

bool isDhtGpio(int gpio) {
  return isOutputGpio(gpio);
}

bool parseText(JsonVariantConst value, String& output, size_t maxLength) {
  if (!value.is<const char*>()) return false;
  const char* text = value.as<const char*>();
  if (text == nullptr) return false;
  output = text;
  return output.length() > 0 && output.length() <= maxLength;
}

bool parseInteger(JsonVariantConst value, int minimum, int maximum, int& output) {
  if (!value.is<int>()) return false;
  const int parsed = value.as<int>();
  if (parsed < minimum || parsed > maximum) return false;
  output = parsed;
  return true;
}

bool parseNumber(JsonVariantConst value, float minimum, float maximum, float& output) {
  if (!value.is<float>() && !value.is<double>() && !value.is<int>()) return false;
  const double parsed = value.as<double>();
  if (!std::isfinite(parsed) || parsed < minimum || parsed > maximum) return false;
  output = static_cast<float>(parsed);
  return true;
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

bool parseI2cAddress(JsonVariantConst value, uint8_t minimum, uint8_t maximum, uint8_t& address) {
  String text;
  if (!parseText(value, text, 4) || !text.startsWith("0x")) return false;
  char* end = nullptr;
  const long parsed = strtol(text.c_str() + 2, &end, 16);
  if (end == text.c_str() + 2 || *end != '\0' || parsed < minimum || parsed > maximum) {
    return false;
  }
  address = static_cast<uint8_t>(parsed);
  return true;
}

bool parseOutputChannel(
    JsonObjectConst object,
    OutputChannel& output,
    std::set<int>& usedGpios,
    std::set<int>& usedMcpChannels) {
  String kind;
  if (!parseText(object["kind"], kind, 16)) return false;
  if (!object["active_high"].is<bool>()) return false;
  output.activeHigh = object["active_high"].as<bool>();

  if (kind == "gpio") {
    int gpio = -1;
    if (!parseInteger(object["gpio"], 0, 39, gpio) || !claimGpio(usedGpios, gpio, true)) {
      return false;
    }
    output.kind = OutputKind::Gpio;
    output.gpio = static_cast<uint8_t>(gpio);
    return true;
  }
  if (kind == "mcp23017") {
    uint8_t address = 0;
    int channel = -1;
    if (!parseI2cAddress(object["address"], 0x20, 0x27, address) ||
        !parseInteger(object["channel"], 0, 15, channel)) {
      return false;
    }
    const int key = (static_cast<int>(address) << 8) | channel;
    if (!usedMcpChannels.insert(key).second) return false;
    output.kind = OutputKind::Mcp23017;
    output.address = address;
    output.channel = static_cast<uint8_t>(channel);
    hasExpansionHardware = true;
    return true;
  }
  return false;
}

bool parseAnalogChannel(
    JsonObjectConst object,
    AnalogChannel& output,
    std::set<int>& usedGpios,
    std::set<int>& usedAdsChannels) {
  String kind;
  if (!parseText(object["kind"], kind, 16)) return false;
  if (kind == "esp32_adc") {
    int gpio = -1;
    if (!parseInteger(object["gpio"], 0, 39, gpio) || !claimGpio(usedGpios, gpio, false)) {
      return false;
    }
    output.kind = AnalogKind::Esp32Adc;
    output.gpio = static_cast<uint8_t>(gpio);
    return true;
  }
  if (kind == "ads1115") {
    uint8_t address = 0;
    int channel = -1;
    if (!parseI2cAddress(object["address"], 0x48, 0x4B, address) ||
        !parseInteger(object["channel"], 0, 3, channel)) {
      return false;
    }
    const int key = (static_cast<int>(address) << 8) | channel;
    if (!usedAdsChannels.insert(key).second) return false;
    output.kind = AnalogKind::Ads1115;
    output.address = address;
    output.channel = static_cast<uint8_t>(channel);
    hasExpansionHardware = true;
    return true;
  }
  return false;
}

bool parseZone(
    JsonObjectConst object,
    ZoneConfig& zone,
    std::set<int>& usedGpios,
    std::set<int>& usedAdsChannels,
    std::set<int>& usedMcpChannels) {
  if (!parseText(object["zone_id"], zone.zoneId, 36) || !isUuid(zone.zoneId) ||
      !parseText(object["storage_unit_id"], zone.storageUnitId, 36) ||
      !isUuid(zone.storageUnitId) ||
      !parseText(object["sensor_code"], zone.sensorCode, 64) ||
      !isCode(zone.sensorCode, 3, 64) ||
      !parseText(object["device_id"], zone.deviceId, 100) ||
      !isCode(zone.deviceId, 3, 100) ||
      !parseText(object["device_api_key"], zone.apiKey, 128) ||
      zone.apiKey.length() < 32) {
    return false;
  }

  String dhtKind;
  int dhtGpio = -1;
  if (!parseText(object["dht22"]["kind"], dhtKind, 16) ||
      dhtKind != "gpio" ||
      !parseInteger(object["dht22"]["gpio"], 0, 39, dhtGpio) ||
      !isDhtGpio(dhtGpio) ||
      !usedGpios.insert(dhtGpio).second) {
    return false;
  }
  zone.dhtGpio = static_cast<uint8_t>(dhtGpio);

  if (!parseAnalogChannel(object["mq2"].as<JsonObjectConst>(), zone.mq2, usedGpios, usedAdsChannels) ||
      !parseOutputChannel(object["fan"].as<JsonObjectConst>(), zone.fan, usedGpios, usedMcpChannels) ||
      !parseOutputChannel(object["led"].as<JsonObjectConst>(), zone.led, usedGpios, usedMcpChannels)) {
    return false;
  }

  JsonObjectConst thresholds = object["thresholds"].as<JsonObjectConst>();
  if (!parseNumber(thresholds["temperature_on_c"], -40.0f, 80.0f, zone.temperatureOnC) ||
      !parseNumber(thresholds["temperature_off_c"], -40.0f, 80.0f, zone.temperatureOffC) ||
      zone.temperatureOffC >= zone.temperatureOnC ||
      !parseNumber(thresholds["humidity_on_pct"], 0.0f, 100.0f, zone.humidityOnPercent) ||
      !parseNumber(thresholds["humidity_off_pct"], 0.0f, 100.0f, zone.humidityOffPercent) ||
      zone.humidityOffPercent >= zone.humidityOnPercent) {
    return false;
  }
  return true;
}

uint32_t zoneHash(const String& zoneId) {
  uint32_t hash = 2166136261UL;
  for (size_t index = 0; index < zoneId.length(); index++) {
    hash ^= static_cast<uint8_t>(zoneId[index]);
    hash *= 16777619UL;
  }
  return hash;
}

void makeStateKeys(ZoneRuntime& zone) {
  const uint32_t hash = zoneHash(zone.config.zoneId);
  snprintf(zone.fanStateKey, sizeof(zone.fanStateKey), "f%08lx", static_cast<unsigned long>(hash));
  snprintf(zone.faultStateKey, sizeof(zone.faultStateKey), "l%08lx", static_cast<unsigned long>(hash));
}

bool loadConfiguration() {
  File file = LittleFS.open(CONFIG_PATH, "r");
  if (!file) {
    Serial.println("Config missing: upload data/zones.json to LittleFS.");
    return false;
  }
  if (file.size() == 0 || file.size() > CONFIG_MAX_BYTES) {
    Serial.println("Config size is empty or exceeds the safe parser limit.");
    file.close();
    return false;
  }

  JsonDocument document;
  const DeserializationError parseError = deserializeJson(document, file);
  file.close();
  if (parseError) {
    Serial.printf("Config JSON parse failed: %s\n", parseError.c_str());
    return false;
  }

  JsonObjectConst root = document.as<JsonObjectConst>();
  if (!root["hardware_confirmed"].is<bool>()) return false;
  hardwareConfirmed = root["hardware_confirmed"].as<bool>();

  JsonObjectConst timing = root["timing"].as<JsonObjectConst>();
  int parsed = 0;
  if (parseInteger(timing["sample_interval_ms"], DHT_MIN_SAMPLE_INTERVAL_MS, 3600000, parsed)) {
    sampleIntervalMs = static_cast<uint32_t>(parsed);
  } else {
    Serial.println("Invalid timing.sample_interval_ms.");
    return false;
  }
  if (parseInteger(timing["min_fan_on_ms"], 0, 86400000, parsed)) {
    minFanOnMs = static_cast<uint32_t>(parsed);
  } else {
    Serial.println("Invalid timing.min_fan_on_ms.");
    return false;
  }
  if (parseInteger(timing["min_fan_off_ms"], 0, 86400000, parsed)) {
    minFanOffMs = static_cast<uint32_t>(parsed);
  } else {
    Serial.println("Invalid timing.min_fan_off_ms.");
    return false;
  }
  if (parseInteger(timing["sensor_fault_hold_ms"], 1000, 3600000, parsed)) {
    faultHoldMs = static_cast<uint32_t>(parsed);
  } else {
    Serial.println("Invalid timing.sensor_fault_hold_ms.");
    return false;
  }

  JsonObjectConst i2c = root["i2c"].as<JsonObjectConst>();
  if (!i2c.isNull()) {
    if (!parseInteger(i2c["sda_gpio"], 0, 39, parsed) || !isOutputGpio(parsed)) return false;
    i2cSdaGpio = static_cast<uint8_t>(parsed);
    if (!parseInteger(i2c["scl_gpio"], 0, 39, parsed) || !isOutputGpio(parsed)) return false;
    i2cSclGpio = static_cast<uint8_t>(parsed);
    if (i2cSdaGpio == i2cSclGpio) return false;
  }

  std::set<int> usedGpios;
  std::set<int> usedAdsChannels;
  std::set<int> usedMcpChannels;
  std::set<std::string> zoneIds;
  std::set<std::string> sensorCodes;
  std::set<std::string> deviceIds;

  JsonVariantConst outside = root["outside_air"];
  if (!outside.isNull()) {
    JsonObjectConst outsideObject = outside.as<JsonObjectConst>();
    String kind;
    int gpio = -1;
    if (!parseText(outsideObject["kind"], kind, 16) ||
        kind != "dht22_gpio" ||
        !parseInteger(outsideObject["gpio"], 0, 39, gpio) ||
        !claimGpio(usedGpios, gpio, true)) {
      Serial.println("outside_air must use a unique direct DHT22 GPIO.");
      return false;
    }
    outsideAirGpio = static_cast<uint8_t>(gpio);
    hasOutsideAirDht = true;
  }

  JsonArrayConst configuredZones = root["zones"].as<JsonArrayConst>();
  if (configuredZones.isNull() || configuredZones.size() == 0) {
    Serial.println("Config must contain at least one zone.");
    return false;
  }
  zones.reserve(configuredZones.size());
  for (JsonObjectConst zoneObject : configuredZones) {
    ZoneRuntime zone;
    if (!parseZone(zoneObject, zone.config, usedGpios, usedAdsChannels, usedMcpChannels)) {
      Serial.println("Invalid zone config or unsupported/duplicate hardware channel.");
      return false;
    }
    if (!zoneIds.insert(std::string(zone.config.zoneId.c_str())).second ||
        !sensorCodes.insert(std::string(zone.config.sensorCode.c_str())).second ||
        !deviceIds.insert(std::string(zone.config.deviceId.c_str())).second) {
      Serial.println("Zone IDs, sensor codes, and device IDs must be unique.");
      return false;
    }
    makeStateKeys(zone);
    zones.push_back(std::move(zone));
  }

  hasExpansionHardware = hasExpansionHardware || !usedAdsChannels.empty() || !usedMcpChannels.empty();
  if (hasExpansionHardware) {
    if (usedGpios.count(i2cSdaGpio) || usedGpios.count(i2cSclGpio)) {
      Serial.println("I2C GPIO conflicts with a configured sensor or output.");
      return false;
    }
  }
  return true;
}

uint8_t adsIndex(uint8_t address) {
  return static_cast<uint8_t>(address - 0x48);
}

uint8_t mcpIndex(uint8_t address) {
  return static_cast<uint8_t>(address - 0x20);
}

bool i2cDevicePresent(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission() == 0;
}

class FanControllerAdapter {
 public:
  bool begin(const OutputChannel& output, bool active) {
    const bool level = active ? output.activeHigh : !output.activeHigh;
    if (output.kind == OutputKind::Gpio) {
      digitalWrite(output.gpio, level ? HIGH : LOW);
      pinMode(output.gpio, OUTPUT);
      digitalWrite(output.gpio, level ? HIGH : LOW);
      return true;
    }
    if (!i2cDevicePresent(output.address)) return false;
    Adafruit_MCP23X17& device = mcpDevices[mcpIndex(output.address)];
    device.digitalWrite(output.channel, level ? HIGH : LOW);
    device.pinMode(output.channel, OUTPUT);
    device.digitalWrite(output.channel, level ? HIGH : LOW);
    return true;
  }

  bool set(const OutputChannel& output, bool active) {
    const bool level = active ? output.activeHigh : !output.activeHigh;
    if (output.kind == OutputKind::Gpio) {
      digitalWrite(output.gpio, level ? HIGH : LOW);
      return true;
    }
    if (!i2cDevicePresent(output.address)) return false;
    mcpDevices[mcpIndex(output.address)].digitalWrite(
        output.channel,
        level ? HIGH : LOW);
    return true;
  }
};

class Mq2SensorAdapter {
 public:
  bool readRaw(const AnalogChannel& channel, uint16_t& value) const {
    if (channel.kind == AnalogKind::Esp32Adc) {
      const int reading = analogRead(channel.gpio);
      if (reading < 0 || reading > 4095) return false;
      value = static_cast<uint16_t>(reading);
      return true;
    }

    if (!i2cDevicePresent(channel.address)) return false;
    const int16_t reading =
        adsDevices[adsIndex(channel.address)].readADC_SingleEnded(channel.channel);
    if (reading < 0) return false;
    const uint32_t normalized =
        (static_cast<uint32_t>(reading) * 4095U + 16383U) / 32767U;
    value = static_cast<uint16_t>(normalized > 4095U ? 4095U : normalized);
    return true;
  }
};

FanControllerAdapter fanController;
Mq2SensorAdapter mq2Sensor;

bool initializeHardware() {
  if (hasExpansionHardware) {
    Wire.begin(i2cSdaGpio, i2cSclGpio);
    Wire.setClock(100000);
  }

  for (const ZoneRuntime& zone : zones) {
    if (zone.config.mq2.kind == AnalogKind::Ads1115) {
      const uint8_t index = adsIndex(zone.config.mq2.address);
      if (!adsReady[index]) {
        if (!adsDevices[index].begin(zone.config.mq2.address, &Wire)) {
          Serial.printf("ADS1115 0x%02X did not initialize.\n", zone.config.mq2.address);
          return false;
        }
        adsDevices[index].setGain(GAIN_ONE);
        adsReady[index] = true;
      }
    }
    for (const OutputChannel* output : {&zone.config.fan, &zone.config.led}) {
      if (output->kind == OutputKind::Mcp23017) {
        const uint8_t index = mcpIndex(output->address);
        if (!mcpReady[index]) {
          if (!mcpDevices[index].begin_I2C(output->address, &Wire)) {
            Serial.printf("MCP23017 0x%02X did not initialize.\n", output->address);
            return false;
          }
          mcpReady[index] = true;
        }
      }
    }
  }

  if (hasOutsideAirDht) outsideAirDht.begin(outsideAirGpio);
  for (ZoneRuntime& zone : zones) {
    zone.dht.begin(zone.config.dhtGpio);
    if (!fanController.begin(zone.config.fan, false) ||
        !fanController.begin(zone.config.led, false)) {
      Serial.println("Could not initialize a configured output channel.");
      return false;
    }
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
  JsonDocument document;
  document["event"] = event;
  document["device_id"] = zones[zoneIndex].config.deviceId;
  document["sensor_id"] = zones[zoneIndex].config.sensorCode;
  document["fault_code"] = faultCode;
  if (!enqueueRequest(faultQueue, zoneIndex, "/api/v1/sensors/faults", document)) {
    Serial.printf("Could not queue fault event for zone %s.\n", zones[zoneIndex].config.zoneId.c_str());
  }
}

bool sendRequest(const PendingRequest& request) {
  if (request.zoneIndex >= zones.size() || WiFi.status() != WL_CONNECTED) return false;
  WiFiClientSecure tlsClient;
  tlsClient.setCACert(ROOT_CA_CERT);
  HTTPClient http;
  http.setConnectTimeout(5000);
  http.setTimeout(5000);
  const String url = String(GRAINGUARD_API_BASE_URL) + request.path;
  if (!http.begin(tlsClient, url)) return false;

  http.addHeader("Content-Type", "application/json");
  http.addHeader(
      "Authorization",
      String("Bearer ") + zones[request.zoneIndex].config.apiKey);
  const int statusCode = http.POST(
      reinterpret_cast<uint8_t*>(const_cast<char*>(request.body)),
      strlen(request.body));
  http.end();
  return statusCode >= 200 && statusCode < 300;
}

void networkTask(void*) {
  for (;;) {
    PendingRequest request;
    QueueHandle_t queue = nullptr;
    if (xQueueReceive(faultQueue, &request, 0) == pdTRUE) {
      queue = faultQueue;
    } else if (xQueueReceive(readingsQueue, &request, pdMS_TO_TICKS(250)) == pdTRUE) {
      queue = readingsQueue;
    }

    if (queue == nullptr) continue;
    while (!sendRequest(request)) {
      if (queue != faultQueue) {
        PendingRequest urgentFault;
        if (xQueueReceive(faultQueue, &urgentFault, 0) == pdTRUE) {
          while (!sendRequest(urgentFault)) {
            vTaskDelay(pdMS_TO_TICKS(5000));
          }
        }
      }
      vTaskDelay(pdMS_TO_TICKS(5000));
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
  document["fan_status"] = zone.fanOn;
  document["recorded_at"] = recordedAt;

  char messageId[128];
  snprintf(
      messageId,
      sizeof(messageId),
      "%s-%lu-%lu",
      zone.config.deviceId.c_str(),
      static_cast<unsigned long>(epochSeconds),
      static_cast<unsigned long>(messageCounter++));
  document["message_id"] = messageId;

  if (!enqueueRequest(readingsQueue, zoneIndex, "/api/v1/sensors/readings", document)) {
    Serial.printf("Reading queue full for zone %s; sample dropped.\n", zone.config.zoneId.c_str());
  }
}

bool setFanState(size_t zoneIndex, bool on, uint32_t now, bool ignoreMinimumInterval = false) {
  ZoneRuntime& zone = zones[zoneIndex];
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

void readOutsideAir(uint32_t now) {
  outsideHumidityValid = false;
  outsideHumidityPercent = NAN;
  if (!hasOutsideAirDht) return;
  if (outsideAirSampled && now - lastOutsideReadAt < sampleIntervalMs) return;
  lastOutsideReadAt = now;
  outsideAirSampled = true;
  float outsideTemperatureC = NAN;
  outsideHumidityValid = outsideAirDht.read(outsideTemperatureC, outsideHumidityPercent);
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

  zone.sampleValid =
      zone.temperatureValid &&
      zone.humidityValid &&
      zone.gasValid &&
      (!hasOutsideAirDht || outsideHumidityValid);
  if (!zone.sampleValid) {
    String faultCode = "ZONE_SENSOR_INVALID";
    if (!zone.temperatureValid || !zone.humidityValid) faultCode = "DHT22_INVALID";
    else if (!zone.gasValid) faultCode = "MQ2_ADC_UNAVAILABLE";
    else if (hasOutsideAirDht && !outsideHumidityValid) faultCode = "OUTSIDE_DHT22_INVALID";
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

  const bool humidityCanVentilate =
      hasOutsideAirDht &&
      outsideHumidityValid &&
      outsideHumidityPercent < zone.humidityPercent;
  zone.humidityDemand =
      humidityCanVentilate
          ? updateDemand(
                zone.humidityDemand,
                zone.humidityPercent,
                zone.config.humidityOnPercent,
                zone.config.humidityOffPercent)
          : false;

  const bool desiredFanOn = zone.temperatureDemand || zone.humidityDemand;
  const bool humidityInhibit =
      !zone.temperatureDemand &&
      zone.humidityDemand == false &&
      zone.fanOn &&
      hasOutsideAirDht &&
      outsideHumidityValid &&
      outsideHumidityPercent >= zone.humidityPercent;
  if (!setFanState(zoneIndex, desiredFanOn, now, humidityInhibit)) {
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
    Serial.printf("SENSOR_FAULT latched; fan forced OFF for zone %s.\n", zone.config.zoneId.c_str());
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
}

void maintainWifi(uint32_t now) {
  if (WiFi.status() == WL_CONNECTED || now < nextWifiAttemptAt) return;
  WiFi.disconnect();
  WiFi.begin(GRAINGUARD_WIFI_SSID, GRAINGUARD_WIFI_PASSWORD);
  nextWifiAttemptAt = now + 10000U;
}

void restoreZoneState(size_t zoneIndex) {
  ZoneRuntime& zone = zones[zoneIndex];
  zone.faultLatched = stateStore.getBool(zone.faultStateKey, false);
  zone.fanOn = hardwareConfirmed && !zone.faultLatched &&
               stateStore.getBool(zone.fanStateKey, false);
  fanController.begin(zone.config.fan, zone.fanOn);
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
  analogReadResolution(12);

  if (!LittleFS.begin(false)) {
    Serial.println("LittleFS mount failed; automatic control is disabled.");
    return;
  }
  if (!loadConfiguration()) {
    Serial.println("Configuration rejected; outputs remain at their hardware-safe defaults.");
    return;
  }
  if (!initializeHardware()) {
    Serial.println("Hardware initialization failed; check expansion devices and wiring.");
    return;
  }

  stateStore.begin("gg_zones", false);
  const UBaseType_t readingsQueueLength = static_cast<UBaseType_t>(zones.size() + 8);
  const UBaseType_t faultQueueLength = static_cast<UBaseType_t>((zones.size() * 2) + 8);
  readingsQueue = xQueueCreate(readingsQueueLength, sizeof(PendingRequest));
  faultQueue = xQueueCreate(faultQueueLength, sizeof(PendingRequest));
  if (readingsQueue == nullptr || faultQueue == nullptr) {
    Serial.println("Network queue allocation failed; firmware will not run.");
    return;
  }

  configurationValid = true;
  for (size_t index = 0; index < zones.size(); index++) restoreZoneState(index);
  beginWifi();
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  xTaskCreatePinnedToCore(networkTask, "gg-network", 8192, nullptr, 1, nullptr, 0);

  if (!hardwareConfirmed) {
    Serial.println("hardware_confirmed is false: sensors report, but all fan automation remains OFF.");
  }
  if (!hasOutsideAirDht) {
    Serial.println("No outside-air DHT22 configured: humidity-based ventilation is inhibited.");
  }
  Serial.printf("Loaded %u independently configured zones.\n", static_cast<unsigned>(zones.size()));
}

void loop() {
  if (!configurationValid) {
    delay(1000);
    return;
  }

  processSerialCommands();
  const uint32_t now = millis();
  maintainWifi(now);

  if (now >= nextSampleAt) {
    nextSampleAt = now + sampleIntervalMs;
    readOutsideAir(now);
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
