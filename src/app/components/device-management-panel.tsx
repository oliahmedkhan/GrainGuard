"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Check, Copy, Cpu, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { getSupabaseBrowserClient, isSupabaseBrowserConfigured } from "@/lib/supabase/browser";

type StorageUnit = {
  id: string;
  storage_name: string;
};

type StorageZone = {
  id: string;
  storage_unit_id: string;
  zone_name: string;
  zone_number: number | null;
};

type RegisteredSensor = {
  id: string;
  sensor_code: string;
  sensor_type: string;
  storage_unit_id: string;
  zone_id: string;
  device_record_id: string;
  esp32_device_id: string;
  status: string;
  last_seen_at: string | null;
  connectivity: string;
};

type RegisteredDevice = {
  id: string;
  physical_device_id: string;
  device_name: string;
  storage_unit_id: string;
  status: string;
  connectivity: string;
  sensors: RegisteredSensor[];
};

type SensorReading = {
  sensor_id: string;
  temperature: number | null;
  humidity: number | null;
  gas_raw_value: number | null;
  recorded_at: string;
};

type RegistrationDraft = {
  zoneId: string;
  sensorCode: string;
  sensorType: string;
};

type IssuedCredential = {
  zoneName: string;
  sensorCode: string;
  apiKey: string;
};

