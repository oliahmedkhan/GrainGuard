"use client";

import { useEffect, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabaseBrowserClient, isSupabaseBrowserConfigured } from "@/lib/supabase/browser";

export type LiveSensorReading = {
  id: string;
  zone_id: string;
  storage_unit_id: string;
  temperature: number | null;
  humidity: number | null;
  gas_raw_value: number | null;
  fan_status: boolean | null;
  recorded_at: string;
  received_at: string;
};

export type LiveZoneReading = {
  zone: {
    id: string;
    name: string;
    number: number | null;
    storageUnitId: string;
  };
  reading: LiveSensorReading | null;
};

const READING_COLUMNS =
  "id, zone_id, storage_unit_id, temperature, humidity, gas_raw_value, fan_status, recorded_at, received_at";

function nullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseReading(value: unknown): LiveSensorReading | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    typeof row.zone_id !== "string" ||
    typeof row.storage_unit_id !== "string" ||
    typeof row.recorded_at !== "string" ||
    typeof row.received_at !== "string"
  ) {
    return null;
  }
  return {
    id: row.id,
    zone_id: row.zone_id,
    storage_unit_id: row.storage_unit_id,
    temperature: nullableNumber(row.temperature),
    humidity: nullableNumber(row.humidity),
    gas_raw_value: nullableNumber(row.gas_raw_value),
    fan_status: typeof row.fan_status === "boolean" ? row.fan_status : null,
    recorded_at: row.recorded_at,
    received_at: row.received_at,
  };
}

export function useLiveSensorReadings(scopeZoneId: string | null = null) {
  const client = getSupabaseBrowserClient();
  const [userId, setUserId] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(() => !isSupabaseBrowserConfigured());
  const [readings, setReadings] = useState<LiveSensorReading[]>([]);
  const [zoneReadings, setZoneReadings] = useState<LiveZoneReading[]>([]);
  const [activeSensorCount, setActiveSensorCount] = useState<number | null>(null);
  const [loadedScope, setLoadedScope] = useState<{ userId: string; zoneId: string | null } | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!client) return;

    let active = true;
    void client.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active) return;
      if (sessionError) {
        setError("Could not read the current Supabase session.");
      } else {
        setUserId(data.session?.user.id ?? null);
      }
      setAuthReady(true);
    });

    const { data: authListener } = client.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      setUserId(session?.user.id ?? null);
      setReadings([]);
      setZoneReadings([]);
      setActiveSensorCount(null);
      setLoadedScope(null);
      setError("");
      setAuthReady(true);
    });

    return () => {
      active = false;
      authListener.subscription.unsubscribe();
    };
  }, [client]);

  useEffect(() => {
    if (!client || !authReady || !userId) return;

    let active = true;
    let loading = false;
    let activeScopeZoneId: string | null = null;
    let channel: RealtimeChannel | null = null;
    const loadReadings = async () => {
      if (loading) return;
      loading = true;
      setRefreshing(true);
      try {
        const [zonesResult, sensorsResult] = await Promise.all([
          client
            .from("storage_zones")
            .select("id, zone_name, zone_number, storage_unit_id")
            .order("zone_number", { ascending: true }),
          client.from("sensors").select("id", { count: "exact", head: true }).eq("status", "active"),
        ]);

        if (!active) return;
        if (zonesResult.error || sensorsResult.error) {
          setError("Could not load authorized zones or sensor status. Check the database migration and access policies.");
          return;
        }

        const zones = (zonesResult.data ?? []).map((zone) => ({
          id: zone.id,
          name: zone.zone_name,
          number: zone.zone_number,
          storageUnitId: zone.storage_unit_id,
        }));
        const authorizedScopeZoneId =
          scopeZoneId && zones.some((zone) => zone.id === scopeZoneId) ? scopeZoneId : null;
        activeScopeZoneId = authorizedScopeZoneId;

        let readingQuery = client
          .from("sensor_readings")
          .select(READING_COLUMNS)
          .eq("is_valid", true)
          .order("recorded_at", { ascending: false })
          .limit(48);
        if (authorizedScopeZoneId) readingQuery = readingQuery.eq("zone_id", authorizedScopeZoneId);

        const [readingsResult, latestResults] = await Promise.all([
          readingQuery,
          Promise.all(
            zones.map((zone) =>
              client
                .from("sensor_readings")
                .select(READING_COLUMNS)
                .eq("zone_id", zone.id)
                .eq("is_valid", true)
                .order("recorded_at", { ascending: false })
                .limit(1)
            )
          ),
        ]);

        if (!active) return;
        if (readingsResult.error || latestResults.some((result) => result.error)) {
          setError("Could not load authorized sensor readings. Check the database migration and access policies.");
          return;
        }

        setReadings((readingsResult.data ?? []).map(parseReading).filter((row): row is LiveSensorReading => row !== null));
        setZoneReadings(
          zones.map((zone, index) => ({
            zone,
            reading: parseReading(latestResults[index]?.data?.[0]),
          }))
        );
        setActiveSensorCount(sensorsResult.count ?? 0);
        setLoadedScope({ userId, zoneId: scopeZoneId });
        setError("");
      } catch {
        if (active) setError("Could not refresh authorized sensor readings.");
      } finally {
        loading = false;
        if (active) setRefreshing(false);
      }
    };

    void loadReadings();
    const refreshInterval = window.setInterval(() => void loadReadings(), 30_000);
    channel = client
      .channel(`sensor-readings-${userId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "sensor_readings" },
        (payload) => {
          if (!active) return;
          if (
            typeof payload.new !== "object" ||
            payload.new === null ||
            !("is_valid" in payload.new) ||
            payload.new.is_valid !== true
          ) {
            return;
          }
          const reading = parseReading(payload.new);
          if (!reading) return;
          const isNewer = (previous: LiveSensorReading | null) =>
            !previous || Date.parse(reading.recorded_at) >= Date.parse(previous.recorded_at);
          setZoneReadings((current) =>
            current.map((item) =>
              item.zone.id === reading.zone_id && isNewer(item.reading)
                ? { ...item, reading }
                : item
            )
          );
          if (!activeScopeZoneId || reading.zone_id === activeScopeZoneId) {
            setReadings((current) =>
              [reading, ...current.filter((item) => item.id !== reading.id)]
                .sort((left, right) => Date.parse(right.recorded_at) - Date.parse(left.recorded_at))
                .slice(0, 48)
            );
          }
        }
      )
      .subscribe((status) => {
        if (active && (status === "CHANNEL_ERROR" || status === "TIMED_OUT")) {
          setError("Realtime sensor updates are unavailable. Check the Supabase Realtime publication.");
        }
      });

    return () => {
      active = false;
      window.clearInterval(refreshInterval);
      if (channel) void client.removeChannel(channel);
    };
  }, [authReady, client, scopeZoneId, userId]);

  return {
    configured: isSupabaseBrowserConfigured(),
    authenticated: Boolean(userId),
    userId,
    authReady,
    readings: loadedScope?.userId === userId && loadedScope.zoneId === scopeZoneId ? readings : [],
    zoneReadings: loadedScope?.userId === userId ? zoneReadings : [],
    activeSensorCount:
      loadedScope?.userId === userId && loadedScope.zoneId === scopeZoneId
        ? activeSensorCount
        : null,
    error,
    refreshing,
  };
}
