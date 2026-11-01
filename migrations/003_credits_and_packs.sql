-- AI credits (Nov 1 pricing): credit periods follow the Stripe billing period,
-- and credit packs are a separate balance that lasts 12 months.

-- Allowances are keyed by the start of the credit period instead of the
-- calendar month, so Pro credits reset on the billing date.
alter table allowances add column period_start timestamptz;
update allowances set period_start = (month::timestamp at time zone 'UTC');
alter table allowances alter column period_start set not null;
alter table allowances drop constraint allowances_pkey;
alter table allowances alter column month drop not null;
alter table allowances add primary key (account_id, period_start);

alter table subscriptions add column current_period_start timestamptz;
alter table subscriptions add column price_interval text;    -- 'month' | 'year', from the Stripe price

-- How much of a turn's cost came out of pack credits rather than the monthly ones.
alter table usage_ledger add column extra_micros bigint not null default 0;

create table credit_grants (
  id                        uuid primary key default gen_random_uuid(),
  account_id                uuid not null references accounts(id) on delete cascade,
  source                    text not null check (source in ('pack', 'manual')),
  credits                   integer not null check (credits > 0),
  granted_micros            bigint not null,
  remaining_micros          bigint not null check (remaining_micros >= 0),
  amount_cents              integer,
  currency                  text,
  stripe_payment_intent_id  text unique,                    -- one grant per payment, whichever webhook lands first
  expires_at                timestamptz not null,
  created_at                timestamptz not null default now()
);
create index credit_grants_account_idx on credit_grants(account_id, expires_at);
