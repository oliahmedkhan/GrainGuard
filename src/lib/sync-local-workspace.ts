"use client";

import type { Facility } from "@/lib/workspace-types";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function syncLocalWorkspaceToDatabase(
  facilities: Facility[],
  userId: string
): Promise<void> {
  const client = getSupabaseBrowserClient();
  if (!client) throw new Error("Supabase browser configuration is missing.");
  if (facilities.length === 0) return;

  const { data: crops, error: cropError } = await client
    .from("crops")
    .select("id, crop_code");
  if (cropError) throw new Error("Crop reference list could not be loaded.");
  const cropIds = new Map((crops ?? []).map((crop) => [crop.crop_code, crop.id]));

  const units = facilities.map((facility) => {
    if (!uuidPattern.test(facility.id)) {
      throw new Error("A locally saved facility has an ID that cannot be synchronized.");
    }
    return {
      id: facility.id,
      user_id: userId,
      storage_name: facility.name,
      location: facility.location,
    };
  });
  const { error: unitError } = await client
    .from("storage_units")
    .upsert(units, { onConflict: "id" });
  if (unitError) throw new Error("Facility data could not be synchronized with the database.");

  for (const facility of facilities) {
    const zones = facility.zones.map((zone) => {
      if (!uuidPattern.test(zone.id)) {
        throw new Error("A locally saved zone has an ID that cannot be synchronized.");
      }
      const cropId = cropIds.get(zone.crop.toUpperCase());
      if (!cropId) throw new Error(`The database crop reference for ${zone.crop} is missing.`);
      return {
        id: zone.id,
        storage_unit_id: facility.id,
        zone_name: zone.name,
        crop_id: cropId,
      };
    });

    if (zones.length > 0) {
      const { error: zoneError } = await client
        .from("storage_zones")
        .upsert(zones, { onConflict: "id" });
      if (zoneError) throw new Error(`Zones for ${facility.name} could not be synchronized.`);
    }

    for (const zone of facility.zones) {
      if (!zone.batchName) continue;
      const cropId = cropIds.get(zone.crop.toUpperCase());
      if (!cropId) throw new Error(`The database crop reference for ${zone.crop} is missing.`);
      const { error: batchError } = await client
        .from("storage_batches")
        .upsert(
          {
            storage_unit_id: facility.id,
            zone_id: zone.id,
            crop_id: cropId,
            batch_code: zone.batchName,
            quantity: null,
            unit: "kg",
            status: "active",
          },
          { onConflict: "zone_id,batch_code" }
        );
      if (batchError) throw new Error(`Batch ${zone.batchName} could not be synchronized.`);
    }
  }
}
