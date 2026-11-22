-- Daily cleanup for AJSF staff location history (30-day retention).
-- Supabase supports pg_cron as an available extension; enable it for this project.
create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'ajsf-location-history-retention',
  '17 2 * * *',
  $$delete from public.staff_location_history where recorded_at < now() - interval '30 days'$$
);
