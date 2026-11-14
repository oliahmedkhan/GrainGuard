import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const configDirectory = path.resolve(
  "examples",
  "esp32",
  "GrainGuardMultiZone",
  "data"
);

function readConfig(filename) {
  return JSON.parse(readFileSync(path.join(configDirectory, filename), "utf8"));
}

for (const [filename, expectedZones] of [
  ["zones-3.example.json", 3],
  ["zones-5.example.json", 5],
  ["zones-10.example.json", 10],
]) {
  test(`${filename} has ${expectedZones} valid, non-conflicting zone slots`, () => {
    const config = readConfig(filename);
    assert.equal(config.zones.length, expectedZones);
    assert.equal(config.hardware_confirmed, false);
    assert.equal(config.timing.sensor_fault_hold_ms, 120000);

    const gpioAssignments = [];
    const adsChannels = new Set();
    const mcpChannels = new Set();
    let hasAds = false;
    let hasMcp = false;

    if (config.outside_air) gpioAssignments.push(config.outside_air.gpio);

    for (const zone of config.zones) {
      assert.equal(zone.zone_id, "");
      assert.equal(zone.storage_unit_id, "");
      assert.equal(zone.sensor_code, "");
      assert.equal(zone.device_id, "");
      assert.equal(zone.device_api_key, "");
      assert.equal(zone.dht22.kind, "gpio");
      assert.deepEqual(zone.thresholds, {
        temperature_on_c: 30,
        temperature_off_c: 28,
        humidity_on_pct: 70,
        humidity_off_pct: 65,
      });

      gpioAssignments.push(zone.dht22.gpio);
      if (zone.mq2.kind === "esp32_adc") {
        gpioAssignments.push(zone.mq2.gpio);
      } else {
        assert.equal(zone.mq2.kind, "ads1115");
        assert.ok(["0x48", "0x49", "0x4A", "0x4B"].includes(zone.mq2.address));
        assert.ok(zone.mq2.channel >= 0 && zone.mq2.channel <= 3);
        const key = `${zone.mq2.address}:${zone.mq2.channel}`;
        assert.equal(adsChannels.has(key), false, `duplicate ADS1115 channel ${key}`);
        adsChannels.add(key);
        hasAds = true;
      }

      for (const output of [zone.fan, zone.led]) {
        if (output.kind === "gpio") {
          gpioAssignments.push(output.gpio);
          assert.equal(typeof output.active_high, "boolean");
        } else {
          assert.equal(output.kind, "mcp23017");
          assert.ok(["0x20", "0x21", "0x22", "0x23", "0x24", "0x25", "0x26", "0x27"].includes(output.address));
          assert.ok(output.channel >= 0 && output.channel <= 15);
          const key = `${output.address}:${output.channel}`;
          assert.equal(mcpChannels.has(key), false, `duplicate MCP23017 channel ${key}`);
          mcpChannels.add(key);
          hasMcp = true;
        }
      }
    }

    if (hasAds || hasMcp) gpioAssignments.push(config.i2c.sda_gpio, config.i2c.scl_gpio);
    assert.equal(
      new Set(gpioAssignments).size,
      gpioAssignments.length,
      "GPIO assignments must not conflict"
    );
    if (expectedZones === 10) {
      assert.equal(new Set([...adsChannels].map((key) => key.split(":")[0])).size, 3);
      assert.equal(new Set([...mcpChannels].map((key) => key.split(":")[0])).size, 2);
    }
  });
}
