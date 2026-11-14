import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, "..", "src", "lib", "sensor-payload.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const validator = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const { getSensorReadingBounds, validateSensorReadingPayload } = validator;
const now = Date.parse("2026-11-14T10:30:00+06:00");
const validPayload = {
  device_id: "GG-ESP32-001",
  sensor_id: "GG-SENSOR-001",
  storage_unit_id: "123e4567-e89b-42d3-a456-426614174000",
  zone_id: "123e4567-e89b-42d3-a456-426614174001",
  temperature: 28.5,
  humidity: 72.4,
  gas_raw_value: 1250,
  fan_status: false,
  recorded_at: "2026-11-14T10:30:00+06:00",
  message_id: "message-001",
};

test("accepts a complete reading and preserves both timestamp forms", () => {
  const result = validateSensorReadingPayload(validPayload, now);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.recorded_at_raw, validPayload.recorded_at);
    assert.equal(result.value.recorded_at, "2026-11-14T04:30:00.000Z");
  }
});

test("accepts partial readings when a sensor value is missing", () => {
  const result = validateSensorReadingPayload({ ...validPayload, humidity: null }, now);
  assert.equal(result.ok, true);
});

test("rejects a payload with no measurements", () => {
  const result = validateSensorReadingPayload({
    ...validPayload,
    temperature: null,
    humidity: null,
    gas_raw_value: null,
    fan_status: null,
  }, now);
  assert.equal(result.ok, false);
});

test("rejects MQ-2 ADC values outside the ESP32 input range", () => {
  assert.equal(validateSensorReadingPayload({ ...validPayload, gas_raw_value: 4096 }, now).ok, false);
});

test("rejects timestamps without a timezone and timestamps too far in the future", () => {
  assert.equal(validateSensorReadingPayload({ ...validPayload, recorded_at: "2026-11-14T10:30:00" }, now).ok, false);
  assert.equal(validateSensorReadingPayload({ ...validPayload, recorded_at: "2026-11-14T10:36:00Z" }, now).ok, false);
});

test("enforces configured bounds and rejects invalid bound configuration", () => {
  const bounds = getSensorReadingBounds({
    SENSOR_TEMPERATURE_MIN_C: "0",
    SENSOR_TEMPERATURE_MAX_C: "30",
  });
  assert.ok(bounds);
  assert.equal(validateSensorReadingPayload({ ...validPayload, temperature: 31 }, now, bounds).ok, false);
  assert.equal(getSensorReadingBounds({
    SENSOR_TEMPERATURE_MIN_C: "30",
    SENSOR_TEMPERATURE_MAX_C: "0",
  }), null);
});
