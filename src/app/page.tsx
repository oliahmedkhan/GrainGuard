"use client";

import {
  Activity,
  ArrowUpRight,
  Bell,
  BookOpen,
  Boxes,
  BrainCircuit,
  Building2,
  CalendarDays,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  CloudOff,
  Cpu,
  Droplets,
  Fan,
  FileChartColumn,
  History,
  LayoutDashboard,
  Leaf,
  MapPin,
  Menu,
  Plus,
  Radio,
  Search,
  Settings,
  ShieldAlert,
  Thermometer,
  Warehouse,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { FormEvent, ReactNode } from "react";
import AccountPanel from "@/app/components/account-panel";
import DeviceManagementPanel from "@/app/components/device-management-panel";
import { useLiveSensorReadings } from "@/lib/use-live-sensor-readings";
import type { LiveSensorReading } from "@/lib/use-live-sensor-readings";
import { syncLocalWorkspaceToDatabase } from "@/lib/sync-local-workspace";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { Crop, Facility, Zone } from "@/lib/workspace-types";

type DisplayReading = {
  temperature: number | null;
  humidity: number | null;
  adc: number | null;
  fanStatus: boolean | null;
};
type WorkspaceData = { facilities: Facility[]; demoMode: boolean };
type ParsedWorkspace = WorkspaceData & { error: string };
type Section =
  | "Overview"
  | "Storage Facilities"
  | "Storage Zones"
  | "Crop Batches"
  | "Live Monitoring"
  | "AI Analysis"
  | "Problem Detection"
  | "Risk Forecast"
  | "Environmental Forecast"
  | "Ventilation Control"
  | "Recommendations"
  | "Historical Data"
  | "Reports"
  | "Devices & Sensors"
  | "Knowledge Base"
  | "Settings";

const STORAGE_KEY = "grainguard.workspace.v1";
const EMPTY_WORKSPACE = JSON.stringify({ facilities: [], demoMode: false });
const STORAGE_UNAVAILABLE = "storage-unavailable";
const CROPS: Crop[] = ["Potato", "Onion", "Garlic", "Ginger", "Chili"];

const NAV_ITEMS: { label: Section; icon: typeof LayoutDashboard; group: string }[] = [
  { label: "Overview", icon: LayoutDashboard, group: "Workspace" },
  { label: "Storage Facilities", icon: Building2, group: "Workspace" },
  { label: "Storage Zones", icon: Warehouse, group: "Workspace" },
  { label: "Crop Batches", icon: Boxes, group: "Workspace" },
  { label: "Live Monitoring", icon: Radio, group: "Monitoring" },
  { label: "AI Analysis", icon: BrainCircuit, group: "Intelligence" },
  { label: "Problem Detection", icon: ShieldAlert, group: "Intelligence" },
  { label: "Risk Forecast", icon: ChartNoAxesCombined, group: "Intelligence" },
  { label: "Environmental Forecast", icon: Activity, group: "Intelligence" },
  { label: "Ventilation Control", icon: Fan, group: "Operations" },
  { label: "Recommendations", icon: Leaf, group: "Operations" },
  { label: "Historical Data", icon: History, group: "Insights" },
  { label: "Reports", icon: FileChartColumn, group: "Insights" },
  { label: "Devices & Sensors", icon: Cpu, group: "System" },
  { label: "Knowledge Base", icon: BookOpen, group: "System" },
  { label: "Settings", icon: Settings, group: "System" },
];

const DEMO_FACILITIES: Facility[] = [
  {
    id: "demo-facility",
    name: "Demo Storage Facility",
    location: "Sample location · Synthetic data",
    zones: [
      { id: "demo-potato", name: "Zone 01", crop: "Potato", batchName: "DEMO-POT-01", capacity: 1200 },
      { id: "demo-onion", name: "Zone 02", crop: "Onion", batchName: "DEMO-ONI-01", capacity: 900 },
      { id: "demo-garlic", name: "Zone 03", crop: "Garlic", batchName: "DEMO-GAR-01", capacity: 650 },
      { id: "demo-ginger", name: "Zone 04", crop: "Ginger", batchName: "DEMO-GIN-01", capacity: 500 },
      { id: "demo-chili", name: "Zone 05", crop: "Chili", batchName: "DEMO-CHI-01", capacity: 450 },
    ],
  },
];

const demoReadings: Record<Crop, { temperature: number; humidity: number; adc: number; delta: number }> = {
  Potato: { temperature: 7.8, humidity: 88, adc: 1210, delta: -0.3 },
  Onion: { temperature: 24.2, humidity: 64, adc: 1164, delta: 0.2 },
  Garlic: { temperature: 18.6, humidity: 61, adc: 1108, delta: -0.1 },
  Ginger: { temperature: 16.9, humidity: 79, adc: 1275, delta: 0.4 },
  Chili: { temperature: 22.4, humidity: 52, adc: 1035, delta: -0.2 },
};

function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getWorkspaceSnapshot() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? EMPTY_WORKSPACE;
  } catch {
    return STORAGE_UNAVAILABLE;
  }
}

