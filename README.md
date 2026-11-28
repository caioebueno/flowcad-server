# Keel account service

The small web service between the Keel Mac app and Claude's API. It holds Keel's
Anthropic key, signs people up and in (Apple, an emailed code, or Single Sign-On through WorkOS), sells Keel Pro
through Stripe, sets the model and limits for each task type, streams agent turns
through to Claude, records what every turn cost, and keeps each person's projects
(chats, the model, context, outputs, files and exports) so they sync between their Macs.
Agent turns pass through without being stored; project content is stored only through
the sync routes, for the account that owns it.

TypeScript on Node 22, [Hono](https://hono.dev), Postgres, hosted on Railway.

## Status

Phases 1 and 4 of the spec are built (proxy, Apple and email sign-in, ledger, Stripe
billing with AI credits and credit packs), plus remote config from phase 2.

| Area | State |
| --- | --- |
| `POST /auth/apple`, `/auth/refresh`, `/auth/logout` | Done. 15 minute access tokens, 60 day rotating refresh tokens stored as hashes, reuse revokes the device |
| `POST /auth/email/start`, `/auth/email/verify` | Done. 6-digit codes, hashed, 10 minutes, 5 tries, 30 s between sends, 5 per email and 10 per IP an hour. Sign-up and sign-in are one step |
| `POST /auth/sso/start`, `GET /auth/sso/callback`, `POST /auth/sso/verify` | Done. Single Sign-On through WorkOS: the work email's domain picks the organization, the browser round trip ends at `keel://auth/sso` with a one-time code, and the app trades it for tokens with its PKCE verifier. A profile from another organization is refused; an existing account with the same email opens. Off (503 `sso_unavailable`) until `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` are set |
| Apple and email on one account | Done. A verified Apple email opens the matching email account; `POST /account/email/start` and `/verify` link an email from Settings |
| `GET /billing/plans`, `POST /billing/checkout`, `/billing/portal` | Done. Stripe Checkout in subscription mode with a 15-day trial (card required) once per account; Customer Portal for changes |
| `POST /billing/packs/checkout`, `/billing/trial/end` | Done. One-time Checkout for 1,000 extra credits (Pro, not during a trial); "Start Pro now" ends a trial early |
| `POST /billing/stripe/webhook` | Done. Signature checked, each event applied once, the only thing that moves an account between Free and Pro |
| Pro gating | Done. Free accounts get `403 plan_required` from the agent; `GET /account` returns `entitlement` |
| `POST /agent/turn`, `/agent/keepwarm` | Done. Task profiles, request checks, run caps, streaming, `keel.usage` / `keel.warning` / `keel.error` events |
| `POST /search/step-models` | Done. The agent's `search_step_models`: SearXNG (or Brave) web search, plus GitHub code search, over the sites in `stepSearch`, Pro only, 60 searches an hour, answers cached an hour. See below |
| `GET /usage`, `GET /account`, device list and revoke | Done. Usage shown in credits, never dollars |
| `GET /config` | Done. Versioned in `config_versions`, served with an ETag |
| AI credits | Done. 2,000 a billing period on Pro, 1,000 for the trial, packs used after; `credits_low` warning at 20% left, `402 credits_exhausted` at zero. Contract: `/mnt/project-files/keel-account-service/api-pro-and-credits.md` |
| App Attest | Interface and middleware in place, off by default (phase 2) |
| Limits on agent turns | Done. Each turn holds back its worst-case cost while it streams, so turns sent at once can't spend credits that aren't there (only one turn can run past the end of the credits); `concurrentRuns` turns in flight and `turnsPerMinute` per account, else `429 rate_limited`. Turns that failed before a reply don't use up a run |
| Client IP for rate limits | The right-most `X-Forwarded-For` entry, the one Railway's proxy appends (a client can only add entries to its left). If a CDN or another proxy is ever put in front of Railway, that entry becomes the CDN's address and every user shares one bucket: switch to the CDN's client-IP header (`src/util/clientIp.ts`) |
| Rate limits on Apple sign-ins | Value served in config, not enforced yet (phase 2) |
| Project sync: `GET /projects`, `POST /sync/push`, `GET /sync/changes`, `PUT`/`GET`/`HEAD /blobs/:sha256`, `GET /storage` | Done. Projects and their records (threads, messages, model, context, files, outputs, exports, versions) per account, with revisions for conflicts and one change sequence per account for pulls. Files are content-addressed blobs in an S3-compatible bucket (Postgres without one), 5 GB per account, 512 MB per file. Contract: [docs/project-sync.md](docs/project-sync.md) |
| Overnight reviews (`/batches`) and push | Not started (phase 3). The `overnight_review` profile already exists |

## Plans

| Plan | Tier | Set by |
| --- | --- | --- |
| `free` | Free: no agent | Default for new accounts, and after a subscription ends |
| `pro` | Pro | Stripe webhooks, while a subscription is trialing, active or past due |
| `beta`, `internal` | Pro | By hand (`update accounts set plan = 'beta' ...`); Stripe never changes them |

Credits per plan live in remote config (`plans[].monthlyCredits`), with the credit rate in
`credits.perDollar` (150, so one credit is 1/150 of a dollar of model cost), and the trial and
pack in `billing` (`trialDays` 15, `trialCredits` 1,000, `pack` 1,000 credits lasting 12 months).
Stripe plans get fresh credits every month, counted from the start of the billing period (a
yearly price gets its 2,000 each month of the year); hand-assigned plans on the 1st of each month.
While a payment is failing (`past_due`) Pro stays on, but the unpaid period's monthly credits wait
until Stripe collects it; pack credits still work. Pack credits sit in `credit_grants` and are spent after the monthly ones,
soonest expiry first. Prices ($39 a month, $390 a year, $10 a pack) live in Stripe.

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
the pre-deploy command (the server also runs any missing migrations when it starts, under a lock), health checks `/v1/health`, runs two replicas, and gives
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
   - `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` for Single Sign-On (in WorkOS, add `PUBLIC_BASE_URL/v1/auth/sso/callback` as a redirect URI), and optionally `SSO_APP_CALLBACK` (default `keel://auth/sso`)
   - `RESEND_API_KEY` and `EMAIL_FROM` (for example `Keel <signin@yourdomain.com>`, on a domain verified in Resend)
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTH`, `STRIPE_PRICE_YEAR`, `STRIPE_PRICE_PACK`, and optionally `STRIPE_AUTOMATIC_TAX=true`
   - For the agent's STEP model search: `SEARXNG_URL`, the address of Keel's SearXNG service (its settings.yml must allow the `json` format), or else `BRAVE_SEARCH_API_KEY`; and optionally `GITHUB_SEARCH_TOKEN`, a GitHub token with public read access, which adds GitHub code search for `.step`/`.stp` files. With none of them the search answers 503 `search_unavailable`
   - For project files, add a **Bucket** to the Railway project (or use Cloudflare R2) and set
     `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` from its
     credentials. Without them, files are stored in Postgres. `STORAGE_QUOTA_BYTES` and
     `BLOB_MAX_BYTES` change the 5 GB per account and 512 MB per file limits
3. Generate a public domain under the service's Networking settings, or attach `api.keel.app`.
4. In Stripe: create a **Keel Pro** product with a $39 monthly and a $390 yearly recurring price,
   and a **Keel AI credits** product with a one-time $10 price for 1,000 credits (the three ids
   go in the price variables). Turn on the Customer Portal, and turn on the trial-ending reminder
   email (Settings > Billing > Subscriptions and emails) so people hear 3 days before the trial
   ends. Add a webhook endpoint at `https://<your domain>/v1/billing/stripe/webhook` for
   `checkout.session.completed`, `customer.subscription.created`, `.updated`, `.deleted`,
   `.paused`, `.resumed`, `invoice.paid`, `invoice.payment_failed`, `payment_intent.succeeded`
   and `charge.refunded`. Its signing secret is `STRIPE_WEBHOOK_SECRET`.
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

1. The access token, device and account are checked, then the plan (Free gets `403 plan_required`), then the credits.
2. The task profile sets model, effort, max output, task budget, adaptive thinking with
   progress notes and the server-side refusal fallback. Fields the app adds to `request`
   (such as `model` or `thinking`) are dropped.
3. The request is checked: at most 4 cache breakpoints, 3 images, 2 MB, no server tools,
   and tools must match the allowlist by name and schema hash when one is configured.
4. The run is checked: at most 8 turns and about $1. Past either, the stream is a single
   `keel.error` event with code `run_limit_reached`.
5. Claude's events stream back unchanged, followed by `keel.usage` (tokens, `creditsCharged`,
   `creditsLeft`) and, with 20% or less of the monthly credits left, `keel.warning` (`credits_low`).
