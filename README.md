# Keel account service

The small web service between the Keel Mac app and Claude's API. It holds Keel's
Anthropic key, signs people up and in (Apple or an emailed code), sells Keel Pro
through Stripe, sets the model and limits for each task type, streams agent turns
through to Claude, and records what every turn cost.
It stores no prompts, replies, CAD files or project content.

TypeScript on Node 22, [Hono](https://hono.dev), Postgres, hosted on Railway.

## Status

Phases 1 and 4 of the spec are built (proxy, Apple and email sign-in, ledger, Stripe
billing), plus remote config and the monthly allowance from phase 2.

| Area | State |
| --- | --- |
| `POST /auth/apple`, `/auth/refresh`, `/auth/logout` | Done. 15 minute access tokens, 60 day rotating refresh tokens stored as hashes, reuse revokes the device |
| `POST /auth/email/start`, `/auth/email/verify` | Done. 6-digit codes, hashed, 10 minutes, 5 tries, 30 s between sends, 5 per email and 10 per IP an hour. Sign-up and sign-in are one step |
| Apple and email on one account | Done. A verified Apple email opens the matching email account; `POST /account/email/start` and `/verify` link an email from Settings |
| `GET /billing/plans`, `POST /billing/checkout`, `/billing/portal` | Done. Stripe Checkout in subscription mode with a 14-day trial once per account; Customer Portal for changes |
| `POST /billing/stripe/webhook` | Done. Signature checked, each event applied once, the only thing that moves an account between Free and Pro |
| Pro gating | Done. Free accounts get `403 plan_required` from the agent; `GET /account` returns `entitlement` |
| `POST /agent/turn`, `/agent/keepwarm` | Done. Task profiles, request checks, run caps, streaming, `keel.usage` / `keel.warning` / `keel.error` events |
| `GET /usage`, `GET /account`, device list and revoke | Done. Usage shown as percent of allowance, never dollars |
| `GET /config` | Done. Versioned in `config_versions`, served with an ETag |
| Monthly allowance (80% warning, 402 at 100%) | Done |
| App Attest | Interface and middleware in place, off by default (phase 2) |
| Rate limits on turns and Apple sign-ins | Values served in config, not enforced yet (phase 2) |
| Overnight reviews (`/batches`) and push | Not started (phase 3). The `overnight_review` profile already exists |

## Plans

| Plan | Tier | Set by |
| --- | --- | --- |
| `free` | Free: no agent | Default for new accounts, and after a subscription ends |
| `pro` | Pro | Stripe webhooks, while a subscription is trialing, active or past due |
| `beta`, `internal` | Pro | By hand (`update accounts set plan = 'beta' ...`); Stripe never changes them |

Allowances per plan live in remote config (`plans`), trial length in `billing.trialDays`.

## Running locally

```sh
npm install
cp .env.example .env            # fill in the values
export $(grep -v '^#' .env | xargs)
npm run migrate:dev
npm run dev                     # http://localhost:8080/v1/health
```

Tests need a Postgres database they can wipe:

```sh
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/keel_test npm test
```

## Deploying to Railway

`railway.json` holds the deploy settings: it builds the Dockerfile, runs migrations as
the pre-deploy command, health checks `/v1/health`, runs two replicas, and gives
in-flight streams 300 seconds to finish when a deploy replaces an instance.

1. Create a Railway project, add a **Postgres** service, and add a service from this repo.
2. On the app service, set these variables:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (the private URL, no SSL needed)
   - `ANTHROPIC_API_KEY` from Keel's dedicated Anthropic workspace, with a spend limit set on it
   - `ACCESS_TOKEN_SECRET` = output of `openssl rand -hex 32`
   - `PROJECT_HASH_SALT` = output of `openssl rand -hex 16` (never change it once set)
   - `APPLE_CLIENT_ID` = the Mac app's bundle id
   - `NODE_ENV` = `production`
   - `PUBLIC_BASE_URL` = the service's public https address, for example `https://flowcad-server-production.up.railway.app`
   - `RESEND_API_KEY` and `EMAIL_FROM` (for example `Keel <signin@yourdomain.com>`, on a domain verified in Resend)
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTH`, `STRIPE_PRICE_YEAR`, and optionally `STRIPE_AUTOMATIC_TAX=true`
3. Generate a public domain under the service's Networking settings, or attach `api.keel.app`.
4. In Stripe: create a **Keel Pro** product with a monthly and a yearly price (their ids go in the
   price variables), turn on the Customer Portal, and add a webhook endpoint at
   `https://<your domain>/v1/billing/stripe/webhook` for `checkout.session.completed`,
   `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed`, `invoice.paid` and
   `invoice.payment_failed`. Its signing secret is `STRIPE_WEBHOOK_SECRET`.
5. Every push to the default branch deploys. Railway sets `PORT` itself.

Agent turns stream for several minutes at high effort. Check Railway's current limit
on HTTP request duration before raising any profile above `high`.

## How a turn works

`POST /v1/agent/turn` with a device token:

```json
{
  "taskType": "change",
  "runId": "…", "turnIndex": 0,
  "projectId": "opaque id from the app", "threadId": "…",
  "effort": "low",                // optional, may only lower the profile's effort
  "maxOutputTokens": 16000,       // optional, may only lower the profile's max
  "request": { "system": [...], "tools": [...], "messages": [...] }
}
```

1. The access token, device and account are checked, then the allowance.
2. The task profile sets model, effort, max output, task budget, adaptive thinking with
   progress notes and the server-side refusal fallback. Fields the app adds to `request`
   (such as `model` or `thinking`) are dropped.
3. The request is checked: at most 4 cache breakpoints, 3 images, 2 MB, no server tools,
   and tools must match the allowlist by name and schema hash when one is configured.
4. The run is checked: at most 8 turns and about $1. Past either, the stream is a single
   `keel.error` event with code `run_limit_reached`.
5. Claude's events stream back unchanged, followed by `keel.usage` (tokens, cost,
   allowance left) and, past 80% of the allowance, `keel.warning`.
