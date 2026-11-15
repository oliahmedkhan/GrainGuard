import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(
  directory,
  "..",
  "src",
  "lib",
  "supabase",
  "sensor-credential-rotation.ts"
);
const source = readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const rotation = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

test("accepts only valid UUID sensor record identifiers", () => {
  assert.equal(rotation.isValidSensorRecordId("123e4567-e89b-42d3-a456-426614174000"), true);
  assert.equal(rotation.isValidSensorRecordId("not-a-sensor-id"), false);
  assert.equal(rotation.isValidSensorRecordId("00000000-0000-0000-0000-000000000000"), false);
});

test("permits the storage owner and an admin, but not unrelated users", () => {
  assert.equal(rotation.canRotateSensorCredential("owner", "owner", "farmer"), true);
  assert.equal(rotation.canRotateSensorCredential("admin", "owner", "admin"), true);
  assert.equal(rotation.canRotateSensorCredential("other", "owner", "researcher"), false);
  assert.equal(rotation.canRotateSensorCredential("other", "owner", null), false);
});

test("generates a high-entropy API key and a matching SHA-256 hash", () => {
  const first = rotation.createDeviceApiCredential();
  const second = rotation.createDeviceApiCredential();

  assert.match(first.key, /^[A-Za-z0-9_-]{43}$/);
  assert.match(first.hash, /^[0-9a-f]{64}$/);
  assert.equal(
    first.hash,
    createHash("sha256").update(first.key, "utf8").digest("hex")
  );
  assert.notEqual(first.key, second.key);
  assert.notEqual(first.hash, second.hash);
});
