create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  email text,
  phone text,
  role text not null default 'farmer' check (role in ('farmer', 'researcher', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    new.email
  )
  on conflict (id) do update
    set email = excluded.email,
        updated_at = now();
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create table public.storage_units (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  storage_name text not null check (length(trim(storage_name)) between 1 and 120),
  location text,
  storage_type text,
  capacity numeric(12, 3) check (capacity is null or capacity >= 0),
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create trigger storage_units_set_updated_at
  before update on public.storage_units
  for each row execute function public.set_updated_at();

create table public.storage_zones (
  id uuid primary key default gen_random_uuid(),
  storage_unit_id uuid not null references public.storage_units (id) on delete cascade,
  zone_name text not null check (length(trim(zone_name)) between 1 and 100),
  zone_number integer check (zone_number is null or zone_number > 0),
  description text,
  created_at timestamptz not null default now(),
  unique (id, storage_unit_id),
  unique (storage_unit_id, zone_number)
);

create table public.crops (
  id uuid primary key default gen_random_uuid(),
  crop_name text not null,
  crop_code text not null unique,
  scientific_name text,
  created_at timestamptz not null default now()
);

insert into public.crops (crop_name, crop_code) values
  ('Potato', 'POTATO'),
  ('Onion', 'ONION'),
  ('Garlic', 'GARLIC'),
  ('Ginger', 'GINGER'),
  ('Chili', 'CHILI');

alter table public.storage_zones
  add column crop_id uuid references public.crops (id) on delete set null;

create table public.storage_batches (
  id uuid primary key default gen_random_uuid(),
  storage_unit_id uuid not null,
  zone_id uuid not null,
  crop_id uuid not null references public.crops (id),
  batch_code text not null,
  quantity numeric(12, 3) check (quantity is null or quantity >= 0),
  unit text not null default 'kg',
  variety text,
  storage_start_date date,
  expected_storage_duration integer check (
    expected_storage_duration is null or expected_storage_duration >= 0
  ),
  status text not null default 'active'
    check (status in ('active', 'completed', 'removed', 'unknown')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (zone_id, storage_unit_id)
    references public.storage_zones (id, storage_unit_id) on delete cascade,
  unique (id, storage_unit_id, zone_id),
  unique (zone_id, batch_code)
);

create trigger storage_batches_set_updated_at
  before update on public.storage_batches
  for each row execute function public.set_updated_at();

create table public.sensors (
  id uuid primary key default gen_random_uuid(),
  sensor_code text not null unique,
  storage_unit_id uuid not null,
  zone_id uuid not null,
  sensor_type text not null,
  device_name text,
  esp32_device_id text not null,
  installation_location text,
  status text not null default 'pending'
    check (status in ('pending', 'active', 'inactive', 'maintenance')),
  last_seen_at timestamptz,
  registered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (zone_id, storage_unit_id)
    references public.storage_zones (id, storage_unit_id) on delete cascade,
  unique (id, storage_unit_id, zone_id)
);

create trigger sensors_set_updated_at
  before update on public.sensors
  for each row execute function public.set_updated_at();

create table public.sensor_device_credentials (
  sensor_id uuid primary key references public.sensors (id) on delete cascade,
  api_key_hash text not null unique check (api_key_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

create table public.sensor_readings (
  id uuid primary key default gen_random_uuid(),
  sensor_id uuid not null,
  storage_unit_id uuid not null,
  zone_id uuid not null,
  message_id text not null check (length(trim(message_id)) between 1 and 128),
  temperature numeric(7, 3) check (temperature is null or temperature between -40 and 80),
  humidity numeric(7, 3) check (humidity is null or humidity between 0 and 100),
  gas_raw_value integer check (gas_raw_value is null or gas_raw_value between 0 and 4095),
  fan_status boolean,
  voltage numeric(8, 3) check (voltage is null or voltage >= 0),
  current numeric(8, 3) check (current is null or current >= 0),
  power numeric(10, 3) check (power is null or power >= 0),
  recorded_at timestamptz not null,
  recorded_at_raw text not null check (length(recorded_at_raw) between 1 and 64),
  received_at timestamptz not null default now(),
  data_quality_status text not null default 'VALID'
    check (data_quality_status in ('VALID', 'PARTIAL')),
  is_valid boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (sensor_id, storage_unit_id, zone_id)
    references public.sensors (id, storage_unit_id, zone_id) on delete restrict,
  unique (sensor_id, message_id),
  check (
    temperature is not null or humidity is not null or
    gas_raw_value is not null or fan_status is not null
  )
);

create function public.update_sensor_last_seen()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.sensors
  set last_seen_at = greatest(coalesce(last_seen_at, new.received_at), new.received_at),
      updated_at = new.received_at
  where id = new.sensor_id;
  return new;
end;
$$;

create trigger sensor_readings_update_last_seen
  after insert on public.sensor_readings
  for each row execute function public.update_sensor_last_seen();

create table public.sensor_ingestion_events (
  id uuid primary key default gen_random_uuid(),
  sensor_id uuid references public.sensors (id) on delete set null,
  message_id text,
  outcome text not null check (outcome in ('REJECTED', 'DUPLICATE', 'FAILED')),
  reason_code text not null,
  received_at timestamptz not null default now()
);

create table public.sensor_fault_events (
  id uuid primary key default gen_random_uuid(),
  sensor_id uuid not null references public.sensors (id) on delete cascade,
  reading_id uuid references public.sensor_readings (id) on delete set null,
  fault_type text not null,
  severity text not null check (severity in ('info', 'low', 'medium', 'high', 'critical')),
  description text,
  detected_at timestamptz not null default now(),
  resolution_status text not null default 'open'
    check (resolution_status in ('open', 'resolved', 'dismissed')),
  resolved_at timestamptz
);

create table public.predictions (
  id uuid primary key default gen_random_uuid(),
  storage_unit_id uuid not null references public.storage_units (id) on delete cascade,
  zone_id uuid references public.storage_zones (id) on delete set null,
  batch_id uuid references public.storage_batches (id) on delete set null,
  crop_id uuid references public.crops (id) on delete set null,
  prediction_type text not null check (prediction_type in (
    'temperature_forecast',
    'humidity_forecast',
    'sensor_fault_detection',
    'deterioration_risk_assessment',
    'environmental_risk_assessment',
    'ventilation_recommendation'
  )),
  forecast_horizon_hours integer check (
    forecast_horizon_hours is null or forecast_horizon_hours > 0
  ),
  predicted_value jsonb,
  prediction_class text,
  risk_level text,
  confidence numeric(6, 5) check (confidence is null or confidence between 0 and 1),
  model_name text,
  model_version text,
  generated_at timestamptz not null default now(),
  input_reading_timestamp timestamptz,
  status text not null check (status in (
    'AVAILABLE',
    'MODEL_NOT_AVAILABLE',
    'INSUFFICIENT_DATA',
    'UNVERIFIED_CROP_REFERENCE',
    'FAILED'
  ))
);

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  storage_unit_id uuid not null references public.storage_units (id) on delete cascade,
  zone_id uuid references public.storage_zones (id) on delete set null,
  sensor_id uuid references public.sensors (id) on delete set null,
  alert_type text not null,
  severity text not null check (severity in ('info', 'low', 'medium', 'high', 'critical')),
  title text not null,
  message text not null,
  is_read boolean not null default false,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table public.crop_storage_references (
  id uuid primary key default gen_random_uuid(),
  crop_id uuid not null references public.crops (id) on delete cascade,
  parameter_name text not null,
  minimum_value numeric,
  maximum_value numeric,
  unit text not null,
  source_reference text,
  verification_status text not null default 'UNVERIFIED'
    check (verification_status in ('UNVERIFIED', 'REVIEWED', 'VERIFIED')),
  updated_at timestamptz not null default now(),
  check (
    minimum_value is null or maximum_value is null or minimum_value <= maximum_value
  ),
  unique (crop_id, parameter_name, unit)
);

create table public.manual_inspections (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.storage_batches (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  inspection_date timestamptz not null,
  observed_condition text not null,
  deterioration_status text,
  visible_symptoms text[] not null default '{}',
  notes text,
  image_url text,
  verification_status text not null default 'USER_REPORTED'
    check (verification_status in ('USER_REPORTED', 'PENDING_REVIEW', 'EXPERT_VERIFIED')),
  created_at timestamptz not null default now()
);

create function public.keep_inspection_user_reported()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.role() = 'authenticated' then
    new.verification_status := 'USER_REPORTED';
  end if;
  return new;
end;
$$;

create trigger manual_inspections_user_reported
  before insert or update on public.manual_inspections
  for each row execute function public.keep_inspection_user_reported();

create index storage_units_user_id_idx on public.storage_units (user_id);
create index storage_zones_storage_unit_id_idx on public.storage_zones (storage_unit_id);
create index storage_zones_crop_id_idx on public.storage_zones (crop_id);
create index storage_batches_zone_id_idx on public.storage_batches (zone_id, status);
create index sensors_storage_zone_idx on public.sensors (storage_unit_id, zone_id);
create index sensors_last_seen_idx on public.sensors (last_seen_at desc);
create index sensor_readings_sensor_recorded_idx on public.sensor_readings (sensor_id, recorded_at desc);
create index sensor_readings_zone_recorded_idx on public.sensor_readings (zone_id, recorded_at desc);
create index sensor_readings_storage_recorded_idx on public.sensor_readings (storage_unit_id, recorded_at desc);
create index sensor_readings_recorded_at_idx on public.sensor_readings (recorded_at desc);
create index sensor_fault_events_sensor_detected_idx on public.sensor_fault_events (sensor_id, detected_at desc);
create index predictions_storage_generated_idx on public.predictions (storage_unit_id, generated_at desc);
create index alerts_user_created_idx on public.alerts (user_id, created_at desc);
create index manual_inspections_batch_date_idx on public.manual_inspections (batch_id, inspection_date desc);

alter table public.profiles enable row level security;
alter table public.storage_units enable row level security;
alter table public.storage_zones enable row level security;
alter table public.crops enable row level security;
alter table public.storage_batches enable row level security;
alter table public.sensors enable row level security;
alter table public.sensor_device_credentials enable row level security;
alter table public.sensor_readings enable row level security;
alter table public.sensor_ingestion_events enable row level security;
alter table public.sensor_fault_events enable row level security;
alter table public.predictions enable row level security;
alter table public.alerts enable row level security;
alter table public.crop_storage_references enable row level security;
alter table public.manual_inspections enable row level security;

create policy "Users can read their own profile"
  on public.profiles for select to authenticated using (id = (select auth.uid()));
revoke update on public.profiles from authenticated;
grant update (full_name, phone, updated_at) on public.profiles to authenticated;
create policy "Users can update their own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "Owners manage storage units"
  on public.storage_units for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "Owners manage storage zones"
  on public.storage_zones for all to authenticated
  using (exists (
    select 1 from public.storage_units u
    where u.id = storage_unit_id and u.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.storage_units u
    where u.id = storage_unit_id and u.user_id = (select auth.uid())
  ));

create policy "Crops are readable"
  on public.crops for select to anon, authenticated using (true);

create policy "Owners manage batches"
  on public.storage_batches for all to authenticated
  using (exists (
    select 1 from public.storage_units u
    where u.id = storage_unit_id and u.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.storage_units u
    where u.id = storage_unit_id and u.user_id = (select auth.uid())
  ));

create policy "Owners manage sensors"
  on public.sensors for all to authenticated
  using (exists (
    select 1 from public.storage_units u
    where u.id = storage_unit_id and u.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.storage_units u
    where u.id = storage_unit_id and u.user_id = (select auth.uid())
  ));

create policy "Owners read sensor readings"
  on public.sensor_readings for select to authenticated
  using (exists (
    select 1 from public.storage_units u
    where u.id = storage_unit_id and u.user_id = (select auth.uid())
  ));

create policy "Owners read sensor fault events"
  on public.sensor_fault_events for select to authenticated
  using (exists (
    select 1
    from public.sensors s
    join public.storage_units u on u.id = s.storage_unit_id
    where s.id = sensor_id and u.user_id = (select auth.uid())
  ));

create policy "Owners read predictions"
  on public.predictions for select to authenticated
  using (exists (
    select 1 from public.storage_units u
    where u.id = storage_unit_id and u.user_id = (select auth.uid())
  ));

create policy "Users manage their alerts"
  on public.alerts for all to authenticated
  using (
    user_id = (select auth.uid()) and exists (
      select 1 from public.storage_units u
      where u.id = storage_unit_id and u.user_id = (select auth.uid())
    )
  )
  with check (
    user_id = (select auth.uid()) and exists (
      select 1 from public.storage_units u
      where u.id = storage_unit_id and u.user_id = (select auth.uid())
    )
  );

create policy "Authenticated users can read crop references"
  on public.crop_storage_references for select to authenticated using (true);

create policy "Owners manage their manual inspections"
  on public.manual_inspections for all to authenticated
  using (
    user_id = (select auth.uid()) and exists (
      select 1
      from public.storage_batches b
      join public.storage_units u on u.id = b.storage_unit_id
      where b.id = batch_id and u.user_id = (select auth.uid())
    )
  )
  with check (
    user_id = (select auth.uid()) and exists (
      select 1
      from public.storage_batches b
      join public.storage_units u on u.id = b.storage_unit_id
      where b.id = batch_id and u.user_id = (select auth.uid())
    )
  );

grant select, delete on public.profiles to authenticated;
grant update (full_name, phone, updated_at) on public.profiles to authenticated;
grant select, insert, update, delete on public.storage_units to authenticated;
grant select, insert, update, delete on public.storage_zones to authenticated;
grant select on public.crops to anon, authenticated;
grant select, insert, update, delete on public.storage_batches to authenticated;
grant select, insert, update, delete on public.sensors to authenticated;
grant select on public.sensor_readings to authenticated;
grant select on public.sensor_fault_events to authenticated;
grant select on public.predictions to authenticated;
grant select, insert, update, delete on public.alerts to authenticated;
grant select on public.crop_storage_references to authenticated;
grant select, insert, update, delete on public.manual_inspections to authenticated;
grant all privileges on
  public.profiles,
  public.storage_units,
  public.storage_zones,
  public.crops,
  public.storage_batches,
  public.sensors,
  public.sensor_device_credentials,
  public.sensor_readings,
  public.sensor_ingestion_events,
  public.sensor_fault_events,
  public.predictions,
  public.alerts,
  public.crop_storage_references,
  public.manual_inspections
to service_role;

revoke all on public.sensor_device_credentials, public.sensor_ingestion_events
  from anon, authenticated;
grant all on public.sensor_device_credentials, public.sensor_ingestion_events
  to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.sensor_readings;
  end if;
exception
  when duplicate_object then null;
end;
$$;
