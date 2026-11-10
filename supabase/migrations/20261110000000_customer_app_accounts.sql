-- Customer App identity mapping. Does not alter existing financial records.
create table if not exists public.customer_accounts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null unique references public.customers(id) on delete restrict,
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  is_active boolean not null default true,
  must_change_password boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.customer_accounts enable row level security;

drop policy if exists customer_accounts_read_self on public.customer_accounts;
create policy customer_accounts_read_self
on public.customer_accounts for select to authenticated
using (auth_user_id = (select auth.uid()));

drop policy if exists customer_accounts_admin_manage on public.customer_accounts;
create policy customer_accounts_admin_manage
on public.customer_accounts for all to authenticated
using (public.is_active_admin())
with check (public.is_active_admin());

drop policy if exists customers_customer_read_self on public.customers;
create policy customers_customer_read_self
on public.customers for select to authenticated
using (
  exists (
    select 1 from public.customer_accounts ca
    where ca.customer_id = customers.id
      and ca.auth_user_id = (select auth.uid())
      and ca.is_active = true
  )
);

drop policy if exists loans_customer_read_self on public.loans;
create policy loans_customer_read_self
on public.loans for select to authenticated
using (
  exists (
    select 1 from public.customer_accounts ca
    where ca.customer_id = loans.customer_id
      and ca.auth_user_id = (select auth.uid())
      and ca.is_active = true
  )
);

drop policy if exists payments_customer_read_self on public.payments;
create policy payments_customer_read_self
on public.payments for select to authenticated
using (
  is_reversal = false
  and exists (
    select 1 from public.customer_accounts ca
    where ca.customer_id = payments.customer_id
      and ca.auth_user_id = (select auth.uid())
      and ca.is_active = true
  )
);

drop policy if exists loan_weekly_status_customer_read_self on public.loan_weekly_status;
create policy loan_weekly_status_customer_read_self
on public.loan_weekly_status for select to authenticated
using (
  exists (
    select 1
    from public.loans l
    join public.customer_accounts ca on ca.customer_id = l.customer_id
    where l.id = loan_weekly_status.loan_id
      and ca.auth_user_id = (select auth.uid())
      and ca.is_active = true
  )
);

create index if not exists customer_accounts_auth_user_id_idx
  on public.customer_accounts(auth_user_id);
