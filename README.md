# GrainGuard

GrainGuard is a crop-aware storage monitoring application for potato, onion, garlic, ginger, and chili. The existing responsive dashboard remains in place and now has an optional Supabase data path for authenticated sensor history, realtime updates, workspace synchronization, and secure ESP32 ingestion.

## Run locally

Requirements: Node.js 20.9 or later and npm.

```powershell
npm.cmd install
Copy-Item .env.example .env.local
# Set the Supabase values described in docs/backend-setup.md
npm.cmd run dev
```

Open [http://localhost:3000](http://localhost:3000).

Checks:

```powershell
npm.cmd run test:sensors
npm.cmd run lint
npm.cmd run build
```

## Current functionality

- Create facilities, crop zones, and optional batch metadata in the existing UI.
- Keep workspace metadata in browser storage and synchronize it to the signed-in user's Supabase account when configured.
- Read the latest valid sensor values and a bounded history for the selected zone, with Supabase Realtime updates and owner-level RLS.
- Register a sensor through an authenticated server endpoint and ingest ESP32 readings through `POST /api/v1/sensors/readings`.
- Preserve explicit demo labeling; synthetic samples are never presented as actual readings.
- Keep unavailable scientific thresholds and unvalidated model predictions unavailable.

## Data and safety limitations

- Supabase must be configured and the migration applied before database features work.
- No physical ESP32 firmware was present in the inspected project. The included Arduino sketch is a configurable DHT22/MQ-2 example, not a confirmed match for your board, wiring, or pins.
- Existing model artifacts and inference outputs are documented as `SYNTHETIC_SIMULATION`; they are not field-validated and are not used to produce predictions.
- No verified crop-storage thresholds, disease diagnosis, fan control, or safety-reviewed ventilation recommendations are connected.
- Facility metadata stays usable in browser storage; only authenticated sessions synchronize it to Supabase. Sensor registration is API-driven, and per-device online/offline health, manual inspections, alert management, and prediction retrieval do not yet have complete UI workflows.
- Do not use demo data or this initial backend integration to make real storage or ventilation decisions.

## Setup and API documentation

- [Supabase setup and security](./docs/backend-setup.md)
- [Sensor and application API](./docs/api.md)
- [ESP32 example and wiring configuration](./examples/esp32/README.md)
- [Verification status and tests](./docs/testing.md)
