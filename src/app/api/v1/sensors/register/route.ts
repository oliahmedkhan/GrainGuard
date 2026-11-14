import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { createServiceSupabaseClient, createUserSupabaseClient } from "@/lib/supabase/server";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonError(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7).trim();
  return token.length > 32 && token.length < 4096 ? token : null;
}

export async function POST(request: Request) {
  const accessToken = bearerToken(request);
  if (!accessToken) return jsonError(401, "USER_AUTH_REQUIRED");

  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    return jsonError(503, "SENSOR_REGISTRATION_NOT_CONFIGURED");
  }

  const userClient = createUserSupabaseClient(accessToken);
  const { data: userData, error: userError } = await userClient.auth.getUser(accessToken);
  if (userError || !userData.user) return jsonError(401, "INVALID_USER_SESSION");

  let body: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 4096) {
      return jsonError(413, "PAYLOAD_TOO_LARGE");
    }
    body = JSON.parse(text);
  } catch {
    return jsonError(400, "INVALID_JSON");
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonError(422, "INVALID_PAYLOAD");
  }
  const input = body as Record<string, unknown>;
  const storageUnitId = input.storage_unit_id;
  const zoneId = input.zone_id;
  const sensorCode = input.sensor_code;
  const deviceId = input.esp32_device_id;
  const sensorType = input.sensor_type;
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
    !/^[A-Za-z0-9._-]{2,64}$/.test(sensorType)
  ) {
    return jsonError(422, "INVALID_PAYLOAD");
  }

  const serviceClient = createServiceSupabaseClient();
  const { data: unit, error: unitError } = await serviceClient
    .from("storage_units")
    .select("id")
    .eq("id", storageUnitId)
    .eq("user_id", userData.user.id)
    .maybeSingle();
  if (unitError) {
    console.error("Sensor registration storage lookup failed.", { code: unitError.code });
    return jsonError(500, "SENSOR_REGISTRATION_FAILED");
  }
  if (!unit) return jsonError(404, "STORAGE_UNIT_NOT_FOUND");

  const { data: zone, error: zoneError } = await serviceClient
    .from("storage_zones")
    .select("id")
    .eq("id", zoneId)
    .eq("storage_unit_id", storageUnitId)
    .maybeSingle();
  if (zoneError) {
    console.error("Sensor registration zone lookup failed.", { code: zoneError.code });
    return jsonError(500, "SENSOR_REGISTRATION_FAILED");
  }
  if (!zone) return jsonError(404, "STORAGE_ZONE_NOT_FOUND");

  const secret = randomBytes(32).toString("base64url");
  const apiKeyHash = createHash("sha256").update(secret, "utf8").digest("hex");
  const { data: sensor, error: sensorError } = await serviceClient
    .from("sensors")
    .insert({
      sensor_code: sensorCode,
      storage_unit_id: storageUnitId,
      zone_id: zoneId,
      sensor_type: sensorType,
      device_name: typeof input.device_name === "string" ? input.device_name.slice(0, 100) : null,
      esp32_device_id: deviceId,
      installation_location:
        typeof input.installation_location === "string"
          ? input.installation_location.slice(0, 200)
          : null,
      status: "pending",
    })
    .select("id, sensor_code, storage_unit_id, zone_id, esp32_device_id")
    .single();
  if (sensorError) {
    console.error("Sensor registration insert failed.", { code: sensorError.code });
    return jsonError(sensorError.code === "23505" ? 409 : 500, "SENSOR_REGISTRATION_FAILED");
  }

  const { error: credentialError } = await serviceClient
    .from("sensor_device_credentials")
    .insert({ sensor_id: sensor.id, api_key_hash: apiKeyHash });
  if (credentialError) {
    console.error("Sensor credential provisioning failed.", { code: credentialError.code });
    const { error: cleanupError } = await serviceClient
      .from("sensors")
      .delete()
      .eq("id", sensor.id);
    if (cleanupError) {
      console.error("Incomplete sensor registration cleanup failed.", { code: cleanupError.code });
    }
    return jsonError(500, "SENSOR_REGISTRATION_FAILED");
  }

  const { error: activateError } = await serviceClient
    .from("sensors")
    .update({ status: "active", updated_at: new Date().toISOString() })
    .eq("id", sensor.id);
  if (activateError) {
    console.error("Sensor activation failed.", { code: activateError.code });
    const { error: cleanupError } = await serviceClient
      .from("sensors")
      .delete()
      .eq("id", sensor.id);
    if (cleanupError) {
      console.error("Incomplete sensor registration cleanup failed.", { code: cleanupError.code });
    }
    return jsonError(500, "SENSOR_REGISTRATION_FAILED");
  }

  return NextResponse.json(
    {
      sensor: { ...sensor, status: "active" },
      device_api_key: secret,
      warning: "Store the device key securely; it is returned only once.",
    },
    { status: 201 }
  );
}
