-- Financial audit trail, immutable approved settlements, FK indexes and RLS initplan tuning.
-- Safe to re-run: triggers/policies are replaced and indexes use IF NOT EXISTS.

create or replace function public.capture_financial_audit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_old jsonb := case when TG_OP in ('UPDATE','DELETE') then to_jsonb(OLD) else '{}'::jsonb end;
  v_new jsonb := case when TG_OP in ('INSERT','UPDATE') then to_jsonb(NEW) else '{}'::jsonb end;
  v_row jsonb;
  v_record_id text;
  v_details jsonb;
  v_action text;
begin
  v_row := case when TG_OP = 'DELETE' then v_old else v_new end;
  v_record_id := coalesce(v_row->>'id', v_row->>'loan_id', v_row->>'payment_id');
  v_action := TG_TABLE_NAME || '_' || lower(TG_OP);
  v_details := jsonb_build_object(
    'operation', TG_OP,
    'table', TG_TABLE_NAME,
    'old', jsonb_strip_nulls(jsonb_build_object(
      'amount', v_old->'amount', 'payment_mode', v_old->'payment_mode',
      'paid_at', v_old->'paid_at', 'is_reversal', v_old->'is_reversal',
      'reverses_payment_id', v_old->'reverses_payment_id',
      'entry_type', v_old->'entry_type', 'event_date', v_old->'event_date',
      'applied_week_no', v_old->'applied_week_no', 'status', v_old->'status',
      'expected_cash', v_old->'expected_cash', 'expected_upi', v_old->'expected_upi',
      'expected_bank', v_old->'expected_bank', 'deposited_cash', v_old->'deposited_cash',
      'deposited_upi', v_old->'deposited_upi', 'deposited_bank', v_old->'deposited_bank',
      'approved_by', v_old->'approved_by', 'approved_at', v_old->'approved_at',
      'loan_reference', v_old->'loan_reference', 'loan_amount', v_old->'loan_amount',
      'emi_amount', v_old->'emi_amount', 'final_payment_id', v_old->'final_payment_id'
    )),
    'new', jsonb_strip_nulls(jsonb_build_object(
      'amount', v_new->'amount', 'payment_mode', v_new->'payment_mode',
      'paid_at', v_new->'paid_at', 'is_reversal', v_new->'is_reversal',
      'reverses_payment_id', v_new->'reverses_payment_id',
      'entry_type', v_new->'entry_type', 'event_date', v_new->'event_date',
      'applied_week_no', v_new->'applied_week_no', 'status', v_new->'status',
      'expected_cash', v_new->'expected_cash', 'expected_upi', v_new->'expected_upi',
      'expected_bank', v_new->'expected_bank', 'deposited_cash', v_new->'deposited_cash',
      'deposited_upi', v_new->'deposited_upi', 'deposited_bank', v_new->'deposited_bank',
      'approved_by', v_new->'approved_by', 'approved_at', v_new->'approved_at',
      'loan_reference', v_new->'loan_reference', 'loan_amount', v_new->'loan_amount',
      'emi_amount', v_new->'emi_amount', 'final_payment_id', v_new->'final_payment_id'
    ))
  );
  insert into public.audit_logs(actor_id, action, table_name, record_id, details)
  values (auth.uid(), v_action, TG_TABLE_NAME, v_record_id, v_details);
  if TG_OP = 'DELETE' then return OLD; else return NEW; end if;
end;
$$;

revoke all on function public.capture_financial_audit() from public, anon, authenticated;

drop trigger if exists audit_payments_changes on public.payments;
create trigger audit_payments_changes after insert or update or delete on public.payments
for each row execute function public.capture_financial_audit();

drop trigger if exists audit_advance_ledger_changes on public.advance_ledger;
create trigger audit_advance_ledger_changes after insert or update or delete on public.advance_ledger
for each row execute function public.capture_financial_audit();

drop trigger if exists audit_daily_settlement_changes on public.daily_collection_settlements;
create trigger audit_daily_settlement_changes after insert or update or delete on public.daily_collection_settlements
for each row execute function public.capture_financial_audit();

