import { createHash } from "node:crypto";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

export type AuthenticatedSensor = {
  id: string;
  sensor_code: string;
  storage_unit_id: string;
  zone_id: string;
  esp32_device_id: string;
  status: string;
};

export type SensorAuthenticationResult =
  | {
      ok: true;
      serviceClient: ReturnType<typeof createServiceSupabaseClient>;
      sensor: AuthenticatedSensor;
    }
  | { ok: false; status: number; error: string };

function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7).trim();
  return token.length >= 32 && token.length <= 512 ? token : null;
}

export async function authenticateSensorDevice(
  request: Request
): Promise<SensorAuthenticationResult> {
  const token = getBearerToken(request);
  if (!token) return { ok: false, status: 401, error: "DEVICE_AUTH_REQUIRED" };

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, status: 503, error: "SENSOR_INGESTION_NOT_CONFIGURED" };
  }

  const serviceClient = createServiceSupabaseClient();
  const apiKeyHash = createHash("sha256").update(token, "utf8").digest("hex");
  const { data: credential, error: credentialError } = await serviceClient
    .from("sensor_device_credentials")
    .select("sensor_id")
    .eq("api_key_hash", apiKeyHash)
    .maybeSingle();
  if (credentialError) {
    console.error("Sensor credential lookup failed.", { code: credentialError.code });
    return { ok: false, status: 500, error: "SENSOR_AUTHENTICATION_FAILED" };
  }
  if (!credential) return { ok: false, status: 401, error: "INVALID_DEVICE_CREDENTIALS" };

  const { data: sensor, error: sensorError } = await serviceClient
    .from("sensors")
    .select("id, sensor_code, storage_unit_id, zone_id, esp32_device_id, status")
    .eq("id", credential.sensor_id)
    .maybeSingle();
  if (sensorError) {
    console.error("Sensor registration lookup failed.", { code: sensorError.code });
    return { ok: false, status: 500, error: "SENSOR_AUTHENTICATION_FAILED" };
  }
  if (!sensor || sensor.status !== "active") {
    return { ok: false, status: 401, error: "SENSOR_NOT_ACTIVE" };
  }

  return {
    ok: true,
    serviceClient,
    sensor: sensor as AuthenticatedSensor,
  };
}
