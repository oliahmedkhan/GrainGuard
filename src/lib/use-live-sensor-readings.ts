"use client";

import { useEffect, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabaseBrowserClient, isSupabaseBrowserConfigured } from "@/lib/supabase/browser";

export type LiveSensorReading = {
  id: string;
  temperature: number | null;
  humidity: number | null;
  gas_raw_value: number | null;
  fan_status: boolean | null;
  recorded_at: string;
  received_at: string;
};

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
    typeof row.recorded_at !== "string" ||
    typeof row.received_at !== "string"
  ) {
    return null;
  }
  return {
    id: row.id,
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
  const [activeSensorCount, setActiveSensorCount] = useState<number | null>(null);
  const [loadedScope, setLoadedScope] = useState<{ userId: string; zoneId: string | null } | null>(null);
  const [error, setError] = useState("");

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
    let channel: RealtimeChannel | null = null;
    const loadReadings = async () => {
      let readingQuery = client
        .from("sensor_readings")
        .select("id, temperature, humidity, gas_raw_value, fan_status, recorded_at, received_at")
        .eq("is_valid", true)
        .order("recorded_at", { ascending: false })
        .limit(48);
      let sensorQuery = client.from("sensors").select("id", { count: "exact", head: true }).eq("status", "active");
      if (scopeZoneId) {
        readingQuery = readingQuery.eq("zone_id", scopeZoneId);
        sensorQuery = sensorQuery.eq("zone_id", scopeZoneId);
      }
      const [readingsResult, sensorsResult] = await Promise.all([readingQuery, sensorQuery]);

      if (!active) return;
      if (readingsResult.error || sensorsResult.error) {
        setError("Could not load authorized sensor history. Check the database migration and access policies.");
        return;
      }

      setReadings((readingsResult.data ?? []).map(parseReading).filter((row): row is LiveSensorReading => row !== null));
      setActiveSensorCount(sensorsResult.count ?? 0);
      setLoadedScope({ userId, zoneId: scopeZoneId });
      setError("");
    };

    void loadReadings();
    channel = client
      .channel(`sensor-readings-${userId}`)
      .on(
        "postgres_changes",
        scopeZoneId
          ? { event: "INSERT", schema: "public", table: "sensor_readings", filter: `zone_id=eq.${scopeZoneId}` }
          : { event: "INSERT", schema: "public", table: "sensor_readings" },
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
          setReadings((current) =>
            [reading, ...current.filter((item) => item.id !== reading.id)]
              .sort((left, right) => Date.parse(right.recorded_at) - Date.parse(left.recorded_at))
              .slice(0, 48)
          );
        }
      )
      .subscribe((status) => {
        if (active && (status === "CHANNEL_ERROR" || status === "TIMED_OUT")) {
          setError("Realtime sensor updates are unavailable. Check the Supabase Realtime publication.");
        }
      });

    return () => {
      active = false;
      if (channel) void client.removeChannel(channel);
    };
  }, [authReady, client, scopeZoneId, userId]);

  return {
    configured: isSupabaseBrowserConfigured(),
    authenticated: Boolean(userId),
    userId,
    authReady,
    readings: loadedScope?.userId === userId && loadedScope.zoneId === scopeZoneId ? readings : [],
    activeSensorCount:
      loadedScope?.userId === userId && loadedScope.zoneId === scopeZoneId
        ? activeSensorCount
        : null,
    error,
  };
}
