# Supabase setup

## 1. Create the project and apply the schema

Create a Supabase project, then apply `supabase/migrations/202611140001_initial_grainguard_schema.sql` using the Supabase SQL editor or the Supabase CLI migration workflow. The migration creates the normalized schema, five crop reference rows, indexes, owner-level RLS policies, server-only device credential tables, and the Realtime publication entry for sensor readings.

The migration intentionally does not seed crop temperature or humidity limits. ADC and environmental bounds in the ingestion API are input validation limits, not crop recommendations.

## 2. Configure the application

Copy `.env.example` to `.env.local` in the project root and set:

- `NEXT_PUBLIC_SUPABASE_URL`: project URL.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`: publishable/anon key; it is intended for browser use and protected by RLS.
- `SUPABASE_SERVICE_ROLE_KEY`: service-role secret, server-only. Never prefix it with `NEXT_PUBLIC_`, put it in firmware, or commit it.

Restart `npm run dev` after changing environment variables. `.env.local` is ignored by Git.

## 3. Authentication and workspace data

The Settings area provides Supabase email/password sign-up and sign-in. Supabase email confirmation follows the project's Auth settings. After sign-in, existing browser-local facilities and zones are upserted into `storage_units` and `storage_zones`; optional batch names are synchronized to `storage_batches`. RLS scopes those records and sensor queries to the signed-in owner.

Sensor readings and active sensor counts shown by the dashboard are queried as the signed-in user and remain subject to RLS. Realtime subscriptions are cleaned up when the component unmounts or the account/zone changes.

Browser-local workspace data is not an authoritative cloud backup. Keep an export/backup before clearing browser storage. The UI currently has no facility-delete or full batch-edit workflow.

## 4. Sensor provisioning

Create a facility and zone while signed in, then allow synchronization to finish. Find the resulting UUIDs in the Supabase Table Editor (`storage_units` and `storage_zones`) for that owner. Register a sensor using `POST /api/v1/sensors/register` as described in [api.md](./api.md). The response contains a device-specific key once; copy it directly to the ESP32's private configuration.

Only a SHA-256 hash of the device key is stored. The service-role key remains on the server. Deactivate or delete the sensor in Supabase to revoke its device credential.

## 5. Realtime and operations

Apply the migrations in order. The initial migration adds `sensor_readings` to `supabase_realtime` when that publication exists. The following fault-metadata migration adds a direct zone reference and resolution reason to `sensor_fault_events`. Confirm Realtime is enabled for the readings table and that authenticated users can `SELECT` rows allowed by RLS. Do not remove RLS to make subscriptions work.

The API uses a per-process limit of 60 authenticated requests/minute per sensor. This is best-effort only; serverless/multi-instance deployments must also enforce a shared rate limit at an API gateway or edge layer. Review Supabase logs and the `sensor_ingestion_events` audit table without logging device keys or raw request bodies.

Optional ingestion bounds can be narrowed in `.env.local`: `SENSOR_TEMPERATURE_MIN_C`, `SENSOR_TEMPERATURE_MAX_C`, `SENSOR_HUMIDITY_MIN_PERCENT`, `SENSOR_HUMIDITY_MAX_PERCENT`, and `SENSOR_GAS_RAW_MAX`. Temperature limits cannot exceed the DHT22's nominal range; humidity remains within 0–100%; ADC maximum cannot exceed 4095. These are sensor/input validation bounds, not crop storage recommendations. `SENSOR_OFFLINE_AFTER_SECONDS` controls the authenticated status API's stale-reading threshold (default 180 seconds; valid range 60–86400).

## 6. Retention and performance

Sensor readings have indexes for sensor, zone, storage unit, and timestamp. The dashboard requests at most 48 readings at a time. This migration does not partition or automatically delete sensor history. Define a retention/archival policy and test PostgreSQL partitioning before the table reaches production-scale volume; never delete readings without an explicit retention decision and backup.

## 7. ML provenance

The adjacent project model metadata reports `SYNTHETIC_SIMULATION_BENCHMARK` and `real_world_generalization: UNVERIFIED`; the existing FastAPI integration also uses synthetic benchmarks, hardcoded crop ranges, and rule-based output. GrainGuard therefore does not invoke that API or present its output as a validated prediction. Prediction tables are ready for a future, independently validated inference integration.
