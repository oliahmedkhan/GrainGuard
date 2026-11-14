import { NextResponse } from "next/server";
import { createUserSupabaseClient } from "@/lib/supabase/server";

const DEFAULT_OFFLINE_AFTER_SECONDS = 180;
const MIN_OFFLINE_AFTER_SECONDS = 60;
const MAX_OFFLINE_AFTER_SECONDS = 86_400;

type SensorStatusRow = {
  id: string;
  sensor_code: string;
  storage_unit_id: string;
  zone_id: string;
  status: string;
  last_seen_at: string | null;
};

function jsonError(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7).trim();
  return token.length > 32 && token.length < 4096 ? token : null;
}

function getOfflineAfterSeconds(): number | null {
  const configured = process.env.SENSOR_OFFLINE_AFTER_SECONDS;
  if (configured === undefined || configured.trim() === "") {
    return DEFAULT_OFFLINE_AFTER_SECONDS;
  }
  const value = Number(configured);
  if (
    !Number.isInteger(value) ||
    value < MIN_OFFLINE_AFTER_SECONDS ||
    value > MAX_OFFLINE_AFTER_SECONDS
  ) {
    return null;
  }
  return value;
}

export async function GET(request: Request) {
  const accessToken = getBearerToken(request);
  if (!accessToken) return jsonError(401, "USER_AUTH_REQUIRED");
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) {
    return jsonError(503, "SENSOR_STATUS_NOT_CONFIGURED");
  }

  const offlineAfterSeconds = getOfflineAfterSeconds();
  if (offlineAfterSeconds === null) {
    return jsonError(503, "SENSOR_OFFLINE_THRESHOLD_INVALID");
  }

  const userClient = createUserSupabaseClient(accessToken);
  const { data: userData, error: userError } = await userClient.auth.getUser(accessToken);
  if (userError || !userData.user) return jsonError(401, "INVALID_USER_SESSION");

  const { data, error } = await userClient
    .from("sensors")
    .select("id, sensor_code, storage_unit_id, zone_id, status, last_seen_at")
    .order("zone_id", { ascending: true });
  if (error) {
    console.error("Sensor status lookup failed.", { code: error.code });
    return jsonError(500, "SENSOR_STATUS_LOOKUP_FAILED");
  }

  const now = Date.now();
  const rows = (data ?? []) as SensorStatusRow[];
  const sensors = rows.map((sensor) => {
    const lastSeenMs = sensor.last_seen_at ? Date.parse(sensor.last_seen_at) : Number.NaN;
    const connectivity =
      sensor.status !== "active"
        ? sensor.status.toUpperCase()
        : Number.isFinite(lastSeenMs) && now - lastSeenMs <= offlineAfterSeconds * 1000
          ? "ONLINE"
          : "OFFLINE";
    return { ...sensor, connectivity };
  });

  const zones = new Map<
    string,
    {
      zone_id: string;
      storage_unit_id: string;
      connectivity: "ONLINE" | "DEGRADED" | "OFFLINE" | "UNMONITORED";
      sensors: typeof sensors;
    }
  >();
  for (const sensor of sensors) {
    const zone = zones.get(sensor.zone_id) ?? {
      zone_id: sensor.zone_id,
      storage_unit_id: sensor.storage_unit_id,
      connectivity: "UNMONITORED" as const,
      sensors: [],
    };
    zone.sensors.push(sensor);
    zones.set(sensor.zone_id, zone);
  }
  for (const zone of zones.values()) {
    const activeSensors = zone.sensors.filter((sensor) => sensor.status === "active");
    const onlineCount = activeSensors.filter((sensor) => sensor.connectivity === "ONLINE").length;
    zone.connectivity =
      activeSensors.length === 0
        ? "UNMONITORED"
        : onlineCount === activeSensors.length
          ? "ONLINE"
          : onlineCount === 0
            ? "OFFLINE"
            : "DEGRADED";
  }

  return NextResponse.json({
    offline_after_seconds: offlineAfterSeconds,
    zones: Array.from(zones.values()),
  });
}