6. If the app disconnects, the upstream request is cancelled. Usage is recorded whatever
   happened, because Anthropic bills what it produced.

Errors before the stream starts are JSON with the status codes in the spec
(401, 402, 403, 413, 422, 429, 502, 503). Errors mid stream arrive as `keel.error`.

## STEP model search

The agent can look for ready-made STEP models of standard and bought-in parts
(fasteners, bearings, motors, extrusions). It is an ordinary custom tool,
`search_step_models`, which the Mac answers by calling `POST /v1/search/step-models`
with `{ "query": "608 2RS bearing", "limit": 5 }`. So it works the same on Claude and
on the self-hosted model, and the turn still sends no server tools.

The server adds the sites in `stepSearch.sites` to the query as `site:` operators,
asks SearXNG (or Brave, when only its key is set), and, with `GITHUB_SEARCH_TOKEN`,
GitHub code search for `.step`/`.stp` files at the same time, GitHub's first. A
provider that fails is skipped. It keeps only https results on those sites, and answers
`{ "results": [{ "title", "url", "fileUrl", "source", "snippet", "license" }] }`.
`fileUrl` is set only for a `.step`/`.stp` page on a `direct` site (a GitHub blob
becomes its raw.githubusercontent.com address, a GitLab blob its `/-/raw/` one); the
catalogues (TraceParts, GrabCAD, McMaster-Carr...) need a sign-in, so they come back
as pages only. The Mac downloads only a `fileUrl` from this answer, never an address
the model wrote, and opens Keel's Import sheet on it.

