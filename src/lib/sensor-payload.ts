export type SensorReadingPayload = {
  device_id: string;
  sensor_id: string;
  storage_unit_id: string;
  zone_id: string;
  temperature: number | null;
  humidity: number | null;
  gas_raw_value: number | null;
  fan_status: boolean | null;
  voltage: number | null;
  current: number | null;
  power: number | null;
  recorded_at: string;
  recorded_at_raw: string;
  message_id: string;
};

export type PayloadValidation =
  | { ok: true; value: SensorReadingPayload }
  | { ok: false; errors: string[] };

export type SensorReadingBounds = {
  temperatureMin: number;
  temperatureMax: number;
  humidityMin: number;
  humidityMax: number;
  gasRawMax: number;
};

const defaultBounds: SensorReadingBounds = {
  temperatureMin: -40,
  temperatureMax: 80,
  humidityMin: 0,
  humidityMax: 100,
  gasRawMax: 4095,
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timestampWithZonePattern = /(?:Z|[+-]\d{2}:\d{2})$/i;

export function getSensorReadingBounds(
  env: Record<string, string | undefined> = process.env
): SensorReadingBounds | null {
  const configuredNumber = (name: string, fallback: number) => {
    const value = env[name];
    return value === undefined || value.trim() === "" ? fallback : Number(value);
  };
  const temperatureMin = configuredNumber("SENSOR_TEMPERATURE_MIN_C", defaultBounds.temperatureMin);
  const temperatureMax = configuredNumber("SENSOR_TEMPERATURE_MAX_C", defaultBounds.temperatureMax);
  const humidityMin = configuredNumber("SENSOR_HUMIDITY_MIN_PERCENT", defaultBounds.humidityMin);
  const humidityMax = configuredNumber("SENSOR_HUMIDITY_MAX_PERCENT", defaultBounds.humidityMax);
  const gasRawMax = configuredNumber("SENSOR_GAS_RAW_MAX", defaultBounds.gasRawMax);
  if (
    !Number.isFinite(temperatureMin) ||
    !Number.isFinite(temperatureMax) ||
    temperatureMin < defaultBounds.temperatureMin ||
    temperatureMax > defaultBounds.temperatureMax ||
    temperatureMin > temperatureMax ||
    !Number.isFinite(humidityMin) ||
    !Number.isFinite(humidityMax) ||
    humidityMin < defaultBounds.humidityMin ||
    humidityMax > defaultBounds.humidityMax ||
    humidityMin > humidityMax ||
    !Number.isInteger(gasRawMax) ||
    gasRawMax < 0 ||
    gasRawMax > defaultBounds.gasRawMax
  ) {
    return null;
  }
  return { temperatureMin, temperatureMax, humidityMin, humidityMax, gasRawMax };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(
  body: Record<string, unknown>,
  key: string,
  maxLength: number,
  errors: string[]
): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maxLength) {
    errors.push(`${key} must be a non-empty string of at most ${maxLength} characters.`);
    return "";
  }
  return value.trim();
}

function optionalNumber(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  errors: string[],
  integer = false
): number | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    errors.push(`${key} is outside the allowed numeric range.`);
    return null;
  }
  return value;
}

export function validateSensorReadingPayload(
  input: unknown,
  now = Date.now(),
  bounds: SensorReadingBounds = defaultBounds
): PayloadValidation {
  if (!isRecord(input)) {
    return { ok: false, errors: ["Request body must be a JSON object."] };
  }

  const errors: string[] = [];
  const deviceId = requiredText(input, "device_id", 100, errors);
  const sensorId = requiredText(input, "sensor_id", 100, errors);
  const storageUnitId = requiredText(input, "storage_unit_id", 36, errors);
  const zoneId = requiredText(input, "zone_id", 36, errors);
  const messageId = requiredText(input, "message_id", 128, errors);

  if (storageUnitId && !uuidPattern.test(storageUnitId)) errors.push("storage_unit_id must be a UUID.");
  if (zoneId && !uuidPattern.test(zoneId)) errors.push("zone_id must be a UUID.");

  const temperature = optionalNumber(input, "temperature", bounds.temperatureMin, bounds.temperatureMax, errors);
  const humidity = optionalNumber(input, "humidity", bounds.humidityMin, bounds.humidityMax, errors);
  const gasRawValue = optionalNumber(input, "gas_raw_value", 0, bounds.gasRawMax, errors, true);
  const voltage = optionalNumber(input, "voltage", 0, 1000, errors);
  const current = optionalNumber(input, "current", 0, 10000, errors);
  const power = optionalNumber(input, "power", 0, 100000, errors);
  const fanStatusInput = input.fan_status;
  let fanStatus: boolean | null = null;
  if (fanStatusInput !== undefined && fanStatusInput !== null) {
    if (typeof fanStatusInput !== "boolean") {
      errors.push("fan_status must be a boolean.");
    } else {
      fanStatus = fanStatusInput;
    }
  }

  const recordedAtInput = input.recorded_at;
  const recordedAt = typeof recordedAtInput === "string" ? recordedAtInput : "";
  if (recordedAt.length === 0 || recordedAt.length > 64) {
    errors.push("recorded_at must be a non-empty timestamp of at most 64 characters.");
  }
  if (recordedAt.length > 0) {
    if (!timestampWithZonePattern.test(recordedAt) || !Number.isFinite(Date.parse(recordedAt))) {
      errors.push("recorded_at must be an ISO 8601 timestamp with a timezone.");
    } else if (Date.parse(recordedAt) > now + 5 * 60 * 1000) {
      errors.push("recorded_at cannot be more than five minutes in the future.");
    }
  }

  if (
    temperature === null &&
    humidity === null &&
    gasRawValue === null &&
    fanStatus === null
  ) {
    errors.push("At least one sensor measurement must be supplied.");
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      device_id: deviceId,
      sensor_id: sensorId,
      storage_unit_id: storageUnitId,
      zone_id: zoneId,
      temperature,
      humidity,
      gas_raw_value: gasRawValue,
      fan_status: fanStatus,
      voltage,
      current,
      power,
      recorded_at: new Date(recordedAt).toISOString(),
      recorded_at_raw: recordedAt,
      message_id: messageId,
    },
  };
}
