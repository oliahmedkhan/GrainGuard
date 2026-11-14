import { NextResponse } from "next/server";
import { getSensorReadingBounds, validateSensorReadingPayload } from "@/lib/sensor-payload";
import { authenticateSensorDevice } from "@/lib/supabase/authenticate-sensor-device";

type ServiceClient = ReturnType<typeof import("@/lib/supabase/server").createServiceSupabaseClient>;

const MAX_BODY_BYTES = 8192;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 60;
const rateLimits = new Map<string, { startedAt: number; count: number }>();

function jsonError(status: number, error: string, details?: string[]) {
  return NextResponse.json({ error, ...(details ? { details } : {}) }, { status });
}

function allowSensorRequest(sensorId: string, now: number): boolean {
  const current = rateLimits.get(sensorId);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    rateLimits.set(sensorId, { startedAt: now, count: 1 });
    if (rateLimits.size > 10_000) {
      for (const [id, entry] of rateLimits) {
        if (now - entry.startedAt >= RATE_WINDOW_MS) rateLimits.delete(id);
      }
    }
    return true;
  }
  current.count += 1;
  return current.count <= RATE_LIMIT;
}

async function logIngestionEvent(
  client: ServiceClient,
  sensorId: string,
  messageId: string | null,
  outcome: "REJECTED" | "DUPLICATE" | "FAILED",
  reasonCode: string
) {
  const { error } = await client.from("sensor_ingestion_events").insert({
    sensor_id: sensorId,
    message_id: messageId,
    outcome,
    reason_code: reasonCode,
  });
  if (error) {
    console.error("Sensor ingestion audit write failed.", { code: error.code });
  }
}

export async function POST(request: Request) {
  const authentication = await authenticateSensorDevice(request);
  if (!authentication.ok) return jsonError(authentication.status, authentication.error);
  const bounds = getSensorReadingBounds();
  if (!bounds) return jsonError(503, "SENSOR_VALIDATION_CONFIG_INVALID");
  const { serviceClient, sensor } = authentication;
  if (!allowSensorRequest(sensor.id, Date.now())) {
    await logIngestionEvent(serviceClient, sensor.id, null, "REJECTED", "RATE_LIMITED");
    return jsonError(429, "RATE_LIMITED");
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) return jsonError(413, "PAYLOAD_TOO_LARGE");

  let body: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      await logIngestionEvent(serviceClient, sensor.id, null, "REJECTED", "PAYLOAD_TOO_LARGE");
      return jsonError(413, "PAYLOAD_TOO_LARGE");
    }
    body = JSON.parse(text);
  } catch {
    await logIngestionEvent(serviceClient, sensor.id, null, "REJECTED", "INVALID_JSON");
    return jsonError(400, "INVALID_JSON");
  }

  const validation = validateSensorReadingPayload(body, Date.now(), bounds);
  if (!validation.ok) {
    const messageId =
      typeof body === "object" && body !== null && "message_id" in body &&
      typeof body.message_id === "string"
        ? body.message_id.slice(0, 128)
        : null;
    await logIngestionEvent(serviceClient, sensor.id, messageId, "REJECTED", "INVALID_PAYLOAD");
    return jsonError(422, "INVALID_PAYLOAD", validation.errors);
  }
  const payload = validation.value;

  if (
    payload.sensor_id !== sensor.sensor_code ||
    payload.device_id !== sensor.esp32_device_id
  ) {
    await logIngestionEvent(serviceClient, sensor.id, payload.message_id, "REJECTED", "DEVICE_SENSOR_MISMATCH");
    return jsonError(403, "DEVICE_SENSOR_MISMATCH");
  }
  if (
    payload.storage_unit_id !== sensor.storage_unit_id ||
    payload.zone_id !== sensor.zone_id
  ) {
    await logIngestionEvent(serviceClient, sensor.id, payload.message_id, "REJECTED", "SENSOR_LOCATION_MISMATCH");
    return jsonError(403, "SENSOR_LOCATION_MISMATCH");
  }
  const receivedAt = new Date().toISOString();
  const reading = {
    sensor_id: sensor.id,
    storage_unit_id: sensor.storage_unit_id,
    zone_id: sensor.zone_id,
    message_id: payload.message_id,
    temperature: payload.temperature,
    humidity: payload.humidity,
    gas_raw_value: payload.gas_raw_value,
    fan_status: payload.fan_status,
    voltage: payload.voltage,
    current: payload.current,
    power: payload.power,
    recorded_at: payload.recorded_at,
    recorded_at_raw: payload.recorded_at_raw,
    received_at: receivedAt,
    data_quality_status:
      payload.temperature === null ||
      payload.humidity === null ||
      payload.gas_raw_value === null
        ? "PARTIAL"
        : "VALID",
    is_valid: true,
  };

  const { data, error } = await serviceClient
    .from("sensor_readings")
    .insert(reading)
    .select("id, recorded_at, received_at")
    .single();
  if (error?.code === "23505") {
    await logIngestionEvent(serviceClient, sensor.id, payload.message_id, "DUPLICATE", "DUPLICATE_MESSAGE_ID");
    return jsonError(409, "DUPLICATE_MESSAGE_ID");
  }
  if (error) {
    console.error("Sensor reading insert failed.", { code: error.code });
    await logIngestionEvent(serviceClient, sensor.id, payload.message_id, "FAILED", "DATABASE_WRITE_FAILED");
    return jsonError(500, "READING_STORAGE_FAILED");
  }

  return NextResponse.json(
    { status: "accepted", reading_id: data.id, recorded_at: data.recorded_at, received_at: data.received_at },
    { status: 201 }
  );
}
