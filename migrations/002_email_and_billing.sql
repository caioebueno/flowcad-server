-- Email one-time-code sign-in and Stripe billing.

alter table accounts alter column apple_user_id drop not null;
alter table accounts add column email text unique;              -- normalised: trimmed, lowercased
alter table accounts add column email_verified_at timestamptz;
alter table accounts add column stripe_customer_id text unique;
alter table accounts add column trial_used_at timestamptz;
alter table accounts alter column plan set default 'free';
alter table accounts add constraint accounts_has_identity check (apple_user_id is not null or email is not null);

create table email_codes (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  code_hash   bytea not null,                   -- HMAC of the code; the code itself is never stored
  purpose     text not null default 'sign_in' check (purpose in ('sign_in', 'link')),
  account_id  uuid references accounts(id) on delete cascade,   -- set for 'link' codes
  device_id   uuid,
  ip          text,
  attempts    integer not null default 0,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index email_codes_email_idx on email_codes(email, created_at desc);
create index email_codes_ip_idx on email_codes(ip, created_at desc);

create table subscriptions (
  stripe_subscription_id  text primary key,
  account_id              uuid not null references accounts(id) on delete cascade,
  stripe_price_id         text,
  status                  text not null,
  current_period_end      timestamptz,
  trial_end               timestamptz,
  cancel_at_period_end    boolean not null default false,
  updated_at              timestamptz not null default now()
);
create index subscriptions_account_idx on subscriptions(account_id);

create table stripe_events (
  id            text primary key,
  type          text not null,
  processed_at  timestamptz not null default now()
);
