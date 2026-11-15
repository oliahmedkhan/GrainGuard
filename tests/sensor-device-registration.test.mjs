import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperPath = path.join(root, "src", "lib", "supabase", "sensor-registration.ts");
const migrationPath = path.join(
  root,
  "supabase",
  "migrations",
  "202611150001_sensor_devices.sql"
);
const helperSource = readFileSync(helperPath, "utf8");
const migration = readFileSync(migrationPath, "utf8");
const compiled = ts.transpileModule(helperSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const registration = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

const unitId = "123e4567-e89b-42d3-a456-426614174000";
const zoneIds = [
  "123e4567-e89b-42d3-a456-426614174001",
  "123e4567-e89b-42d3-a456-426614174002",
  "123e4567-e89b-42d3-a456-426614174003",
];

test("per-zone registrations allow one shared physical device identity", () => {
  const parsed = zoneIds.map((zoneId, index) => registration.parseSensorRegistrationInput({
    storage_unit_id: unitId,
    zone_id: zoneId,
    sensor_code: `SENSOR_ZONE_${index + 1}`,
    sensor_type: "DHT22-MQ2",
    esp32_device_id: "ESP32-PHYSICAL-01",
    device_name: "Three zone ESP32",
  }));

  assert.ok(parsed.every(Boolean));
  assert.deepEqual(parsed.map((item) => item.deviceId), [
    "ESP32-PHYSICAL-01",
    "ESP32-PHYSICAL-01",
    "ESP32-PHYSICAL-01",
  ]);
  assert.equal(new Set(parsed.map((item) => item.zoneId)).size, 3);
  assert.equal(new Set(parsed.map((item) => item.sensorCode)).size, 3);
});

test("registration validation rejects invalid database IDs and unsupported identifiers", () => {
  const validInput = {
    storage_unit_id: unitId,
    zone_id: zoneIds[0],
    sensor_code: "SENSOR_ZONE_1",
    sensor_type: "DHT22-MQ2",
    esp32_device_id: "ESP32-PHYSICAL-01",
  };

  assert.equal(registration.parseSensorRegistrationInput(validInput)?.deviceName, "ESP32-PHYSICAL-01");
  assert.equal(
    registration.parseSensorRegistrationInput({ ...validInput, zone_id: "local-zone-1" }),
    null
  );
  assert.equal(
    registration.parseSensorRegistrationInput({ ...validInput, esp32_device_id: "01" }),
    null
  );
  assert.equal(
    registration.parseSensorRegistrationInput({ ...validInput, device_name: " " }),
    null
  );
});

test("parent-device migration backfills sensors and enforces owner-scoped relationships", () => {
  assert.match(migration, /create table public\.sensor_devices/);
  assert.match(migration, /insert into public\.sensor_devices[\s\S]*from public\.sensors/);
  assert.match(migration, /add column device_record_id uuid/);
  assert.match(migration, /foreign key \(device_record_id, storage_unit_id, esp32_device_id\)/);
  assert.match(migration, /alter table public\.sensor_devices enable row level security/);
  assert.match(migration, /create policy "Owners read sensor devices"/);
  assert.match(migration, /grant select on public\.sensor_devices to authenticated/);
  assert.match(migration, /grant all on public\.sensor_devices to service_role/);
});