const SENSOR_CODE_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._-]{3,100}$/;
const SENSOR_TYPE_PATTERN = /^[A-Za-z0-9._-]{2,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatMeasurement(value: number | null, suffix = "") {
  return value === null || !Number.isFinite(value) ? "—" : `${value}${suffix}`;
}

function formatTimestamp(value: string | null) {
  if (!value) return "Never";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "Unavailable";
}

function connectivityLabel(value: string) {
  switch (value) {
    case "ONLINE":
      return "Online";
    case "DEGRADED":
      return "Degraded";
    case "OFFLINE":
      return "Offline";
    case "UNMONITORED":
      return "Awaiting readings";
    default:
      return value.toLowerCase();
  }
}

export default function DeviceManagementPanel() {
  const client = getSupabaseBrowserClient();
  const [authReady, setAuthReady] = useState(() => !isSupabaseBrowserConfigured());
  const [userId, setUserId] = useState<string | null>(null);
  const [units, setUnits] = useState<StorageUnit[]>([]);
  const [zones, setZones] = useState<StorageZone[]>([]);
  const [devices, setDevices] = useState<RegisteredDevice[]>([]);
  const [latestReadings, setLatestReadings] = useState<Map<string, SensorReading>>(new Map());
  const [selectedUnitId, setSelectedUnitId] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [physicalDeviceId, setPhysicalDeviceId] = useState("");
  const [draftValues, setDraftValues] = useState<Record<string, Omit<RegistrationDraft, "zoneId">>>({});
  const [credentials, setCredentials] = useState<IssuedCredential[]>([]);
  const [revealedCodes, setRevealedCodes] = useState<string[]>([]);
  const [copiedCode, setCopiedCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!client) {
      return;
    }

    let active = true;
    const { data: authListener } = client.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      setUserId(session?.user.id ?? null);
      if (!session) {
        setUnits([]);
        setZones([]);
        setDevices([]);
        setLatestReadings(new Map());
        setCredentials([]);
      }
    });

    void client.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active) return;
      if (sessionError) setError("Could not read the current Supabase session.");
      setUserId(data.session?.user.id ?? null);
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
    let loadingNow = false;

    const loadRecords = async () => {
      if (loadingNow) return;
      loadingNow = true;
      setLoading(true);
      setError("");

      try {
        const { data: sessionData, error: sessionError } = await client.auth.getSession();
        const session = sessionData.session;
        if (sessionError || !session || session.user.id !== userId) {
          if (active) setError("Your Supabase session is unavailable. Sign in again to manage devices.");
          return;
        }

        const { data: unitData, error: unitError } = await client
          .from("storage_units")
          .select("id, storage_name")
          .eq("user_id", userId)
          .order("storage_name", { ascending: true });
        if (unitError) throw new Error(`Storage units could not be verified in Supabase: ${unitError.message}`);

        const unitRows = (unitData ?? []) as StorageUnit[];
        const unitIds = unitRows.map((unit) => unit.id);
        let zoneRows: StorageZone[] = [];
        if (unitIds.length > 0) {
          const { data: zoneData, error: zoneError } = await client
            .from("storage_zones")
            .select("id, storage_unit_id, zone_name, zone_number")
            .in("storage_unit_id", unitIds)
            .order("zone_number", { ascending: true });
          if (zoneError) throw new Error(`Storage zones could not be verified in Supabase: ${zoneError.message}`);
          zoneRows = (zoneData ?? []) as StorageZone[];
        }

        const statusResponse = await fetch("/api/v1/sensors/status", {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: "no-store",
        });
        const statusPayload: unknown = await statusResponse.json();
        if (!statusResponse.ok) {
          const statusError = isRecord(statusPayload) && typeof statusPayload.error === "string"
            ? statusPayload.error
            : "SENSOR_STATUS_LOOKUP_FAILED";
          throw new Error(`Registered sensors could not be loaded: ${statusError}`);
        }
        if (!isRecord(statusPayload) || !Array.isArray(statusPayload.devices)) {
          throw new Error("The sensor status response was invalid.");
        }

        const deviceRows = statusPayload.devices as RegisteredDevice[];
        const sensorIds = deviceRows.flatMap((device) => device.sensors.map((sensor) => sensor.id));
        let readingMap = new Map<string, SensorReading>();
        if (sensorIds.length > 0) {
          const { data: readingData, error: readingError } = await client
            .from("sensor_readings")
            .select("sensor_id, temperature, humidity, gas_raw_value, recorded_at")
            .in("sensor_id", sensorIds)
            .eq("is_valid", true)
            .order("recorded_at", { ascending: false })
            .limit(sensorIds.length * 4);
          if (readingError) throw new Error(`Recent sensor readings could not be loaded: ${readingError.message}`);

          readingMap = new Map<string, SensorReading>();
          for (const reading of (readingData ?? []) as SensorReading[]) {
            if (!readingMap.has(reading.sensor_id)) readingMap.set(reading.sensor_id, reading);
          }
        }

        if (!active) return;
        setUnits(unitRows);
        setZones(zoneRows);
        setDevices(deviceRows);
        setLatestReadings(readingMap);
        setSelectedUnitId((current) =>
          unitRows.some((unit) => unit.id === current) ? current : unitRows[0]?.id ?? ""
        );
      } catch (reason) {
        if (active) {
          setError(reason instanceof Error ? reason.message : "Device information could not be loaded.");
        }
      } finally {
        loadingNow = false;
        if (active) setLoading(false);
      }
    };

    void loadRecords();
    const refreshTimer = window.setInterval(() => void loadRecords(), 30_000);
    return () => {
      active = false;
      window.clearInterval(refreshTimer);
    };
  }, [authReady, client, refreshVersion, userId]);

  const registeredSensors = useMemo(
    () => devices.flatMap((device) => device.sensors),
    [devices]
  );
  const occupiedZoneIds = useMemo(
    () => new Set(registeredSensors.map((sensor) => sensor.zone_id)),
    [registeredSensors]
  );
  const availableZones = useMemo(
    () => zones.filter((zone) => zone.storage_unit_id === selectedUnitId && !occupiedZoneIds.has(zone.id)),
    [occupiedZoneIds, selectedUnitId, zones]
  );

  const drafts = useMemo(
    () => availableZones.slice(0, 3).map((zone) => ({
      zoneId: zone.id,
      sensorCode: draftValues[zone.id]?.sensorCode ?? "",
      sensorType: draftValues[zone.id]?.sensorType ?? "",
    })),
    [availableZones, draftValues]
  );

  const existingCodes = useMemo(
    () => new Set(registeredSensors.map((sensor) => sensor.sensor_code)),
    [registeredSensors]
  );
  const draftCodes = drafts.map((draft) => draft.sensorCode.trim());
  const draftsValid = drafts.length > 0 &&
    drafts.every((draft) =>
      availableZones.some((zone) => zone.id === draft.zoneId) &&
      SENSOR_CODE_PATTERN.test(draft.sensorCode.trim()) &&
      SENSOR_TYPE_PATTERN.test(draft.sensorType.trim()) &&
      !existingCodes.has(draft.sensorCode.trim())
    ) &&
    new Set(draftCodes).size === draftCodes.length &&
    DEVICE_ID_PATTERN.test(physicalDeviceId.trim()) &&
    deviceName.trim().length > 0 &&
    deviceName.trim().length <= 100;

  const selectedUnit = units.find((unit) => unit.id === selectedUnitId);
  const syncedZonesInUnit = zones.filter((zone) => zone.storage_unit_id === selectedUnitId);

  const updateDraft = (index: number, patch: Partial<RegistrationDraft>) => {
    const zoneId = drafts[index]?.zoneId;
    if (!zoneId) return;
    setDraftValues((current) => ({
      ...current,
      [zoneId]: {
        sensorCode: patch.sensorCode ?? current[zoneId]?.sensorCode ?? "",
        sensorType: patch.sensorType ?? current[zoneId]?.sensorType ?? "",
      },
    }));
  };

  const refreshRecords = useCallback(() => {
    setRefreshVersion((current) => current + 1);
  }, []);

  async function registerSensors(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || !userId || !draftsValid || !selectedUnit) return;

    setSaving(true);
    setError("");
    setMessage("");
    setCredentials([]);
    setRevealedCodes([]);
    setCopiedCode("");

    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    const session = sessionData.session;
    if (sessionError || !session || session.user.id !== userId) {
      setError("Your Supabase session expired. Sign in again before registering sensors.");
      setSaving(false);
      return;
    }

    const issued: IssuedCredential[] = [];
    const failures: string[] = [];
    for (const draft of drafts) {
      const zone = zones.find((item) => item.id === draft.zoneId);
      if (!zone || zone.storage_unit_id !== selectedUnit.id) {
        failures.push("A selected zone is no longer available in the verified database records.");
        break;
      }

      let response: Response;
      try {
        response = await fetch("/api/v1/sensors/register", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
          },
          cache: "no-store",
          body: JSON.stringify({
            storage_unit_id: selectedUnit.id,
            zone_id: zone.id,
            sensor_code: draft.sensorCode.trim(),
            sensor_type: draft.sensorType.trim(),
            esp32_device_id: physicalDeviceId.trim(),
            device_name: deviceName.trim(),
          }),
        });
      } catch {
        failures.push(
          `${zone.zone_name}: the request ended without a response. Registration may have completed; refresh the device list before retrying.`
        );
        break;
      }

      let result: unknown;
      try {
        result = await response.json();
      } catch {
        failures.push(
          `${zone.zone_name}: the server response could not be read. Refresh the device list before retrying.`
        );
        break;
      }

      if (!response.ok) {
        const serverError = isRecord(result) && typeof result.error === "string"
          ? result.error
          : `HTTP_${response.status}`;
        failures.push(`${zone.zone_name}: ${serverError}`);
        continue;
      }

      if (!isRecord(result) || typeof result.device_api_key !== "string") {
        failures.push(
          `${zone.zone_name}: registration returned no credential. Refresh the list and contact an administrator before retrying.`
        );
        break;
      }

      issued.push({
        zoneName: zone.zone_name,
        sensorCode: draft.sensorCode.trim(),
        apiKey: result.device_api_key,
      });
    }

    setCredentials(issued);
    if (failures.length > 0) {
      setError(failures.join(" "));
    } else {
      setMessage(`${issued.length} sensor registration${issued.length === 1 ? "" : "s"} completed.`);
    }
    refreshRecords();
    setSaving(false);
  }

  async function copyCredential(credential: IssuedCredential) {
    try {
      await navigator.clipboard.writeText(credential.apiKey);
      setCopiedCode(credential.sensorCode);
      setError("");
    } catch {
      setError("Clipboard access was denied. Reveal the key and copy it manually from this page.");
    }
  }

  if (!isSupabaseBrowserConfigured()) {
    return (
      <section className="panel device-management-panel">
        <div className="device-empty"><TriangleAlert size={20} /><strong>Supabase is not configured</strong><span>Device management requires the authenticated Supabase browser client.</span></div>
      </section>
    );
  }

  if (!authReady || !userId) {
    return (
      <section className="panel device-management-panel">
        <div className="device-empty"><ShieldCheck size={20} /><strong>Sign in required</strong><span>Sign in through Settings to view your database storage and manage registered sensors.</span></div>
      </section>
    );
  }

  return (
    <div className="device-management">
      <section className="panel device-registration-panel">
        <div className="panel-heading device-panel-heading">
          <div>
            <h3>Register one physical ESP32</h3>
            <p>Register child sensors against verified Supabase zones. Credentials are generated only after you submit.</p>
          </div>
          <button className="button button-secondary small" type="button" onClick={refreshRecords} disabled={loading || saving}>
            <RefreshCw size={14} />Refresh
          </button>
        </div>

        <div className="database-verification">
          <ShieldCheck size={15} />
          <span>
            {units.length > 0
              ? `${units.length} owned storage unit${units.length === 1 ? "" : "s"} and ${zones.length} database zone${zones.length === 1 ? "" : "s"} verified in Supabase.`
              : loading
                ? "Checking owner-scoped storage records in Supabase…"
                : "No owned storage units were returned by Supabase. Local browser entries cannot be registered."}
          </span>
        </div>

        {error && <div className="device-feedback error" role="alert"><TriangleAlert size={15} />{error}</div>}
        {message && <div className="device-feedback success" role="status"><Check size={15} />{message}</div>}

        {units.length === 0 ? (
          <div className="device-empty compact">
            <strong>Database storage records required</strong>
            <span>Create or sync the Storage Unit and its Zones while signed in, then refresh. Registration remains disabled until actual database rows are returned.</span>
          </div>
        ) : (
          <form className="device-registration-form" onSubmit={registerSensors}>
            <label className="form-field">
              Supabase Storage Unit
              <select value={selectedUnitId} onChange={(event) => setSelectedUnitId(event.target.value)} required>
                {units.map((unit) => <option key={unit.id} value={unit.id}>{unit.storage_name}</option>)}
              </select>
            </label>

            <div className="device-form-grid">
              <label className="form-field">
                Physical ESP32 name
                <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={100} placeholder="e.g. Main three-zone ESP32" required />
              </label>
              <label className="form-field">
                Physical ESP32 ID
                <input value={physicalDeviceId} onChange={(event) => setPhysicalDeviceId(event.target.value)} maxLength={100} placeholder="Enter the board's stable device ID" required />
                <small>Use this same physical ID for all sensor zones.</small>
              </label>
            </div>

            {syncedZonesInUnit.length < 1 ? (
              <div className="device-empty compact">
                <strong>No Supabase zones found for this Storage Unit</strong>
                <span>Only zones returned by the authenticated database query can be selected.</span>
              </div>
            ) : availableZones.length === 0 ? (
              <div className="device-empty compact">
                <strong>All database zones already have registered sensors</strong>
                <span>Existing registrations are shown below. This form will not create duplicates or rotate their credentials.</span>
              </div>
            ) : (
              <>
                <div className="device-zone-form-heading">
                  <div><strong>Child sensor registrations</strong><span>{availableZones.length} unregistered zone{availableZones.length === 1 ? "" : "s"} available in this Storage Unit</span></div>
                  <span className="registration-limit">Up to 3 per ESP32</span>
                </div>
                <div className="device-zone-form-list">
                  {drafts.map((draft, index) => (
                    <fieldset className="device-zone-form-row" key={`sensor-registration-${index}`}>
                      <legend>Zone sensor {index + 1}</legend>
                      <label className="form-field">
                        Supabase Zone
                        <select value={draft.zoneId} onChange={(event) => updateDraft(index, { zoneId: event.target.value })} required>
                          {availableZones.map((zone) => (
                            <option
                              key={zone.id}
                              value={zone.id}
                              disabled={drafts.some((other, otherIndex) => otherIndex !== index && other.zoneId === zone.id)}
                            >
                              {zone.zone_name}{zone.zone_number ? ` · ${zone.zone_number}` : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="form-field">
                        Sensor code
                        <input value={draft.sensorCode} onChange={(event) => updateDraft(index, { sensorCode: event.target.value })} maxLength={64} pattern="[A-Za-z0-9._-]{3,64}" placeholder="Unique registered sensor code" required />
                      </label>
                      <label className="form-field">
                        Sensor type
                        <input value={draft.sensorType} onChange={(event) => updateDraft(index, { sensorType: event.target.value })} maxLength={64} pattern="[A-Za-z0-9._-]{2,64}" placeholder="e.g. DHT22-MQ2" required />
                      </label>
                    </fieldset>
                  ))}
                </div>
                <div className="device-submit-row">
                  <span>Each child sensor gets its own API key; all share the physical ESP32 identity.</span>
                  <button className="button button-primary" type="submit" disabled={!draftsValid || loading || saving}>
                    <Cpu size={15} />{saving ? "Registering…" : `Register ${drafts.length} sensor${drafts.length === 1 ? "" : "s"}`}
                  </button>
                </div>
              </>
            )}
          </form>
        )}
      </section>

      {credentials.length > 0 && (
        <section className="panel issued-credentials" aria-live="polite">
          <div className="issued-credentials-warning">
            <TriangleAlert size={17} />
            <div>
              <strong>Save these credentials now</strong>
              <span>Each key is held only in this page’s memory, not persisted, and cannot be retrieved after leaving or refreshing this page.</span>
            </div>
          </div>
          {credentials.map((credential) => {
            const revealed = revealedCodes.includes(credential.sensorCode);
            return (
              <div className="issued-credential-row" key={credential.sensorCode}>
                <div className="issued-credential-label"><strong>{credential.zoneName}</strong><span>{credential.sensorCode}</span></div>
                <input aria-label={`Device key for ${credential.zoneName}`} type={revealed ? "text" : "password"} readOnly value={credential.apiKey} autoComplete="off" />
                <button className="button button-secondary small" type="button" onClick={() => setRevealedCodes((current) => revealed ? current.filter((code) => code !== credential.sensorCode) : [...current, credential.sensorCode])}>
                  {revealed ? "Hide" : "Reveal"}
                </button>
                <button className="button button-secondary small" type="button" onClick={() => void copyCredential(credential)}>
                  {copiedCode === credential.sensorCode ? <Check size={14} /> : <Copy size={14} />}
                  {copiedCode === credential.sensorCode ? "Copied" : "Copy"}
                </button>
              </div>
            );
          })}
          <button className="text-button" type="button" onClick={() => { setCredentials([]); setRevealedCodes([]); setCopiedCode(""); }}>
            I saved these keys; clear them from this page
          </button>
          <div className="firmware-instructions">
            <strong>Firmware configuration</strong>
            <span>In your local, untracked <code>grainguard_config.h</code>, set each zone’s actual database zone ID, Storage Unit ID, returned sensor code, the same physical ESP32 ID, and that zone’s one-time API key. Keep the three API keys and Wi-Fi credentials out of Git. No firmware is uploaded automatically.</span>
          </div>
        </section>
      )}

      <section className="device-list-section">
        <div className="panel-heading device-list-heading">
          <div><h3>Registered ESP32 devices</h3><p>Owner-scoped registrations and the latest valid database readings</p></div>
          <span className="updated-label">{loading ? "Refreshing…" : "Refreshes every 30 seconds"}</span>
        </div>
        {devices.length === 0 ? (
          <div className="panel device-empty"><Cpu size={20} /><strong>No registered devices found</strong><span>Only authenticated registrations returned from Supabase are shown. Submitting the form is required to register sensors.</span></div>
        ) : (
          <div className="registered-device-grid">
            {devices.map((device) => {
              const unitName = units.find((unit) => unit.id === device.storage_unit_id)?.storage_name ?? "Storage Unit unavailable";
              return (
                <article className="panel registered-device-card" key={device.id}>
                  <div className="registered-device-heading">
                    <div className="registered-device-icon"><Cpu size={17} /></div>
                    <div className="registered-device-title"><strong>{device.device_name}</strong><span>{device.physical_device_id}</span></div>
                    <span className={`device-connectivity ${device.connectivity.toLowerCase()}`}>{connectivityLabel(device.connectivity)}</span>
                  </div>
                  <div className="registered-device-meta"><span>Storage Unit</span><strong>{unitName}</strong></div>
                  <div className="registered-sensor-list">
                    {device.sensors.map((sensor) => {
                      const zoneName = zones.find((zone) => zone.id === sensor.zone_id)?.zone_name ?? "Zone unavailable";
                      const reading = latestReadings.get(sensor.id);
                      return (
                        <div className="registered-sensor-row" key={sensor.id}>
                          <div className="registered-sensor-heading">
                            <div><strong>{zoneName}</strong><span>{sensor.sensor_code} · {sensor.sensor_type}</span></div>
                            <span className={`sensor-registration-status ${sensor.status.toLowerCase()}`}>{sensor.status}</span>
                          </div>
                          <div className="registered-sensor-details">
                            <span>{connectivityLabel(sensor.connectivity)} · Last seen {formatTimestamp(sensor.last_seen_at)}</span>
                            <span>Temperature {formatMeasurement(reading?.temperature ?? null, " °C")} · Humidity {formatMeasurement(reading?.humidity ?? null, " %")} · MQ-2 raw {formatMeasurement(reading?.gas_raw_value ?? null)}</span>
                            <span>Latest reading {formatTimestamp(reading?.recorded_at ?? null)}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