function subscribeToWorkspace(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener("grainguard-workspace-change", callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener("grainguard-workspace-change", callback);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isZone(value: unknown): value is Zone {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.crop === "string" && CROPS.includes(value.crop as Crop) &&
    typeof value.batchName === "string" &&
    typeof value.capacity === "number" && Number.isFinite(value.capacity) && value.capacity >= 0;
}

function isFacility(value: unknown): value is Facility {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.location === "string" &&
    Array.isArray(value.zones) && value.zones.every(isZone);
}

function parseWorkspace(snapshot: string): ParsedWorkspace {
  if (snapshot === STORAGE_UNAVAILABLE) {
    return { facilities: [], demoMode: false, error: "Browser storage is unavailable. Check privacy settings before saving workspace data." };
  }
  try {
    const parsed: unknown = JSON.parse(snapshot);
    if (!isRecord(parsed) || !Array.isArray(parsed.facilities) || !parsed.facilities.every(isFacility) || typeof parsed.demoMode !== "boolean") {
      throw new Error("Saved workspace data is invalid. Clear this browser's saved GrainGuard data to continue.");
    }
    return { facilities: parsed.facilities, demoMode: parsed.demoMode, error: "" };
  } catch (reason) {
    return {
      facilities: [],
      demoMode: false,
      error: reason instanceof Error ? reason.message : "Unable to read saved workspace data.",
    };
  }
}

function persistWorkspace(workspace: WorkspaceData) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
  window.dispatchEvent(new Event("grainguard-workspace-change"));
}

function IconBadge({ children, tone = "green" }: { children: ReactNode; tone?: "green" | "blue" | "amber" | "purple" }) {
  return <span className={`icon-badge ${tone}`}>{children}</span>;
}

function DemoChart({ crop, kind }: { crop: Crop; kind: "temperature" | "humidity" }) {
  const points =
    kind === "temperature"
      ? [39, 43, 40, 50, 45, 54, 51, 61, 58, 68, 64, 72]
      : [62, 58, 60, 54, 59, 52, 48, 53, 45, 49, 42, 46];
  const value = kind === "temperature" ? demoReadings[crop].temperature : demoReadings[crop].humidity;
  const label = kind === "temperature" ? "Temperature" : "Relative humidity";
  const coords = points.map((point, index) => `${index * 24},${96 - point}`).join(" ");
  const area = `0,96 ${coords} 264,96`;
  return (
    <div className="chart-card">
      <div className="chart-heading">
        <div>
          <span className="eyebrow">{label}</span>
          <div className="chart-value">
            {value}
            <small>{kind === "temperature" ? "°C" : "% RH"}</small>
          </div>
        </div>
        <span className="demo-chart-tag">SIMULATED</span>
      </div>
      <svg className="trend-chart" viewBox="0 0 264 100" role="img" aria-label={`${label} simulated trend`}>
        <defs>
          <linearGradient id={`fill-${kind}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={kind === "temperature" ? "#47d7a2" : "#62b8ff"} stopOpacity=".25" />
            <stop offset="100%" stopColor={kind === "temperature" ? "#47d7a2" : "#62b8ff"} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[20, 45, 70, 96].map((y) => (
          <line key={y} x1="0" x2="264" y1={y} y2={y} className="chart-gridline" />
        ))}
        <polygon points={area} fill={`url(#fill-${kind})`} />
        <polyline points={coords} className={`chart-line ${kind}`} />
        <circle cx="264" cy={96 - points[points.length - 1]} r="3.5" className={`chart-dot ${kind}`} />
      </svg>
      <div className="chart-axis"><span>−12h</span><span>−8h</span><span>−4h</span><span>Now</span></div>
    </div>
  );
}

function EmptyChart({ title }: { title: string }) {
  return (
    <div className="chart-card empty-chart">
      <span className="eyebrow">{title}</span>
      <div className="empty-chart-body">
        <CloudOff size={20} />
        <span>Waiting for sensor data</span>
      </div>
      <p>Sign in and connect an authorized sensor. Demo samples remain separate.</p>
    </div>
  );
}

function SensorHistoryChart({
  readings,
  metric,
  title,
  unit,
  kind,
}: {
  readings: LiveSensorReading[];
  metric: "temperature" | "humidity" | "gas_raw_value";
  title: string;
  unit: string;
  kind: "temperature" | "humidity" | "gas";
}) {
  const points = [...readings]
    .reverse()
    .map((reading) => ({ timestamp: reading.recorded_at, value: reading[metric] }))
    .filter((point): point is { timestamp: string; value: number } => point.value !== null);
  if (points.length < 2) return <EmptyChart title={title} />;

  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const coords = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 264;
      const y = 88 - ((value - min) / range) * 62;
      return `${x},${y}`;
    })
    .join(" ");
  const area = `0,96 ${coords} 264,96`;
  const latest = points[points.length - 1];
  const formatTime = (timestamp: string) =>
    new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="chart-card">
      <div className="chart-heading">
        <div>
          <span className="eyebrow">{title}</span>
          <div className="chart-value">
            {latest.value.toFixed(metric === "gas_raw_value" ? 0 : 1)}
            <small>{unit}</small>
          </div>
        </div>
        <span className="live-chart-tag">LIVE DATA</span>
      </div>
      <svg className="trend-chart" viewBox="0 0 264 100" role="img" aria-label={`${title} from stored sensor readings`}>
        <defs>
          <linearGradient id={`live-fill-${kind}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={kind === "temperature" ? "#47d7a2" : kind === "humidity" ? "#62b8ff" : "#eab96a"} stopOpacity=".25" />
            <stop offset="100%" stopColor={kind === "temperature" ? "#47d7a2" : kind === "humidity" ? "#62b8ff" : "#eab96a"} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[20, 45, 70, 96].map((y) => (
          <line key={y} x1="0" x2="264" y1={y} y2={y} className="chart-gridline" />
        ))}
        <polygon points={area} fill={`url(#live-fill-${kind})`} />
        <polyline points={coords} className={`chart-line ${kind}`} />
        <circle cx="264" cy={Number(coords.split(" ").at(-1)?.split(",")[1] ?? 88)} r="3.5" className={`chart-dot ${kind}`} />
      </svg>
      <div className="chart-axis"><span>{formatTime(points[0].timestamp)}</span><span>{formatTime(latest.timestamp)}</span></div>
    </div>
  );
}

export default function Home() {
  const workspaceSnapshot = useSyncExternalStore(subscribeToWorkspace, getWorkspaceSnapshot, () => EMPTY_WORKSPACE);
  const workspace = useMemo(() => parseWorkspace(workspaceSnapshot), [workspaceSnapshot]);
  const facilities = workspace.facilities;
  const demoMode = workspace.demoMode;
  const [selectedFacilityId, setSelectedFacilityId] = useState("");
  const [selectedZoneId, setSelectedZoneId] = useState("");
  const [section, setSection] = useState<Section>("Overview");
  const [modal, setModal] = useState<"facility" | "zone" | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [error, setError] = useState("");
  const sensorData = useLiveSensorReadings(demoMode ? null : selectedZoneId || null);
  const dateLabel = useSyncExternalStore(
    () => () => {},
    () => new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }),
    () => "Storage workspace",
  );

  function updateWorkspace(updater: (current: WorkspaceData) => WorkspaceData) {
    try {
      if (workspace.error) throw new Error(workspace.error);
      const current = parseWorkspace(getWorkspaceSnapshot());
      if (current.error) throw new Error(current.error);
      persistWorkspace(updater(current));
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Changes could not be saved in this browser.");
    }
  }

  const visibleFacilities = demoMode && facilities.length === 0 ? DEMO_FACILITIES : facilities;
  const selectedFacility =
    visibleFacilities.find((facility) => facility.id === selectedFacilityId) ?? visibleFacilities[0];
  const selectedZone =
    selectedFacility?.zones.find((zone) => zone.id === selectedZoneId) ?? selectedFacility?.zones[0];
  const crop = selectedZone?.crop ?? "Potato";
  const reading: DisplayReading | null = demoMode
    ? {
        temperature: demoReadings[crop].temperature,
        humidity: demoReadings[crop].humidity,
        adc: demoReadings[crop].adc,
        fanStatus: null,
      }
    : sensorData.readings[0]
      ? {
          temperature: sensorData.readings[0].temperature,
          humidity: sensorData.readings[0].humidity,
          adc: sensorData.readings[0].gas_raw_value,
          fanStatus: sensorData.readings[0].fan_status,
        }
      : null;
  const latestSensorUpdate = sensorData.readings[0]?.recorded_at;
  const batchCount = visibleFacilities.reduce((count, facility) => count + facility.zones.filter((zone) => zone.batchName).length, 0);
  const zoneCount = visibleFacilities.reduce((count, facility) => count + facility.zones.length, 0);

  useEffect(() => {
    if (!sensorData.authenticated || !sensorData.userId || facilities.length === 0) return;

    let active = true;
    void syncLocalWorkspaceToDatabase(facilities, sensorData.userId)
      .then(() => {
        if (active) setError("");
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "Workspace data could not be synchronized.");
        }
      });

    return () => {
      active = false;
    };
  }, [facilities, sensorData.authenticated, sensorData.userId]);

  const groupedNav = useMemo(
    () => [...new Set(NAV_ITEMS.map((item) => item.group))].map((group) => ({
      group,
      items: NAV_ITEMS.filter((item) => item.group === group),
    })),
    [],
  );

  function chooseFacility(id: string) {
    setSelectedFacilityId(id);
    const facility = visibleFacilities.find((entry) => entry.id === id);
    setSelectedZoneId(facility?.zones[0]?.id ?? "");
  }

  function toggleDemo() {
    const next = !demoMode;
    updateWorkspace((current) => ({ ...current, demoMode: next }));
    if (next && facilities.length === 0) {
      setSelectedFacilityId(DEMO_FACILITIES[0].id);
      setSelectedZoneId(DEMO_FACILITIES[0].zones[0].id);
    } else if (!next && selectedFacilityId === DEMO_FACILITIES[0].id) {
      setSelectedFacilityId(facilities[0]?.id ?? "");
      setSelectedZoneId(facilities[0]?.zones[0]?.id ?? "");
    }
  }

  function addFacility(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const name = String(formData.get("facilityName") ?? "").trim();
    const location = String(formData.get("location") ?? "").trim();
    if (!name) return;
    const facility = { id: makeId(), name, location: location || "Location not specified", zones: [] };
    updateWorkspace((current) => ({ ...current, facilities: [...current.facilities, facility] }));
    setSelectedFacilityId(facility.id);
    setSelectedZoneId("");
    setModal(null);
    setSection("Storage Facilities");
  }

  function addZone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const facilityId = String(formData.get("facilityId") ?? "");
    const name = String(formData.get("zoneName") ?? "").trim();
    const batchName = String(formData.get("batchName") ?? "").trim();
    const capacity = Number(formData.get("capacity") ?? 0);
    const chosenCrop = String(formData.get("crop") ?? "") as Crop;
    if (!name || !CROPS.includes(chosenCrop) || !Number.isFinite(capacity) || capacity < 0) return;
    const zone: Zone = { id: makeId(), name, crop: chosenCrop, batchName, capacity };
    updateWorkspace((current) => ({
      ...current,
      facilities: current.facilities.map((facility) => facility.id === facilityId ? { ...facility, zones: [...facility.zones, zone] } : facility),
    }));
    setSelectedFacilityId(facilityId);
    setSelectedZoneId(zone.id);
    setModal(null);
    setSection("Storage Zones");
  }

  async function deleteZone(facilityId: string, zoneId: string) {
    if (!window.confirm("Remove this zone and its local batch metadata? This cannot be undone.")) return;
    if (sensorData.authenticated) {
      const client = getSupabaseBrowserClient();
      if (!client) {
        setError("Supabase is not configured; the zone was not deleted.");
        return;
      }
      const { error: deleteError } = await client
        .from("storage_zones")
        .delete()
        .eq("id", zoneId)
        .eq("storage_unit_id", facilityId);
      if (deleteError) {
        setError("The zone could not be deleted from the central database.");
        return;
      }
    }
    updateWorkspace((current) => ({
      ...current,
      facilities: current.facilities.map((facility) => facility.id === facilityId
        ? { ...facility, zones: facility.zones.filter((zone) => zone.id !== zoneId) }
        : facility),
    }));
    if (selectedZoneId === zoneId) setSelectedZoneId("");
  }

  function activateSection(next: Section) {
    setSection(next);
    setMobileNavOpen(false);
  }

  const isContextPage = section === "Overview" || section === "Live Monitoring";

  return (
    <div className="app-shell">
      {mobileNavOpen && <button className="mobile-backdrop" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}
      <aside className={`sidebar ${mobileNavOpen ? "open" : ""}`}>
        <div className="brand">
          <span className="brand-mark"><Leaf size={19} strokeWidth={2.2} /></span>
          <span className="brand-name">grain<span>guard</span><small>SMART STORAGE</small></span>
          <button className="mobile-close" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)}><X size={18} /></button>
        </div>
        <div className="workspace-picker">
          <span className="workspace-avatar"><Warehouse size={16} /></span>
          <span className="workspace-copy"><strong>{selectedFacility?.name ?? "Your workspace"}</strong><small>Storage workspace</small></span>
          <ChevronDown size={15} />
        </div>
        <nav className="side-nav" aria-label="Main navigation">
          {groupedNav.map(({ group, items }) => (
            <div className="nav-group" key={group}>
              <span className="nav-label">{group}</span>
              {items.map(({ label, icon: Icon }) => (
                <button key={label} className={`nav-item ${section === label ? "active" : ""}`} onClick={() => activateSection(label)}>
                  <Icon size={17} strokeWidth={1.8} /><span>{label}</span>
                  {label === "Live Monitoring" && <span className={`nav-indicator ${demoMode ? "demo" : ""}`} />}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="system-health">
            <span className="health-dot" />
            <span><strong>{sensorData.authenticated ? sensorData.activeSensorCount === null ? "Sensor status loading" : `${sensorData.activeSensorCount} active sensors` : "Workspace ready"}</strong><small>{demoMode ? "Demo data enabled" : sensorData.authenticated ? "Supabase account connected" : "Sign in for sensor data"}</small></span>
            <CircleHelp size={15} />
          </div>
          <div className="profile-row">
            <span className="profile-avatar">GG</span>
            <span className="profile-copy"><strong>Local workspace</strong><small>Browser-only storage</small></span>
            <Settings size={16} />
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            <button className="mobile-menu" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}><Menu size={19} /></button>
            <div className="breadcrumb"><span>Workspace</span><span className="crumb-slash">/</span><strong>{section}</strong></div>
          </div>
          <div className="topbar-actions">
            <label className="demo-toggle">
              <span className={`switch ${demoMode ? "on" : ""}`}><span /></span>
              <input type="checkbox" checked={demoMode} onChange={toggleDemo} />
              <span>Demo mode</span>
            </label>
            <button className="icon-button search-button" aria-label="Search" title="Search is not available yet"><Search size={18} /></button>
            <button className="icon-button notification-button" aria-label="Notifications" title="Alert history is not connected"><Bell size={18} /></button>
            <span className="topbar-divider" />
            <span className="user-badge">GG</span>
          </div>
        </header>

        {demoMode && <div className="demo-banner"><span className="demo-pulse" /><strong>DEMO MODE</strong><span>All readings and trends are simulated—not connected to hardware.</span><button onClick={toggleDemo}>Turn off</button></div>}
        {(error || workspace.error) && <div className="error-banner" role="alert"><ShieldAlert size={16} />{error || workspace.error}<button onClick={() => setError("")} aria-label="Dismiss error"><X size={16} /></button></div>}
        {sensorData.error && <div className="error-banner" role="alert"><ShieldAlert size={16} />{sensorData.error}</div>}

        <div className="page-content">
          <div className="page-heading">
            <div>
              <div className="date-line"><CalendarDays size={14} />{dateLabel || "Storage workspace"}<span className="live-time"><Clock3 size={13} />Local time</span></div>
              <h1>{section === "Overview" ? "Good day, farmer" : section}</h1>
              <p>{section === "Overview" ? "Here’s what’s happening across your storage today." : sectionDescription(section)}</p>
            </div>
            <div className="heading-actions">
              <button className="button button-secondary" onClick={() => setModal("facility")}><Plus size={16} />New facility</button>
              <button className="button button-primary" onClick={() => setModal("zone")} disabled={facilities.length === 0}><Plus size={16} />Add storage zone</button>
            </div>
          </div>

          <section className="context-bar" aria-label="Selected storage context">
            <div className="context-title"><span className="context-icon"><MapPin size={16} /></span><span><strong>Active context</strong><small>Choose the area you want to monitor</small></span></div>
            <div className="context-selects">
              <label><span>Facility</span><select value={selectedFacility?.id ?? ""} onChange={(event) => chooseFacility(event.target.value)} disabled={visibleFacilities.length === 0}><option value="">Select facility</option>{visibleFacilities.map((facility) => <option key={facility.id} value={facility.id}>{facility.name}</option>)}</select></label>
              <label><span>Zone</span><select value={selectedZone?.id ?? ""} onChange={(event) => setSelectedZoneId(event.target.value)} disabled={!selectedFacility?.zones.length}><option value="">Select zone</option>{selectedFacility?.zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label>
              <div className="context-crop"><span>Crop / batch</span><strong>{selectedZone ? `${selectedZone.crop} · ${selectedZone.batchName || "No batch assigned"}` : "No crop selected"}</strong></div>
            </div>
          </section>

          {section === "Overview" && (
            <>
              <div className="section-title-row"><div><h2>Storage at a glance</h2><p>Current workspace status and environmental conditions</p></div><span className="updated-label">{facilities.length ? "Saved in this browser" : "Ready to configure"}</span></div>
              <div className="kpi-grid">
                <KpiCard icon={<Building2 size={18} />} tone="green" label="Facilities" value={String(visibleFacilities.length)} note={facilities.length ? "In this workspace" : "Create your first facility"} />
                <KpiCard icon={<Warehouse size={18} />} tone="blue" label="Storage zones" value={String(zoneCount)} note={zoneCount ? "Across selected facilities" : "No zones configured"} />
                <KpiCard icon={<Boxes size={18} />} tone="amber" label="Active batches" value={String(batchCount)} note={batchCount ? "Batch names recorded" : "No batches recorded"} />
                <KpiCard
                  icon={<Radio size={18} />}
                  tone="purple"
                  label="Active sensors"
                  value={sensorData.activeSensorCount === null ? "—" : String(sensorData.activeSensorCount)}
                  note={sensorData.authenticated ? "Authorized storage units" : "Sign in to load sensor status"}
                />
              </div>

              <div className="environment-heading"><div><h2>Environmental monitoring</h2><p>{demoMode ? "Air conditions for the selected demo zone" : <>Latest reading in your authorized storage{latestSensorUpdate ? ` · Last update ${new Date(latestSensorUpdate).toLocaleString()}` : ""}</>}</p></div>{demoMode && <span className="simulated-pill"><span />SIMULATED READINGS</span>}</div>
              <div className="environment-grid">
                <SensorCard icon={<Thermometer size={19} />} label="Air temperature" value={reading?.temperature !== null && reading?.temperature !== undefined ? `${reading.temperature.toFixed(1)}°` : "—"} unit={reading?.temperature !== null && reading?.temperature !== undefined ? "C" : ""} foot={demoMode && reading ? "Sample DHT22 · simulated" : reading?.temperature !== null && reading?.temperature !== undefined ? "Stored sensor measurement" : "Waiting for sensor data"} state={demoMode && reading ? "Demo sample" : reading?.temperature !== null && reading?.temperature !== undefined ? "Live" : "No reading"} tone="green" />
                <SensorCard icon={<Droplets size={19} />} label="Relative humidity" value={reading?.humidity !== null && reading?.humidity !== undefined ? `${reading.humidity}` : "—"} unit={reading?.humidity !== null && reading?.humidity !== undefined ? "% RH" : ""} foot={demoMode && reading ? "Air relative humidity · simulated" : reading?.humidity !== null && reading?.humidity !== undefined ? "Air relative humidity" : "Waiting for sensor data"} state={demoMode && reading ? "Demo sample" : reading?.humidity !== null && reading?.humidity !== undefined ? "Live" : "No reading"} tone="blue" />
                <SensorCard icon={<Activity size={19} />} label="MQ-2 raw response" value={reading?.adc !== null && reading?.adc !== undefined ? String(reading.adc) : "—"} unit={reading?.adc !== null && reading?.adc !== undefined ? "ADC" : ""} foot="Raw sensor reading only—not ppm" state={demoMode && reading ? "Demo sample" : reading?.adc !== null && reading?.adc !== undefined ? "Live" : "No reading"} tone="amber" />
                <SensorCard icon={<Fan size={19} />} label="Ventilation" value={reading?.fanStatus === null || reading?.fanStatus === undefined ? "—" : reading.fanStatus ? "On" : "Off"} unit="" foot={reading?.fanStatus === null || reading?.fanStatus === undefined ? "Fan status not available" : "Reported device state"} state={reading?.fanStatus === null || reading?.fanStatus === undefined ? "Unavailable" : "Reported"} tone="purple" />
              </div>

              {!demoMode && (
                <section className="panel live-zones-panel" aria-live="polite">
                  <div className="panel-heading">
                    <div>
                      <h3>Latest readings by zone</h3>
                      <p>Authorized sensor data · live updates with 30-second refresh</p>
                    </div>
                    <span className="updated-label">
                      {!sensorData.authenticated
                        ? "Sign-in required"
                        : sensorData.refreshing
                          ? "Refreshing…"
                          : sensorData.error
                            ? "Refresh issue"
                            : "Auto-refresh: 30s"}
                    </span>
                  </div>
                  {!sensorData.authenticated ? (
                    <div className="live-zones-empty">Sign in from Settings to load readings for your authorized zones.</div>
                  ) : sensorData.zoneReadings.length === 0 ? (
                    <div className="live-zones-empty">
                      {sensorData.refreshing ? "Loading registered storage zones…" : "No authorized storage zones were found."}
                    </div>
                  ) : (
                    <div className="live-zones-grid">
                      {sensorData.zoneReadings.map(({ zone, reading: zoneReading }) => (
                        <article className="live-zone-card" key={zone.id}>
                          <div className="live-zone-heading">
                            <strong>{zone.name}</strong>
                            <span>{zone.number !== null ? `Zone ${zone.number}` : "Registered zone"}</span>
                          </div>
                          <div className="live-zone-metrics">
                            <div>
                              <span>Temperature</span>
                              <strong>{zoneReading?.temperature === null || zoneReading?.temperature === undefined ? "—" : `${zoneReading.temperature.toFixed(1)} °C`}</strong>
                            </div>
                            <div>
                              <span>Humidity</span>
                              <strong>{zoneReading?.humidity === null || zoneReading?.humidity === undefined ? "—" : `${zoneReading.humidity.toFixed(1)} %`}</strong>
                            </div>
                            <div>
                              <span>MQ-2 raw</span>
                              <strong>{zoneReading?.gas_raw_value === null || zoneReading?.gas_raw_value === undefined ? "—" : `${zoneReading.gas_raw_value} ADC`}</strong>
                            </div>
                          </div>
                          <time className="live-zone-timestamp" dateTime={zoneReading?.recorded_at}>
                            {zoneReading ? `Latest reading: ${new Date(zoneReading.recorded_at).toLocaleString()}` : "No readings yet"}
                          </time>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              )}

              <div className="charts-row">
                {demoMode ? <DemoChart crop={crop} kind="temperature" /> : <SensorHistoryChart readings={sensorData.readings} metric="temperature" title="Air temperature history" unit="°C" kind="temperature" />}
                {demoMode ? <DemoChart crop={crop} kind="humidity" /> : <SensorHistoryChart readings={sensorData.readings} metric="humidity" title="Relative humidity history" unit="% RH" kind="humidity" />}
                {!demoMode && <SensorHistoryChart readings={sensorData.readings} metric="gas_raw_value" title="MQ-2 raw history" unit="ADC" kind="gas" />}
              </div>

              <div className="bottom-grid">
                <section className="panel zone-panel">
                  <div className="panel-heading"><div><h3>Storage zones</h3><p>{visibleFacilities.length ? `${zoneCount} zones configured` : "Your facilities will appear here"}</p></div><button className="text-button" onClick={() => activateSection("Storage Zones")}>View all <ArrowUpRight size={14} /></button></div>
                  {selectedFacility?.zones.length ? (
                    <div className="zone-list">{selectedFacility.zones.slice(0, 4).map((zone) => <button key={zone.id} className={`zone-row ${zone.id === selectedZone?.id ? "selected" : ""}`} onClick={() => setSelectedZoneId(zone.id)}><span className={`zone-avatar crop-${zone.crop.toLowerCase()}`}>{zone.crop.slice(0, 1)}</span><span className="zone-info"><strong>{zone.name}</strong><small>{zone.crop} · {zone.batchName || "No batch"}</small></span><span className={`zone-status ${demoMode ? "sample" : ""}`}><i />{demoMode ? "Demo" : "No data"}</span><ChevronDown size={15} className="zone-chevron" /></button>)}</div>
                  ) : <div className="panel-empty"><Warehouse size={20} /><strong>No storage zones yet</strong><span>Create a facility and add a zone to get started.</span><button className="text-button" onClick={() => setModal("facility")}>Set up workspace <ArrowUpRight size={14} /></button></div>}
                </section>
                <section className="panel status-panel">
                  <div className="panel-heading"><div><h3>System status</h3><p>Data sources and model readiness</p></div><span className="status-icon"><Activity size={17} /></span></div>
                  <div className="status-list">
                    <StatusRow icon={<Radio size={15} />} label="Sensor connection" value={demoMode ? "Demo only" : sensorData.authenticated ? sensorData.activeSensorCount === null ? "Loading" : `${sensorData.activeSensorCount} active` : "Sign in required"} tone={demoMode ? "yellow" : "gray"} />
                    <StatusRow icon={<BrainCircuit size={15} />} label="AI prediction model" value="Unavailable" tone="gray" />
                    <StatusRow icon={<BookOpen size={15} />} label="Verified crop thresholds" value="Not configured" tone="gray" />
                    <StatusRow icon={<Fan size={15} />} label="Automatic ventilation" value="Disabled" tone="gray" />
                  </div>
                  <div className="safe-note"><ShieldAlert size={15} /><span>Predictions and automatic fan control stay unavailable until validated data, verified rules, and tested hardware are configured.</span></div>
                </section>
              </div>
            </>
          )}

          {section === "Storage Facilities" && <FacilityView facilities={facilities} onAdd={() => setModal("facility")} onSelect={(id) => { chooseFacility(id); activateSection("Overview"); }} />}
          {section === "Storage Zones" && <ZoneView facilities={visibleFacilities} demoMode={demoMode} onAdd={() => setModal("zone")} onSelect={(facilityId, zoneId) => { chooseFacility(facilityId); setSelectedZoneId(zoneId); activateSection("Overview"); }} onDelete={deleteZone} />}
          {section === "Crop Batches" && <BatchView facilities={visibleFacilities} demoMode={demoMode} />}
          {section === "Live Monitoring" && <MonitoringView reading={reading} history={sensorData.readings} crop={crop} demoMode={demoMode} />}
          {section === "Devices & Sensors" && <DeviceManagementPanel />}
          {section !== "Overview" && !isContextPage && !["Storage Facilities", "Storage Zones", "Crop Batches", "Devices & Sensors"].includes(section) && (
            <ModuleView section={section} demoMode={demoMode} history={sensorData.readings} />
          )}
        </div>
      </main>

      {modal && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(null); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-head"><div><span className="eyebrow">WORKSPACE SETUP</span><h2 id="modal-title">{modal === "facility" ? "Create a facility" : "Add a storage zone"}</h2></div><button className="icon-button" aria-label="Close dialog" onClick={() => setModal(null)}><X size={18} /></button></div>
        {modal === "facility" ? <form onSubmit={addFacility}><label className="form-field">Facility name<input name="facilityName" placeholder="e.g. Main Storage Facility" required maxLength={80} autoFocus /></label><label className="form-field">Location <span className="optional">(optional)</span><input name="location" placeholder="Town, region" maxLength={100} /></label><div className="modal-foot"><span>Stored in this browser only</span><button className="button button-primary" type="submit"><Plus size={16} />Create facility</button></div></form> : <form onSubmit={addZone}><label className="form-field">Facility<select name="facilityId" defaultValue={selectedFacility?.id ?? ""} required>{facilities.map((facility) => <option key={facility.id} value={facility.id}>{facility.name}</option>)}</select></label><label className="form-field">Zone name<input name="zoneName" placeholder="e.g. Zone 01" required maxLength={60} autoFocus /></label><label className="form-field">Crop<select name="crop" defaultValue="Potato">{CROPS.map((item) => <option key={item}>{item}</option>)}</select></label><label className="form-field">Batch name <span className="optional">(optional)</span><input name="batchName" placeholder="e.g. POT-001" maxLength={60} /></label><label className="form-field">Storage capacity <span className="optional">(kg, optional)</span><input name="capacity" type="number" min="0" step="1" defaultValue="0" /></label><div className="modal-foot"><span>Crop thresholds are not yet configured</span><button className="button button-primary" type="submit"><Plus size={16} />Add zone</button></div></form>}</div></div>}
    </div>
  );
}

function KpiCard({ icon, tone, label, value, note }: { icon: ReactNode; tone: string; label: string; value: string; note: string }) {
  return <article className="kpi-card"><IconBadge tone={tone as "green" | "blue" | "amber" | "purple"}>{icon}</IconBadge><div className="kpi-label">{label}</div><div className="kpi-value">{value}</div><div className="kpi-note">{note}</div></article>;
}

function SensorCard({ icon, label, value, unit, foot, state, tone }: { icon: ReactNode; label: string; value: string; unit: string; foot: string; state: string; tone: string }) {
  return <article className="sensor-card"><div className="sensor-top"><IconBadge tone={tone as "green" | "blue" | "amber" | "purple"}>{icon}</IconBadge><span className={`sensor-state ${value === "—" ? "disconnected" : "connected"}`}><i />{state}</span></div><span className="sensor-label">{label}</span><div className="sensor-value">{value}<small>{unit}</small></div><span className="sensor-foot">{foot}</span></article>;
}

function StatusRow({ icon, label, value, tone }: { icon: ReactNode; label: string; value: string; tone: string }) {
  return <div className="status-row"><span className="status-row-icon">{icon}</span><span className="status-row-label">{label}</span><span className={`status-value ${tone}`}><i />{value}</span></div>;
}

function sectionDescription(section: Section) {
  const descriptions: Partial<Record<Section, string>> = {
    "Storage Facilities": "Organize storage locations and keep facility details in one place.",
    "Storage Zones": "Assign one supported crop to each zone and manage its batch metadata.",
    "Crop Batches": "Review the batches recorded in your local workspace.",
    "Live Monitoring": "Sensor readings are shown only when devices are connected or demo mode is enabled.",
  };
  return descriptions[section] ?? "Explore this GrainGuard module. Unavailable capabilities are clearly identified.";
}

function FacilityView({ facilities, onAdd, onSelect }: { facilities: Facility[]; onAdd: () => void; onSelect: (id: string) => void }) {
  return <section className="panel directory-panel"><div className="panel-heading"><div><h3>Your facilities</h3><p>Facility details are stored locally in this browser.</p></div><button className="button button-primary small" onClick={onAdd}><Plus size={15} />New facility</button></div>{facilities.length ? <div className="facility-grid">{facilities.map((facility) => <button className="facility-card" key={facility.id} onClick={() => onSelect(facility.id)}><span className="facility-card-icon"><Building2 size={19} /></span><span className="facility-card-title">{facility.name}</span><span className="facility-card-location"><MapPin size={13} />{facility.location}</span><span className="facility-card-meta">{facility.zones.length} zones <ArrowUpRight size={14} /></span></button>)}</div> : <div className="panel-empty large"><Building2 size={23} /><strong>No facilities have been added</strong><span>Create a facility to start configuring storage zones and crop batches.</span><button className="button button-primary small" onClick={onAdd}><Plus size={15} />Create first facility</button></div>}</section>;
}

function ZoneView({ facilities, demoMode, onAdd, onSelect, onDelete }: { facilities: Facility[]; demoMode: boolean; onAdd: () => void; onSelect: (facilityId: string, zoneId: string) => void; onDelete: (facilityId: string, zoneId: string) => void }) {
  const zones = facilities.flatMap((facility) => facility.zones.map((zone) => ({ facility, zone })));
  return <section className="panel directory-panel"><div className="panel-heading"><div><h3>Configured storage zones</h3><p>A zone has one crop assignment; mixed-crop zones are not supported.</p></div><button className="button button-primary small" onClick={onAdd} disabled={!facilities.length}><Plus size={15} />Add zone</button></div>{zones.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Zone</th><th>Facility</th><th>Crop</th><th>Batch</th><th>Capacity</th><th>Data</th><th /></tr></thead><tbody>{zones.map(({ facility, zone }) => <tr key={zone.id}><td><button className="table-link" onClick={() => onSelect(facility.id, zone.id)}>{zone.name}</button></td><td>{facility.name}</td><td><span className={`crop-pill crop-${zone.crop.toLowerCase()}`}>{zone.crop}</span></td><td>{zone.batchName || "—"}</td><td>{zone.capacity ? `${zone.capacity.toLocaleString()} kg` : "—"}</td><td><span className={`zone-status ${demoMode ? "sample" : ""}`}><i />{demoMode ? "Simulated" : "No readings"}</span></td><td><button className="icon-button delete-button" aria-label={`Delete ${zone.name}`} onClick={() => onDelete(facility.id, zone.id)} title="Delete zone"><X size={15} /></button></td></tr>)}</tbody></table></div> : <div className="panel-empty large"><Warehouse size={23} /><strong>No zones configured</strong><span>Create a facility first, then add a crop-specific zone.</span><button className="button button-primary small" onClick={onAdd} disabled={!facilities.length}><Plus size={15} />Add a zone</button></div>}</section>;
}

function BatchView({ facilities, demoMode }: { facilities: Facility[]; demoMode: boolean }) {
  const batches = facilities.flatMap((facility) => facility.zones.filter((zone) => zone.batchName).map((zone) => ({ facility, zone })));
  return <section className="panel directory-panel"><div className="panel-heading"><div><h3>Crop batches</h3><p>Batch metadata is associated with its storage zone.</p></div><span className="read-only-badge">ZONE-ASSIGNED</span></div>{batches.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Batch ID</th><th>Crop</th><th>Facility / zone</th><th>Capacity</th><th>Data provenance</th></tr></thead><tbody>{batches.map(({ facility, zone }) => <tr key={zone.id}><td className="mono">{zone.batchName}</td><td><span className={`crop-pill crop-${zone.crop.toLowerCase()}`}>{zone.crop}</span></td><td>{facility.name} / {zone.name}</td><td>{zone.capacity ? `${zone.capacity.toLocaleString()} kg` : "—"}</td><td>{demoMode && facility.id.startsWith("demo-") ? "Simulated demo" : "User-entered details"}</td></tr>)}</tbody></table></div> : <div className="panel-empty large"><Boxes size={23} /><strong>No batches recorded</strong><span>Add a batch name while creating a storage zone.</span></div>}</section>;
}

function MonitoringView({ reading, history, crop, demoMode }: { reading: DisplayReading | null; history: LiveSensorReading[]; crop: Crop; demoMode: boolean }) {
  const temperature = reading?.temperature ?? null;
  const humidity = reading?.humidity ?? null;
  const adc = reading?.adc ?? null;
  return (
    <>
      <div className="monitoring-layout">
        <section className="panel monitoring-main">
          <div className="panel-heading">
            <div><h3>Current readings</h3><p>{demoMode ? "Simulated values for exploration only" : "Latest valid reading across your authorized storage"}</p></div>
            <span className={`connection-badge ${demoMode ? "demo" : ""}`}><i />{demoMode ? "DEMO DATA" : reading ? "LIVE DATA" : "WAITING"}</span>
          </div>
          {reading ? (
            <div className="monitor-reading-grid">
              <SensorCard icon={<Thermometer size={19} />} label="Air temperature" value={temperature === null ? "—" : temperature.toFixed(1)} unit={temperature === null ? "" : "°C"} foot={demoMode ? "DHT22 · synthetic sample" : "Stored sensor measurement"} state={temperature === null ? "No reading" : demoMode ? "Simulated" : "Live"} tone="green" />
              <SensorCard icon={<Droplets size={19} />} label="Relative humidity" value={humidity === null ? "—" : String(humidity)} unit={humidity === null ? "" : "% RH"} foot={demoMode ? "DHT22 · synthetic sample" : "Air relative humidity"} state={humidity === null ? "No reading" : demoMode ? "Simulated" : "Live"} tone="blue" />
              <SensorCard icon={<Activity size={19} />} label="MQ-2 response" value={adc === null ? "—" : String(adc)} unit={adc === null ? "" : "ADC"} foot="Raw value—not gas ppm" state={adc === null ? "No reading" : demoMode ? "Simulated" : "Live"} tone="amber" />
            </div>
          ) : (
            <div className="monitor-empty"><Radio size={26} /><h3>Waiting for sensor data</h3><p>Sign in, register an authorized sensor, then send readings through the secure ingestion endpoint. No readings are invented.</p></div>
          )}
        </section>
        <aside className="panel monitoring-aside">
          <div className="panel-heading"><div><h3>Sensor limitations</h3><p>Measurement context</p></div><CircleHelp size={17} /></div>
          <ul className="limitation-list">
            <li><Check size={15} /><span>DHT22 reports <strong>air temperature</strong> and relative humidity, not crop moisture.</span></li>
            <li><Check size={15} /><span>MQ-2 is shown as raw ADC response; no validated gas calibration is configured.</span></li>
            <li><Check size={15} /><span>Sensor readings alone cannot confirm disease or pathogen presence.</span></li>
          </ul>
          <div className="crop-context-card"><span className={`crop-pill crop-${crop.toLowerCase()}`}>{crop}</span><p>Crop-specific requirements are not yet configured from verified references.</p><strong>Condition status: UNKNOWN</strong></div>
        </aside>
      </div>
      {!demoMode && (
        <div className="charts-row">
          <SensorHistoryChart readings={history} metric="temperature" title="Air temperature history" unit="°C" kind="temperature" />
          <SensorHistoryChart readings={history} metric="humidity" title="Relative humidity history" unit="% RH" kind="humidity" />
          <SensorHistoryChart readings={history} metric="gas_raw_value" title="MQ-2 raw history" unit="ADC" kind="gas" />
        </div>
      )}
    </>
  );
}

function ModuleView({ section, demoMode, history }: { section: Section; demoMode: boolean; history: LiveSensorReading[] }) {
  const moduleInfo: Partial<Record<Section, { icon: typeof BrainCircuit; title: string; description: string; status: string; details: string[] }>> = {
    "AI Analysis": { icon: BrainCircuit, title: "AI model unavailable", description: "GrainGuard does not yet have a trained, validated crop-specific model connected.", status: "MODEL_UNAVAILABLE", details: ["No training data or validation results are configured.", "No predictions or confidence scores are generated.", "When available, model provenance and limitations will be shown with each result."] },
    "Problem Detection": { icon: ShieldAlert, title: "Problem detection is not configured", description: "Environmental readings alone are not sufficient to diagnose a crop disease or pathogen.", status: "INSUFFICIENT_DATA", details: ["No verified problem-classification model is configured.", "Manual inspection findings can be added in a future workflow.", "Unknown conditions will not be replaced with a guessed diagnosis."] },
    "Risk Forecast": { icon: ChartNoAxesCombined, title: "Risk assessment unavailable", description: "Risk forecasts require reliable historical readings and crop-specific evidence.", status: "UNKNOWN", details: ["No validated risk engine is connected.", "6, 12, and 24-hour predictions are not generated.", "There is no historical sensor data in this workspace."] },
    "Environmental Forecast": { icon: Activity, title: "Forecasting model unavailable", description: "No temperature or humidity forecast is being generated yet.", status: "MODEL_UNAVAILABLE", details: ["Forecast models require chronological sensor observations.", "No model metrics or synthetic accuracy claims are shown.", "Enable demo mode to explore clearly simulated trends on the overview."] },
    "Ventilation Control": { icon: Fan, title: "Automatic control is disabled", description: "Fan operation requires validated sensors, outside-air measurements, and tested hardware safeguards.", status: "SAFETY LOCKED", details: ["No fan controller is connected.", "No outside-air temperature or humidity is available.", "Manual override, emergency stop, runtime limits, and status confirmation are not implemented."] },
    Recommendations: { icon: Leaf, title: "No verified recommendations available", description: "Crop-specific actions are not displayed without verified evidence and sufficient context.", status: "INSUFFICIENT EVIDENCE", details: ["No scientific thresholds are configured.", "No chemical or pathogen-specific treatments are suggested.", "Knowledge base references have not yet been added."] },
    "Historical Data": { icon: History, title: "Sensor history", description: "Browse the latest authorized sensor observations; older-range exports are not connected yet.", status: "BOUNDED LIVE QUERY", details: ["Charts use actual database readings when available.", "The dashboard limits loaded history to 48 records.", "Demo readings are never stored as sensor observations."] },
    Reports: { icon: FileChartColumn, title: "Reports are not available yet", description: "No reports are generated from missing or simulated-only measurements.", status: "NOT CONFIGURED", details: ["Facility and zone metadata can be exported in a later phase.", "Energy reports require actual power measurements.", "Any future demo report will be clearly marked simulated."] },
    "Knowledge Base": { icon: BookOpen, title: "Research library not configured", description: "No crop thresholds or research references have been added yet.", status: "NO VERIFIED SOURCES", details: ["No storage range is assumed to apply to every crop.", "Verified sources will include scope and limitations.", "Unavailable information will remain explicitly unknown."] },
    Settings: { icon: Settings, title: "Workspace settings", description: "Facility setup remains browser-local; Supabase account access is available for authorized sensor data.", status: demoMode ? "DEMO ENABLED" : "LOCAL + DATABASE", details: ["Browser-local facility metadata is not synced to the database yet.", "Sensor readings are visible only to an authenticated owner under row-level security.", "Demo mode can be turned off from the top bar."] },
  };
  const info = moduleInfo[section];
  if (!info) return null;
  const Icon = info.icon;
  return (
    <>
      <div className="module-layout">
        <section className="panel module-card">
          <div className="module-icon"><Icon size={23} /></div>
          <span className="eyebrow">CAPABILITY STATUS</span>
          <h2>{info.title}</h2>
          <p>{info.description}</p>
          <span className="module-status">{info.status}</span>
          <div className="module-detail-list">{info.details.map((detail) => <div key={detail}><Check size={15} /><span>{detail}</span></div>)}</div>
        </section>
        <aside className="panel phase-card">
          <span className="eyebrow">{section === "Settings" ? "ACCOUNT ACCESS" : "IMPLEMENTATION PHASE"}</span>
          {section === "Settings" ? <AccountPanel /> : <>
            <h3>Storage foundation</h3>
            <p>This build preserves the GrainGuard interface and adds a protected Supabase sensor-data path.</p>
            <div className="phase-step active"><span>01</span><div><strong>Workspace foundation</strong><small>In place</small></div></div>
            <div className="phase-step"><span>02</span><div><strong>Database & sensor ingestion</strong><small>Implemented; requires Supabase setup</small></div></div>
            <div className="phase-step"><span>03</span><div><strong>Validated AI & hardware verification</strong><small>Awaiting field evidence and physical device</small></div></div>
          </>}
        </aside>
      </div>
      {section === "Historical Data" && !demoMode && (
        <div className="charts-row history-module-charts">
          <SensorHistoryChart readings={history} metric="temperature" title="Air temperature history" unit="°C" kind="temperature" />
          <SensorHistoryChart readings={history} metric="humidity" title="Relative humidity history" unit="% RH" kind="humidity" />
          <SensorHistoryChart readings={history} metric="gas_raw_value" title="MQ-2 raw history" unit="ADC" kind="gas" />
        </div>
      )}
    </>
  );
}