6. If the app disconnects, the upstream request is cancelled. Usage is recorded whatever
   happened, because Anthropic bills what it produced.

Errors before the stream starts are JSON with the status codes in the spec
(401, 402, 403, 413, 422, 429, 502, 503). Errors mid stream arrive as `keel.error`.

## Remote config

The live config is the newest row of `config_versions`; until one is published the
bundled defaults in `src/config/defaults.ts` apply. Prices, task profiles, plan
allowances, limits, the minimum app version and the tool allowlist all live there.

```sh
npm run config -- defaults > config.json   # start from the defaults
npm run config -- validate config.json
npm run config -- publish config.json "raise ask budget"
npm run config -- rollback 3               # republishes v3 as a new version
```

Tool allowlist entries are produced with `npm run tool-hash -- tools.json`. The hash is
sha256 of the canonical JSON (sorted keys) of `{name, input_schema}`; the Mac app should
compute the same hash in a test so the two stay in step.

## Things to check before the beta

- The Claude API details (beta flags `task-budgets-2026-03-13`,
  `thinking-display-updates-2026-08-18`, `server-side-fallback-2026-07-01`, and how
  fallback iterations are reported in `usage`) come from reference notes dated
  Oct 6, 2026. Confirm them against Anthropic's docs.
- Prices in the defaults, especially Haiku 5.5's cache prices and its over-100K tier.
- Plan allowances are placeholders ($10 a month for `pro`, $50 for `beta`); set them once Pro's price is known.
- Without Stripe variables, billing routes answer 503. Without `RESEND_API_KEY`, development prints sign-in
  codes to the log and production answers 503 to email sign-in.
- `APPLE_CLIENT_ID` and the `api.keel.app` domain.
