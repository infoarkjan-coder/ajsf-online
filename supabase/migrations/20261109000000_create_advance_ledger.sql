create table if not exists public.advance_ledger (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.loans(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  payment_id uuid references public.payments(id) on delete restrict,
  entry_type text not null,
  amount numeric(14,2) not null check (amount > 0),
  event_date timestamptz not null,
  source_week_no integer,
  applied_week_no integer,
  source_entry_id uuid references public.advance_ledger(id) on delete restrict,
  collector_id uuid not null references public.profiles(id) on delete restrict,
  idempotency_key text not null unique,
  remarks text,
  emi_amount_at_allocation numeric(14,2),
  due_date date,
  created_at timestamptz not null default now(),
  constraint advance_ledger_entry_type_check
    check (entry_type in ('advance_received','advance_adjusted','cash_applied')),
  constraint advance_ledger_week_valid check (
    (source_week_no is null or source_week_no between 1 and 60)
    and (applied_week_no is null or applied_week_no between 1 and 60)
  ),
  constraint advance_ledger_entry_shape check (
    (entry_type = 'advance_received' and source_entry_id is null and applied_week_no is null)
    or
    (entry_type = 'advance_adjusted' and source_entry_id is not null and applied_week_no is not null)
    or
    (entry_type = 'cash_applied' and source_entry_id is null and applied_week_no is not null)
  )
);

create index if not exists advance_ledger_loan_date_idx on public.advance_ledger(loan_id,event_date);
create index if not exists advance_ledger_customer_date_idx on public.advance_ledger(customer_id,event_date);
create index if not exists advance_ledger_collector_id_idx on public.advance_ledger(collector_id);
create index if not exists advance_ledger_payment_id_idx on public.advance_ledger(payment_id);
create index if not exists advance_ledger_source_entry_id_idx on public.advance_ledger(source_entry_id);

alter table public.advance_ledger enable row level security;
revoke all on public.advance_ledger from anon;
grant select, insert, update, delete on public.advance_ledger to authenticated;
grant all on public.advance_ledger to service_role;

drop policy if exists advance_ledger_admin_all on public.advance_ledger;
create policy advance_ledger_admin_all on public.advance_ledger
for all to authenticated
using (public.is_active_admin())
with check (public.is_active_admin());

drop policy if exists advance_ledger_collector_read_assigned on public.advance_ledger;
create policy advance_ledger_collector_read_assigned on public.advance_ledger
for select to authenticated
using (public.can_access_customer(customer_id));

drop policy if exists advance_ledger_collector_insert_assigned on public.advance_ledger;
create policy advance_ledger_collector_insert_assigned on public.advance_ledger
for insert to authenticated
with check (
  collector_id = auth.uid()
  and public.can_access_customer(customer_id)
  and exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role = 'collector'::public.app_role
      and p.is_active = true
  )
);
