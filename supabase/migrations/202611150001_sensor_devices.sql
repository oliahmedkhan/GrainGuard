create table public.sensor_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  storage_unit_id uuid not null,
  physical_device_id text not null
    check (length(trim(physical_device_id)) between 3 and 100),
  device_name text not null
    check (length(trim(device_name)) between 1 and 100),
  status text not null default 'active'
    check (status in ('active', 'inactive', 'maintenance')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (storage_unit_id, user_id)
    references public.storage_units (id, user_id) on delete cascade,
  unique (id, storage_unit_id, physical_device_id),
  unique (user_id, storage_unit_id, physical_device_id)
);

create trigger sensor_devices_set_updated_at
  before update on public.sensor_devices
  for each row execute function public.set_updated_at();

insert into public.sensor_devices (
  user_id,
  storage_unit_id,
  physical_device_id,
  device_name,
  status
)
select
  u.user_id,
  s.storage_unit_id,
  s.esp32_device_id,
  coalesce(max(nullif(trim(s.device_name), '')), s.esp32_device_id),
  case when bool_or(s.status = 'active') then 'active' else 'inactive' end
from public.sensors s
join public.storage_units u on u.id = s.storage_unit_id
group by u.user_id, s.storage_unit_id, s.esp32_device_id
on conflict (user_id, storage_unit_id, physical_device_id) do nothing;

alter table public.sensors
  add column device_record_id uuid;

update public.sensors s
set device_record_id = d.id
from public.storage_units u, public.sensor_devices d
where u.id = s.storage_unit_id
  and d.user_id = u.user_id
  and d.storage_unit_id = s.storage_unit_id
  and d.physical_device_id = s.esp32_device_id;

alter table public.sensors
  alter column device_record_id set not null;

alter table public.sensors
  add constraint sensors_parent_device_fk
  foreign key (device_record_id, storage_unit_id, esp32_device_id)
  references public.sensor_devices (id, storage_unit_id, physical_device_id)
  on delete cascade;

create index sensor_devices_storage_unit_id_idx
  on public.sensor_devices (storage_unit_id);
create index sensors_device_record_id_idx
  on public.sensors (device_record_id);

alter table public.sensor_devices enable row level security;

create policy "Owners read sensor devices"
  on public.sensor_devices for select to authenticated
  using (
    user_id = (select auth.uid()) and exists (
      select 1 from public.storage_units u
      where u.id = storage_unit_id and u.user_id = (select auth.uid())
    )
  );

revoke all on public.sensor_devices from anon, authenticated;
grant select on public.sensor_devices to authenticated;
grant all on public.sensor_devices to service_role;
