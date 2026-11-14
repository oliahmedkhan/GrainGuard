# ESP32 examples

The recommended scalable sketch is [GrainGuardMultiZone](./GrainGuardMultiZone/README.md). It loads a dynamic per-zone LittleFS configuration and includes example maps for 3, 5, and 10 zones.

The sibling `GrainGuardSensor.ino` is a legacy single-sensor telemetry starter. It does not implement multi-zone fan control, sensor-fault handling, or command polling. Do not treat either sketch's example pins as hardware-verified. Check the exact ESP32 board, sensor breakout, voltage levels, driver polarity, wiring, and safeguards before connecting fans.
