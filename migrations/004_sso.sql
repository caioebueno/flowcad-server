-- Single Sign-On through WorkOS. An SSO sign-in is a browser round trip:
-- start (from the app) -> the company's identity provider -> callback (here)
-- -> keel:// hand-off code -> verify (from the app, with the PKCE verifier).

alter table accounts add column sso_user_id text unique;          -- WorkOS profile id
alter table accounts add column sso_organization_id text;         -- WorkOS organization id

create table sso_logins (
  id               uuid primary key default gen_random_uuid(),
  state_hash       bytea not null unique,           -- SHA-256 of the state sent to WorkOS
  code_challenge   text not null,                   -- base64url SHA-256 of the app's verifier (PKCE S256)
  device_id        uuid not null,
  organization_id  text not null,
  email_domain     text not null,
  handoff_hash     bytea unique,                    -- SHA-256 of the one-time code handed back to the app
  account_id       uuid references accounts(id) on delete cascade,
  account_created  boolean not null default false,
  display_name     text,                            -- from the identity provider, handed to the app once
  expires_at       timestamptz not null,
  used_at          timestamptz,
  created_at       timestamptz not null default now()
);
create index sso_logins_created_idx on sso_logins(created_at);
