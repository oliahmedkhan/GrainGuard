# Verification report

This report distinguishes checks that can be run locally from live Supabase and hardware integration checks, which require project configuration and physical devices.

## Local checks

Run from the application directory:

```powershell
npm.cmd run test:sensors
npm.cmd run test:multizone
npm.cmd run lint
npm.cmd run build
```

## Results from this implementation pass

- `npm.cmd run test:sensors`: **passed**, 6 tests, 0 failures. Covers complete and partial readings, required measurements, ADC bounds, timestamps/timezones, configured ranges, and preservation of the original timestamp string.
- `npm.cmd run lint`: **passed**.
- `npm.cmd run build`: **passed**; Next.js compiled the application and both API routes and completed TypeScript checks.
- `npm.cmd audit --omit=dev`: **0 production dependency vulnerabilities**.

These are local code checks only. They do not prove that the migration applies on a hosted Supabase project or that hardware can reach the endpoint.

The multi-zone configuration tests parse all three JSON examples, check their zone counts, ensure identifiers and API-key fields remain blank, and detect GPIO/I2C channel conflicts. The Arduino IDE firmware was not compiled in this environment because Arduino CLI and an ESP32 board package were unavailable; no physical hardware tests were possible.

## Live integration checks still required

The following checks cannot be completed without a configured Supabase project and authenticated test accounts:

- Apply the SQL migration and verify each RLS policy with two different users.
- Sign-up, sign-in, and session expiration.
- Storage unit/zone/batch synchronization, including deleting a zone.
- Sensor registration, key secrecy/rotation, wrong-owner rejection, and device deactivation.
- Valid sensor insert, invalid-payload rejection audit, duplicate message rejection, and last-seen timestamp.
- Realtime update visibility and historic query pagination under RLS.
- Alerts, manual inspections, predictions, and sensor-fault event flows.

The ESP32 sketch additionally needs board/library configuration, the actual wiring/pins, Wi-Fi, a trusted TLS CA certificate, and a registered device key. No physical device was available for acceptance testing.

## Model test caveat

Local model metadata and the existing Python FastAPI integration mark outputs as synthetic simulation benchmarks; field generalization is unverified. They were deliberately not called by the application or reported as validated predictions. A model integration test must wait for real, independently validated artifacts and feature/data provenance.