drop trigger if exists audit_loan_closure_changes on public.loan_closures;
create trigger audit_loan_closure_changes after insert or update or delete on public.loan_closures
for each row execute function public.capture_financial_audit();

create or replace function public.guard_daily_settlement_status()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if TG_OP = 'INSERT' then
    if NEW.status <> 'pending' then
      raise exception 'New settlements must start as pending drafts' using errcode='23514';
    end if;
    if NEW.approved_by is not null or NEW.approved_at is not null then
      raise exception 'Approval fields are assigned only during approval' using errcode='23514';
    end if;
    return NEW;
  end if;

  if OLD.status = 'approved' then
    raise exception 'Approved settlement is locked and cannot be changed or deleted' using errcode='55000';
  end if;

  if TG_OP = 'UPDATE' and NEW.status = 'approved' then
    if auth.uid() is null or not public.is_active_admin() then
      raise exception 'Only an active Admin can approve a settlement' using errcode='42501';
    end if;
    NEW.approved_by := auth.uid();
    NEW.approved_at := coalesce(NEW.approved_at, now());
  elsif TG_OP = 'UPDATE' then
    if NEW.approved_by is not null or NEW.approved_at is not null then
      raise exception 'Approval fields cannot be set on a pending draft' using errcode='23514';
    end if;
  end if;

  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end;
$$;

drop trigger if exists guard_daily_settlement_status on public.daily_collection_settlements;
create trigger guard_daily_settlement_status
before insert or update or delete on public.daily_collection_settlements
for each row execute function public.guard_daily_settlement_status();

revoke all on function public.guard_daily_settlement_status() from public, anon, authenticated;

create index if not exists customer_accounts_created_by_idx on public.customer_accounts(created_by);
create index if not exists customer_verifications_verified_by_idx on public.customer_verifications(verified_by);
create index if not exists daily_collection_settlements_approved_by_idx on public.daily_collection_settlements(approved_by);
create index if not exists daily_collection_settlements_collector_id_idx on public.daily_collection_settlements(collector_id);
create index if not exists daily_collection_settlements_created_by_idx on public.daily_collection_settlements(created_by);
create index if not exists loan_closures_closed_by_idx on public.loan_closures(closed_by);
create index if not exists receipt_cancellation_requests_collector_id_idx on public.receipt_cancellation_requests(collector_id);
create index if not exists receipt_cancellation_requests_customer_id_idx on public.receipt_cancellation_requests(customer_id);
create index if not exists receipt_cancellation_requests_reversal_payment_id_idx on public.receipt_cancellation_requests(reversal_payment_id);
create index if not exists receipt_cancellation_requests_reviewed_by_idx on public.receipt_cancellation_requests(reviewed_by);

drop policy if exists profiles_read_self_or_admin on public.profiles;
create policy profiles_read_self_or_admin on public.profiles
for select to authenticated
using ((id = (select auth.uid())) or (select public.is_active_admin()));

drop policy if exists customers_collector_read_assigned on public.customers;
create policy customers_collector_read_assigned on public.customers
for select to authenticated
using (
  assigned_collector = (select auth.uid())
  and exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.is_active = true
  )
);

drop policy if exists payments_collector_read_assigned on public.payments;
create policy payments_collector_read_assigned on public.payments
for select to authenticated
using (
  collector_id = (select auth.uid())
  and public.can_access_customer(customer_id)
);

drop policy if exists payments_collector_insert_assigned on public.payments;
create policy payments_collector_insert_assigned on public.payments
for insert to authenticated
with check (
  collector_id = (select auth.uid())
  and public.can_access_customer(customer_id)
  and is_reversal = false
  and reverses_payment_id is null
  and exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'collector'::public.app_role
      and p.is_active = true
  )
);

drop policy if exists advance_ledger_collector_insert_assigned on public.advance_ledger;
create policy advance_ledger_collector_insert_assigned on public.advance_ledger
for insert to authenticated
with check (
  collector_id = (select auth.uid())
  and public.can_access_customer(customer_id)
  and exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'collector'::public.app_role
      and p.is_active = true
  )
);

