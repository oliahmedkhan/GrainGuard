import { createHash, randomBytes } from "node:crypto";

const sensorRecordIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidSensorRecordId(value: string): boolean {
  return sensorRecordIdPattern.test(value);
}

export function canRotateSensorCredential(
  authenticatedUserId: string,
  storageUnitOwnerId: string,
  profileRole: string | null
): boolean {
  return authenticatedUserId === storageUnitOwnerId || profileRole === "admin";
}

export function createDeviceApiCredential(): { key: string; hash: string } {
  const key = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(key, "utf8").digest("hex");
  return { key, hash };
}