SearXNG needs engines that answer from Railway's addresses. Google and DuckDuckGo
block them quickly (a CAPTCHA, "too many requests"), so turn on others in its
settings.yml too, such as Bing, Brave, Mojeek, Qwant and Startpage. When every
engine is down and nothing comes back, the endpoint answers 502 `upstream_error`
rather than an empty list, so the agent doesn't say the part isn't online.

Change the sites, turn it off or change the hourly limit in remote config
(`stepSearch`); a config published without `stepSearch` uses the bundled default.
Queries are not stored: the log has their length and the result count. Searches
cost no credits.

## Self-hosted model

Agent turns go first to a self-hosted model (Qwen3.8-27B FP8 on vLLM, run on a
Vast.ai GPU) when `SELF_HOSTED_BASE_URL` is set, and to Claude otherwise.

To start the instance, set it up for the first time, or fix it, see
[docs/vast-ai.md](docs/vast-ai.md).

- `SELF_HOSTED_BASE_URL`: the instance's vLLM API address, without `/v1`. In
  production it must be `https://` (the server refuses to start otherwise),
  because prompts, replies and the token would otherwise cross the internet in
  the clear: put a TLS tunnel in front of port 8000 (see docs/vast-ai.md).
- `SELF_HOSTED_TOKEN`: sent as `Authorization: Bearer`. The Vast.ai portal token,
  or the `--api-key` vLLM was started with.
- Routing lives in remote config under `selfHosted`: `enabled`, optional `plans`
  (absent means every Pro plan) and a profile per task type, with model names
  starting `self:`. The defaults send every live task type there. On these
  profiles `thinkingUpdates` turns Qwen's thinking on for that request
  (`chat_template_kwargs.enable_thinking`): on for edits, parts and plans,
  off for `ask`, `explain_more` and `chore`, so run vLLM with thinking off by
  default (`--default-chat-template-kwargs '{"enable_thinking": false}'`).
- If the self-hosted model can't start a turn (instance stopped, error or no
  response within 20 seconds), the turn runs on the task type's Claude profile
  instead. Thinking blocks signed by vLLM are removed first, since Claude
  rejects them.
- Turns are priced from `prices["self:Qwen/Qwen3.8-27B-FP8"]`, set like Haiku.
  `/agent/keepwarm` does nothing for self-hosted turns.
- A config already published in `config_versions` has no `selfHosted` section,
  so add one and publish it to turn this on.

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
- A config published before this change has no `credits` or `billing.pack` and no longer validates,
  so the server falls back to the bundled defaults. Republish from `npm run config -- defaults`.
- Without Stripe variables, billing routes answer 503. Without `RESEND_API_KEY`, development prints sign-in
  codes to the log and production answers 503 to email sign-in.
- `APPLE_CLIENT_ID` and the `api.keel.app` domain.