-- Extend the same audit trail to receipt cancellation requests, including review metadata.
create or replace function public.capture_financial_audit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_old jsonb := case when TG_OP in ('UPDATE','DELETE') then to_jsonb(OLD) else '{}'::jsonb end;
  v_new jsonb := case when TG_OP in ('INSERT','UPDATE') then to_jsonb(NEW) else '{}'::jsonb end;
  v_row jsonb;
  v_record_id text;
  v_details jsonb;
begin
  v_row := case when TG_OP = 'DELETE' then v_old else v_new end;
  v_record_id := coalesce(v_row->>'id', v_row->>'loan_id', v_row->>'payment_id');
  v_details := jsonb_build_object(
    'operation', TG_OP, 'table', TG_TABLE_NAME,
    'old', jsonb_strip_nulls(jsonb_build_object(
      'amount',v_old->'amount','payment_mode',v_old->'payment_mode','paid_at',v_old->'paid_at',
      'is_reversal',v_old->'is_reversal','reverses_payment_id',v_old->'reverses_payment_id',
      'entry_type',v_old->'entry_type','event_date',v_old->'event_date','applied_week_no',v_old->'applied_week_no',
      'status',v_old->'status','expected_cash',v_old->'expected_cash','expected_upi',v_old->'expected_upi',
      'expected_bank',v_old->'expected_bank','deposited_cash',v_old->'deposited_cash',
      'deposited_upi',v_old->'deposited_upi','deposited_bank',v_old->'deposited_bank',
      'approved_by',v_old->'approved_by','approved_at',v_old->'approved_at',
      'loan_reference',v_old->'loan_reference','loan_amount',v_old->'loan_amount',
      'emi_amount',v_old->'emi_amount','final_payment_id',v_old->'final_payment_id',
      'payment_id',v_old->'payment_id','reason',v_old->'reason','admin_note',v_old->'admin_note',
      'reviewed_by',v_old->'reviewed_by','reviewed_at',v_old->'reviewed_at',
      'reversal_payment_id',v_old->'reversal_payment_id'
    )),
    'new', jsonb_strip_nulls(jsonb_build_object(
      'amount',v_new->'amount','payment_mode',v_new->'payment_mode','paid_at',v_new->'paid_at',
      'is_reversal',v_new->'is_reversal','reverses_payment_id',v_new->'reverses_payment_id',
      'entry_type',v_new->'entry_type','event_date',v_new->'event_date','applied_week_no',v_new->'applied_week_no',
      'status',v_new->'status','expected_cash',v_new->'expected_cash','expected_upi',v_new->'expected_upi',
      'expected_bank',v_new->'expected_bank','deposited_cash',v_new->'deposited_cash',
      'deposited_upi',v_new->'deposited_upi','deposited_bank',v_new->'deposited_bank',
      'approved_by',v_new->'approved_by','approved_at',v_new->'approved_at',
      'loan_reference',v_new->'loan_reference','loan_amount',v_new->'loan_amount',
      'emi_amount',v_new->'emi_amount','final_payment_id',v_new->'final_payment_id',
      'payment_id',v_new->'payment_id','reason',v_new->'reason','admin_note',v_new->'admin_note',
      'reviewed_by',v_new->'reviewed_by','reviewed_at',v_new->'reviewed_at',
      'reversal_payment_id',v_new->'reversal_payment_id'
    ))
  );
  insert into public.audit_logs(actor_id,action,table_name,record_id,details)
  values(auth.uid(),TG_TABLE_NAME||'_'||lower(TG_OP),TG_TABLE_NAME,v_record_id,v_details);
  if TG_OP='DELETE' then return OLD; else return NEW; end if;
end;
$$;

drop trigger if exists audit_receipt_cancellation_changes on public.receipt_cancellation_requests;
create trigger audit_receipt_cancellation_changes
after insert or update or delete on public.receipt_cancellation_requests
for each row execute function public.capture_financial_audit();

revoke all on function public.capture_financial_audit() from public,anon,authenticated;
