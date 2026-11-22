-- AJSF Live Collector Tracking
-- Super Admin remains an Admin for all existing application permissions.
-- Location writes are mediated by SECURITY DEFINER RPCs; staff cannot read other staff locations.

alter table public.profiles
  add column if not exists is_super_admin boolean not null default false;

update public.profiles
set is_super_admin = true
where id = 'fc551914-a50b-422d-a919-6f0de82f91ed'
  and is_active = true;

create or replace function public.is_active_super_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid())
      and is_active = true
      and is_super_admin = true
  );
$$;

-- Keep this account's existing Admin capabilities while separately granting Super Admin visibility.
create or replace function public.is_active_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid())
      and is_active = true
      and role = 'admin'::public.app_role
  );
$$;

create table if not exists public.staff_duty_sessions (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.profiles(id) on delete cascade,
  duty_started_at timestamptz not null default now(),
  duty_ended_at timestamptz,
  created_at timestamptz not null default now(),
  constraint staff_duty_sessions_time_check
    check (duty_ended_at is null or duty_ended_at >= duty_started_at)
);

create unique index if not exists staff_duty_one_open_session_idx
  on public.staff_duty_sessions(staff_id)
  where duty_ended_at is null;

create index if not exists staff_duty_sessions_staff_started_idx
  on public.staff_duty_sessions(staff_id, duty_started_at desc);

create table if not exists public.staff_location_history (
  id bigint generated always as identity primary key,
  duty_session_id uuid not null references public.staff_duty_sessions(id) on delete cascade,
  staff_id uuid not null references public.profiles(id) on delete cascade,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  accuracy_m double precision check (accuracy_m is null or accuracy_m >= 0),
  recorded_at timestamptz not null default now()
);

create index if not exists staff_location_history_staff_recorded_idx
  on public.staff_location_history(staff_id, recorded_at desc);
create index if not exists staff_location_history_session_recorded_idx
  on public.staff_location_history(duty_session_id, recorded_at desc);

alter table public.staff_duty_sessions enable row level security;
alter table public.staff_location_history enable row level security;

drop policy if exists staff_duty_sessions_read_self_or_super_admin on public.staff_duty_sessions;
create policy staff_duty_sessions_read_self_or_super_admin
on public.staff_duty_sessions for select to authenticated
using (staff_id = (select auth.uid()) or (select public.is_active_super_admin()));

drop policy if exists staff_location_history_read_super_admin on public.staff_location_history;
create policy staff_location_history_read_super_admin
on public.staff_location_history for select to authenticated
using ((select public.is_active_super_admin()));

revoke all on public.staff_duty_sessions from anon, authenticated;
revoke all on public.staff_location_history from anon, authenticated;
grant select on public.staff_duty_sessions to authenticated;
grant select on public.staff_location_history to authenticated;

create or replace function public.ajs_start_duty()
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_session uuid;
begin
  if v_uid is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if not exists (
    select 1 from public.profiles p
    where p.id = v_uid and p.is_active = true and p.role in ('admin'::public.app_role, 'collector'::public.app_role)
  ) then raise exception 'Active staff account required' using errcode='42501'; end if;

  select id into v_session
  from public.staff_duty_sessions
  where staff_id = v_uid and duty_ended_at is null
  order by duty_started_at desc limit 1;

  if v_session is null then
    insert into public.staff_duty_sessions(staff_id) values (v_uid) returning id into v_session;
  end if;
  return v_session;
end;
$$;

create or replace function public.ajs_record_duty_location(
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_m double precision default null
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_session uuid;
  v_id bigint;
begin
  if v_uid is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_latitude is null or p_longitude is null
     or p_latitude not between -90 and 90
     or p_longitude not between -180 and 180
     or (p_accuracy_m is not null and p_accuracy_m < 0) then
    raise exception 'Invalid GPS coordinates' using errcode='22023';
  end if;

  select id into v_session
  from public.staff_duty_sessions
  where staff_id = v_uid and duty_ended_at is null
  order by duty_started_at desc limit 1;

  if v_session is null then raise exception 'Duty is not active' using errcode='55000'; end if;

  delete from public.staff_location_history
  where recorded_at < now() - interval '30 days';

  insert into public.staff_location_history(duty_session_id, staff_id, latitude, longitude, accuracy_m)
  values (v_session, v_uid, p_latitude, p_longitude, p_accuracy_m)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.ajs_end_duty()
returns timestamptz
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_ended timestamptz;
begin
  if v_uid is null then raise exception 'Authentication required' using errcode='28000'; end if;
  update public.staff_duty_sessions
  set duty_ended_at = now()
  where staff_id = v_uid and duty_ended_at is null
  returning duty_ended_at into v_ended;
  return v_ended;
end;
$$;

revoke all on function public.ajs_start_duty() from public, anon;
revoke all on function public.ajs_record_duty_location(double precision,double precision,double precision) from public, anon;
revoke all on function public.ajs_end_duty() from public, anon;
grant execute on function public.ajs_start_duty() to authenticated;
grant execute on function public.ajs_record_duty_location(double precision,double precision,double precision) to authenticated;
grant execute on function public.ajs_end_duty() to authenticated;
