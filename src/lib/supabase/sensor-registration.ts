const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SensorRegistrationInput = {
  storageUnitId: string;
  zoneId: string;
  sensorCode: string;
  deviceId: string;
  sensorType: string;
  deviceName: string;
  installationLocation: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSensorRegistrationInput(value: unknown): SensorRegistrationInput | null {
  if (!isRecord(value)) return null;

  const storageUnitId = value.storage_unit_id;
  const zoneId = value.zone_id;
  const sensorCode = value.sensor_code;
  const deviceId = value.esp32_device_id;
  const sensorType = value.sensor_type;
  const deviceName = value.device_name;
  const installationLocation = value.installation_location;

  if (
    typeof storageUnitId !== "string" ||
    !uuidPattern.test(storageUnitId) ||
    typeof zoneId !== "string" ||
    !uuidPattern.test(zoneId) ||
    typeof sensorCode !== "string" ||
    !/^[A-Za-z0-9._-]{3,64}$/.test(sensorCode) ||
    typeof deviceId !== "string" ||
    !/^[A-Za-z0-9._-]{3,100}$/.test(deviceId) ||
    typeof sensorType !== "string" ||
    !/^[A-Za-z0-9._-]{2,64}$/.test(sensorType) ||
    (deviceName !== undefined &&
      (typeof deviceName !== "string" || deviceName.trim().length < 1 || deviceName.length > 100)) ||
    (installationLocation !== undefined &&
      installationLocation !== null &&
      (typeof installationLocation !== "string" || installationLocation.length > 200))
  ) {
    return null;
  }

  return {
    storageUnitId,
    zoneId,
    sensorCode,
    deviceId,
    sensorType,
    deviceName: typeof deviceName === "string" ? deviceName.trim() : deviceId,
    installationLocation:
      typeof installationLocation === "string" ? installationLocation.trim().slice(0, 200) || null : null,
  };
}
