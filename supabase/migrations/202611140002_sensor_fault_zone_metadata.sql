alter table public.sensor_fault_events
  add column zone_id uuid,
  add column resolution_reason text;

update public.sensor_fault_events fault
set zone_id = sensor.zone_id
from public.sensors sensor
where sensor.id = fault.sensor_id;

alter table public.sensor_fault_events
  alter column zone_id set not null,
  add constraint sensor_fault_events_zone_id_fkey
    foreign key (zone_id) references public.storage_zones (id) on delete cascade,
  add constraint sensor_fault_events_resolution_reason_check
    check (
      resolution_reason is null or
      resolution_reason in ('sensor_recovered', 'manual_inspection_reset')
    );

create index sensor_fault_events_zone_detected_idx
  on public.sensor_fault_events (zone_id, detected_at desc);
