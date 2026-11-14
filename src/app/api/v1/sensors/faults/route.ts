import { NextResponse } from "next/server";
import { authenticateSensorDevice } from "@/lib/supabase/authenticate-sensor-device";

const MAX_BODY_BYTES = 2048;
const faultCodePattern = /^[A-Z0-9_]{3,48}$/;

function jsonError(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: Request) {
  const authentication = await authenticateSensorDevice(request);
  if (!authentication.ok) return jsonError(authentication.status, authentication.error);

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) return jsonError(413, "PAYLOAD_TOO_LARGE");

  let body: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      return jsonError(413, "PAYLOAD_TOO_LARGE");
    }
    body = JSON.parse(text);
  } catch {
    return jsonError(400, "INVALID_JSON");
  }

  if (!isRecord(body)) return jsonError(422, "INVALID_PAYLOAD");
  const event = body.event;
  const deviceId = body.device_id;
  const sensorCode = body.sensor_id;
  const faultCode = body.fault_code;
  if (
    (event !== "fault" && event !== "recovered" && event !== "manual_reset") ||
    typeof deviceId !== "string" ||
    typeof sensorCode !== "string" ||
    typeof faultCode !== "string" ||
    !faultCodePattern.test(faultCode)
  ) {
    return jsonError(422, "INVALID_PAYLOAD");
  }

  const { serviceClient, sensor } = authentication;
  if (deviceId !== sensor.esp32_device_id || sensorCode !== sensor.sensor_code) {
    return jsonError(403, "DEVICE_SENSOR_MISMATCH");
  }

  if (event === "fault") {
    const { data: existingEvent, error: lookupError } = await serviceClient
      .from("sensor_fault_events")
      .select("id")
      .eq("sensor_id", sensor.id)
      .eq("fault_type", "SENSOR_FAULT")
      .eq("resolution_status", "open")
      .limit(1)
      .maybeSingle();
    if (lookupError) {
      console.error("Sensor fault lookup failed.", { code: lookupError.code });
      return jsonError(500, "SENSOR_FAULT_STORAGE_FAILED");
    }
    if (existingEvent) {
      return NextResponse.json({ status: "already_open", event_id: existingEvent.id });
    }

    const { data: fault, error: insertError } = await serviceClient
      .from("sensor_fault_events")
      .insert({
        sensor_id: sensor.id,
        zone_id: sensor.zone_id,
        fault_type: "SENSOR_FAULT",
        severity: "high",
        description: faultCode,
        detected_at: new Date().toISOString(),
      })
      .select("id, zone_id, detected_at, resolution_status")
      .single();
    if (insertError) {
      console.error("Sensor fault insert failed.", { code: insertError.code });
      return jsonError(500, "SENSOR_FAULT_STORAGE_FAILED");
    }
    return NextResponse.json({ status: "recorded", fault }, { status: 201 });
  }

  const resolutionReason =
    event === "manual_reset" ? "manual_inspection_reset" : "sensor_recovered";
  const { data: resolvedEvents, error: resolveError } = await serviceClient
    .from("sensor_fault_events")
    .update({
      resolution_status: "resolved",
      resolution_reason: resolutionReason,
      resolved_at: new Date().toISOString(),
    })
    .eq("sensor_id", sensor.id)
    .eq("fault_type", "SENSOR_FAULT")
    .eq("resolution_status", "open")
    .select("id, zone_id, resolution_status, resolution_reason, resolved_at");
  if (resolveError) {
    console.error("Sensor fault resolution failed.", { code: resolveError.code });
    return jsonError(500, "SENSOR_FAULT_RESOLUTION_FAILED");
  }

  return NextResponse.json({
    status: resolvedEvents.length > 0 ? "resolved" : "no_open_fault",
    events: resolvedEvents,
  });
}
