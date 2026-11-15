import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const firmwarePath = path.join(
  root,
  "examples",
  "esp32",
  "GrainGuardMultiZone",
  "GrainGuardMultiZone.ino"
);
const configExamplePath = path.join(
  root,
  "examples",
  "esp32",
  "GrainGuardMultiZone",
  "grainguard_config.example.h"
);
const secretsExamplePath = path.join(
  root,
  "examples",
  "esp32",
  "GrainGuardMultiZone",
  "grainguard_secrets.example.h"
);

const firmware = readFileSync(firmwarePath, "utf8");
const configExample = readFileSync(configExamplePath, "utf8");
const secretsExample = readFileSync(secretsExamplePath, "utf8");

test("the compiled firmware uses the exact three-zone GPIO map without conflicts", () => {
  const hardwareBlock = firmware.match(
    /constexpr ZoneHardware HARDWARE\[ZONE_COUNT\] = \{([\s\S]*?)\};/
  );
  assert.ok(hardwareBlock, "fixed zone hardware map must exist");

  const mappings = [...hardwareBlock[1].matchAll(/\{(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\}/g)]
    .map((match) => match.slice(1).map(Number));
  assert.deepEqual(mappings, [
    [4, 34, 18, 25],
    [16, 35, 19, 26],
    [17, 32, 21, 27],
  ]);
  const pins = mappings.flat();
  assert.equal(new Set(pins).size, pins.length, "all sensor and output pins must be unique");
  assert.ok([34, 35, 32].every((pin) => [32, 33, 34, 35, 36, 39].includes(pin)));
});

test("firmware has no runtime filesystem dependency and validates local registrations", () => {
  assert.match(firmware, /#include "grainguard_config\.h"/);
  assert.match(firmware, /#include "grainguard_config\.example\.h"/);
  assert.doesNotMatch(firmware, /LittleFS|zones\.json/);
  assert.match(firmware, /validZoneRegistration/);
  assert.match(firmware, /hasConflictingRegistration/);
  assert.match(firmware, /GRAINGUARD_SENSOR_FAULT_HOLD_MS/);
});

test("three zone registrations share one physical device identity", () => {
  const conflictCheck = firmware.match(
    /bool hasConflictingRegistration\(size_t index\) \{([\s\S]*?)\n\}/
  );
  assert.ok(conflictCheck, "registration conflict validation must exist");
  assert.match(
    conflictCheck[1],
    /strcmp\(PROVISIONING\[index\]\.deviceId,\s*PROVISIONING\[other\]\.deviceId\) != 0/
  );
  assert.match(
    conflictCheck[1],
    /strcmp\(PROVISIONING\[index\]\.sensorCode,\s*PROVISIONING\[other\]\.sensorCode\) == 0/
  );
  assert.match(
    conflictCheck[1],
    /strcmp\(PROVISIONING\[index\]\.apiKey,\s*PROVISIONING\[other\]\.apiKey\) == 0/
  );
  assert.doesNotMatch(
    conflictCheck[1],
    /strcmp\(PROVISIONING\[index\]\.deviceId,\s*PROVISIONING\[other\]\.deviceId\) == 0/
  );
});

test("configuration templates contain only blank identities and safe placeholders", () => {
  for (const zone of [1, 2, 3]) {
    for (const field of [
      "ZONE_ID",
      "STORAGE_UNIT_ID",
      "SENSOR_CODE",
      "DEVICE_ID",
      "DEVICE_API_KEY",
    ]) {
      assert.match(
        configExample,
        new RegExp(`#define GRAINGUARD_ZONE_${zone}_${field} ""`)
      );
    }
  }
  assert.match(secretsExample, /your-wifi-ssid/);
  assert.match(secretsExample, /your-wifi-password/);
  assert.match(secretsExample, /REPLACE_WITH_TRUSTED_ROOT_CA_CERTIFICATE/);
  assert.doesNotMatch(secretsExample, /-----BEGIN CERTIFICATE-----/);
});

test("readings preserve the registered sensor code and TLS certificate validation", () => {
  assert.match(firmware, /document\["sensor_id"\]\s*=\s*zone\.config\.sensorCode/);
  assert.match(firmware, /String\("Bearer "\)\s*\+\s*zones\[request\.zoneIndex\]\.config\.apiKey/);
  assert.match(firmware, /tlsClient\.setCACert\(ROOT_CA_CERT\)/);
  assert.doesNotMatch(firmware, /setInsecure\s*\(/);
  for (const key of ["device_id", "sensor_id", "storage_unit_id", "zone_id", "recorded_at", "message_id", "fan_status"]) {
    assert.match(firmware, new RegExp(`document\\["${key}"\\]`));
  }
});
