# Keel account service

The small web service between the Keel Mac app and Claude's API. It holds Keel's
Anthropic key, signs people in with Apple, sets the model and limits for each task
type, streams agent turns through to Claude, and records what every turn cost.
It stores no prompts, replies, CAD files or project content.

TypeScript on Node 22, [Hono](https://hono.dev), Postgres, hosted on Fly.io.

## Status

Phase 1 of the spec (proxy, sign-in, ledger) is built, plus the pieces of phase 2
that phase 1 needs anyway (remote config and the monthly allowance).

| Area | State |
| --- | --- |
| `POST /auth/apple`, `/auth/refresh`, `/auth/logout` | Done. 15 minute access tokens, 60 day rotating refresh tokens stored as hashes, reuse revokes the device |
| `POST /agent/turn`, `/agent/keepwarm` | Done. Task profiles, request checks, run caps, streaming, `keel.usage` / `keel.warning` / `keel.error` events |
| `GET /usage`, `GET /account`, device list and revoke | Done. Usage shown as percent of allowance, never dollars |
| `GET /config` | Done. Versioned in `config_versions`, served with an ETag |
| Monthly allowance (80% warning, 402 at 100%) | Done |
| App Attest | Interface and middleware in place, off by default (phase 2) |
| Rate limits (30 turns/min, 3 concurrent runs, 10 sign-ins/hour/IP) | Values served in config, not enforced yet (phase 2) |
| Overnight reviews (`/batches`) and push | Not started (phase 3). The `overnight_review` profile already exists |
| Billing | Not started (phase 4). Plans come from `PlanProvider`, so StoreKit or Stripe can slot in later |

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

## Deploying to Fly.io

```sh
fly launch --no-deploy          # uses fly.toml; pick the region
fly postgres create             # or use Neon and set DATABASE_URL
fly postgres attach <pg-app>
fly secrets set ANTHROPIC_API_KEY=... ACCESS_TOKEN_SECRET=$(openssl rand -hex 32) \
  PROJECT_HASH_SALT=$(openssl rand -hex 16) APPLE_CLIENT_ID=<bundle id>
fly deploy                      # runs migrations as the release command
fly scale count 2
```

Use a key from a dedicated Anthropic workspace with a spend limit set on it.

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
- Plan allowances are placeholders ($50 a month for `beta`); the spec leaves them open.
- `APPLE_CLIENT_ID` and the `api.keel.app` domain.
