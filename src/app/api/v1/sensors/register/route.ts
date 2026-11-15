import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { createServiceSupabaseClient, createUserSupabaseClient } from "@/lib/supabase/server";
import { parseSensorRegistrationInput } from "@/lib/supabase/sensor-registration";

type SensorDeviceRecord = {
  id: string;
  physical_device_id: string;
  device_name: string;
  storage_unit_id: string;
};

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

async function removeEmptyParentDevice(
  serviceClient: ReturnType<typeof createServiceSupabaseClient>,
  deviceRecordId: string
) {
  const { count, error: sensorLookupError } = await serviceClient
    .from("sensors")
    .select("id", { count: "exact", head: true })
    .eq("device_record_id", deviceRecordId);
  if (sensorLookupError) {
    console.error("Empty sensor device cleanup lookup failed.", {
      code: sensorLookupError.code,
    });
    return;
  }
  if (count === null) {
    console.error("Empty sensor device cleanup count was unavailable.");
    return;
  }
  if (count !== 0) return;

  const { error: deleteError } = await serviceClient
    .from("sensor_devices")
    .delete()
    .eq("id", deviceRecordId);
  if (deleteError) {
    console.error("Empty sensor device cleanup failed.", { code: deleteError.code });
  }
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

  const registration = parseSensorRegistrationInput(body);
  if (!registration) return jsonError(422, "INVALID_PAYLOAD");

  const serviceClient = createServiceSupabaseClient();
  const { data: unit, error: unitError } = await serviceClient
    .from("storage_units")
    .select("id")
    .eq("id", registration.storageUnitId)
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
    .eq("id", registration.zoneId)
    .eq("storage_unit_id", registration.storageUnitId)
    .maybeSingle();
  if (zoneError) {
    console.error("Sensor registration zone lookup failed.", { code: zoneError.code });
    return jsonError(500, "SENSOR_REGISTRATION_FAILED");
  }
  if (!zone) return jsonError(404, "STORAGE_ZONE_NOT_FOUND");

  let device: SensorDeviceRecord | null = null;
  let createdDevice = false;
  const { data: existingDevice, error: deviceLookupError } = await serviceClient
    .from("sensor_devices")
    .select("id, physical_device_id, device_name, storage_unit_id")
    .eq("user_id", userData.user.id)
    .eq("storage_unit_id", registration.storageUnitId)
    .eq("physical_device_id", registration.deviceId)
    .maybeSingle();
  if (deviceLookupError) {
    console.error("Sensor device lookup failed.", { code: deviceLookupError.code });
    return jsonError(500, "SENSOR_REGISTRATION_FAILED");
  }

  device = existingDevice;
  if (!device) {
    const { data: insertedDevice, error: deviceInsertError } = await serviceClient
      .from("sensor_devices")
      .insert({
        user_id: userData.user.id,
        storage_unit_id: registration.storageUnitId,
        physical_device_id: registration.deviceId,
        device_name: registration.deviceName,
        status: "active",
      })
      .select("id, physical_device_id, device_name, storage_unit_id")
      .single();

    if (deviceInsertError?.code === "23505") {
      const { data: racedDevice, error: racedLookupError } = await serviceClient
        .from("sensor_devices")
        .select("id, physical_device_id, device_name, storage_unit_id")
        .eq("user_id", userData.user.id)
        .eq("storage_unit_id", registration.storageUnitId)
        .eq("physical_device_id", registration.deviceId)
        .maybeSingle();
      if (racedLookupError || !racedDevice) {
        console.error("Concurrent sensor device lookup failed.", {
          code: racedLookupError?.code ?? deviceInsertError.code,
        });
        return jsonError(500, "SENSOR_REGISTRATION_FAILED");
      }
      device = racedDevice;
    } else if (deviceInsertError || !insertedDevice) {
      console.error("Sensor device registration failed.", {
        code: deviceInsertError?.code ?? "NO_DEVICE_RETURNED",
      });
      return jsonError(500, "SENSOR_REGISTRATION_FAILED");
    } else {
      device = insertedDevice;
      createdDevice = true;
    }
  }
  if (!device) return jsonError(500, "SENSOR_REGISTRATION_FAILED");

  const secret = randomBytes(32).toString("base64url");
  const apiKeyHash = createHash("sha256").update(secret, "utf8").digest("hex");
  const { data: sensor, error: sensorError } = await serviceClient
    .from("sensors")
    .insert({
      sensor_code: registration.sensorCode,
      storage_unit_id: registration.storageUnitId,
      zone_id: registration.zoneId,
      sensor_type: registration.sensorType,
      device_name: registration.deviceName,
      esp32_device_id: registration.deviceId,
      device_record_id: device.id,
      installation_location: registration.installationLocation,
      status: "pending",
    })
    .select("id, sensor_code, storage_unit_id, zone_id, esp32_device_id, device_record_id")
    .single();
  if (sensorError) {
    console.error("Sensor registration insert failed.", { code: sensorError.code });
    if (createdDevice) await removeEmptyParentDevice(serviceClient, device.id);
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
    if (createdDevice) await removeEmptyParentDevice(serviceClient, device.id);
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
    if (createdDevice) await removeEmptyParentDevice(serviceClient, device.id);
    return jsonError(500, "SENSOR_REGISTRATION_FAILED");
  }

  return NextResponse.json(
    {
      sensor: { ...sensor, status: "active" },
      device: {
        id: device.id,
        physical_device_id: device.physical_device_id,
        device_name: device.device_name,
        storage_unit_id: device.storage_unit_id,
      },
      device_api_key: secret,
      warning: "Store the device key securely; it is returned only once.",
    },
    { status: 201, headers: { "Cache-Control": "no-store" } }
  );
}
