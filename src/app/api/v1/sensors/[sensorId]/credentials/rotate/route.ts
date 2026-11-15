import { NextResponse } from "next/server";
import {
  canRotateSensorCredential,
  createDeviceApiCredential,
  isValidSensorRecordId,
} from "@/lib/supabase/sensor-credential-rotation";
import { createServiceSupabaseClient, createUserSupabaseClient } from "@/lib/supabase/server";

function jsonError(status: number, error: string) {
  return NextResponse.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7).trim();
  return token.length > 32 && token.length < 4096 ? token : null;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ sensorId: string }> }
) {
  const accessToken = bearerToken(request);
  if (!accessToken) return jsonError(401, "USER_AUTH_REQUIRED");

  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    return jsonError(503, "SENSOR_CREDENTIAL_ROTATION_NOT_CONFIGURED");
  }

  const { sensorId } = await context.params;
  if (!isValidSensorRecordId(sensorId)) {
    return jsonError(400, "INVALID_SENSOR_ID");
  }

  const userClient = createUserSupabaseClient(accessToken);
  const { data: userData, error: userError } = await userClient.auth.getUser(accessToken);
  if (userError || !userData.user) return jsonError(401, "INVALID_USER_SESSION");

  const serviceClient = createServiceSupabaseClient();
  const { data: sensor, error: sensorError } = await serviceClient
    .from("sensors")
    .select("id, sensor_code, storage_unit_id, zone_id, esp32_device_id")
    .eq("id", sensorId)
    .maybeSingle();
  if (sensorError) {
    console.error("Sensor credential rotation sensor lookup failed.", {
      code: sensorError.code,
    });
    return jsonError(500, "SENSOR_CREDENTIAL_ROTATION_FAILED");
  }
  if (!sensor) return jsonError(404, "SENSOR_NOT_FOUND_OR_FORBIDDEN");

  const [unitResult, zoneResult, profileResult] = await Promise.all([
    serviceClient
      .from("storage_units")
      .select("id, user_id")
      .eq("id", sensor.storage_unit_id)
      .maybeSingle(),
    serviceClient
      .from("storage_zones")
      .select("id, storage_unit_id")
      .eq("id", sensor.zone_id)
      .maybeSingle(),
    userClient
      .from("profiles")
      .select("role")
      .eq("id", userData.user.id)
      .maybeSingle(),
  ]);

  if (unitResult.error || zoneResult.error || profileResult.error) {
    const errorCode =
      unitResult.error?.code ?? zoneResult.error?.code ?? profileResult.error?.code;
    console.error("Sensor credential rotation authorization lookup failed.", {
      code: errorCode,
    });
    return jsonError(500, "SENSOR_CREDENTIAL_ROTATION_FAILED");
  }

  const unit = unitResult.data;
  const zone = zoneResult.data;
  if (
    !unit ||
    !zone ||
    sensor.storage_unit_id !== unit.id ||
    sensor.zone_id !== zone.id ||
    zone.storage_unit_id !== unit.id
  ) {
    console.error("Sensor credential rotation found an invalid sensor location relationship.");
    return jsonError(409, "SENSOR_LOCATION_RELATIONSHIP_INVALID");
  }

  if (
    !canRotateSensorCredential(
      userData.user.id,
      unit.user_id,
      profileResult.data?.role ?? null
    )
  ) {
    return jsonError(404, "SENSOR_NOT_FOUND_OR_FORBIDDEN");
  }

  const { data: existingCredential, error: credentialLookupError } = await serviceClient
    .from("sensor_device_credentials")
    .select("api_key_hash")
    .eq("sensor_id", sensor.id)
    .maybeSingle();

  if (credentialLookupError) {
    console.error("Sensor credential rotation credential lookup failed.", {
      code: credentialLookupError.code,
    });
    return jsonError(500, "SENSOR_CREDENTIAL_ROTATION_FAILED");
  }
  if (!existingCredential) {
    return jsonError(409, "DEVICE_CREDENTIAL_NOT_FOUND");
  }

  const credential = createDeviceApiCredential();
  const { data: updatedCredential, error: updateError } = await serviceClient
    .from("sensor_device_credentials")
    .update({
      api_key_hash: credential.hash,
      rotated_at: new Date().toISOString(),
    })
    .eq("sensor_id", sensor.id)
    .eq("api_key_hash", existingCredential.api_key_hash)
    .select("sensor_id")
    .maybeSingle();

  if (updateError) {
    console.error("Sensor credential rotation update failed.", { code: updateError.code });
    return jsonError(500, "SENSOR_CREDENTIAL_ROTATION_FAILED");
  }
  if (!updatedCredential) {
    return jsonError(409, "DEVICE_CREDENTIAL_CHANGED_RETRY");
  }

  return NextResponse.json(
    {
      sensor: {
        id: sensor.id,
        sensor_code: sensor.sensor_code,
        storage_unit_id: sensor.storage_unit_id,
        zone_id: sensor.zone_id,
        esp32_device_id: sensor.esp32_device_id,
      },
      device_api_key: credential.key,
      warning: "Store this device key securely; it is returned only once.",
    },
    { status: 200, headers: { "Cache-Control": "no-store" } }
  );
}
