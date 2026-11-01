import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { requestId } from "hono/request-id";
import type { AppEnv, Deps } from "./deps.js";
import { ApiError } from "./errors.js";
import { authRoutes, linkEmailRoutes } from "./auth/routes.js";
import { billingPublicRoutes, billingRoutes } from "./billing/routes.js";
import { requireAppVersion, requireAuth } from "./auth/middleware.js";
import { proxyRoutes } from "./proxy/routes.js";
import { accountRoutes } from "./ledger/routes.js";
import { log } from "./logger.js";
import { appliedMigrations } from "./db/index.js";
import Stripe from "stripe";

/** Bump when adding a file to migrations/. The health check fails until all are applied. */
export const EXPECTED_MIGRATIONS = 3;

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.use(secureHeaders());
  app.use(requestId());

  // Access log: method, route, status and time only. Never bodies.
  app.use(async (c, next) => {
    const started = Date.now();
    await next();
    log.info("request", {
      id: c.get("requestId"),
      method: c.req.method,
      path: c.req.routePath,
      status: c.res.status,
      ms: Date.now() - started,
    });
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      if (err.status === 429) c.header("Retry-After", String(err.details?.retryAfter ?? 30));
      return c.json(err.toJSON(), err.status);
    }
    if (err instanceof Stripe.errors.StripeError) {
      // Stripe's own message says what's wrong with the setup (a missing price, a key from the
      // other mode, Stripe Tax not set up) and holds no card details, so it is safe to log.
      log.error("stripe_error", {
        id: c.get("requestId"),
        path: c.req.routePath,
        type: err.type,
        code: err.code ?? null,
        param: err.param ?? null,
        message: err.message,
        stripeRequest: err.requestId ?? null,
      });
      return c.json(
        new ApiError(502, "billing_error", "Stripe couldn't complete this request", {
          stripeCode: err.code ?? err.type,
        }).toJSON(),
        502,
      );
    }
    log.error("unhandled", { id: c.get("requestId"), path: c.req.routePath, err: err.name, message: err.message });
    return c.json(new ApiError(500, "internal", "Something went wrong").toJSON(), 500);
  });
  app.notFound((c) => c.json(new ApiError(404, "not_found", "Not found").toJSON(), 404));

  const v1 = new Hono<AppEnv>();

  v1.get("/health", async (c) => {
    await deps.sql`select 1`;
    const migrations = await appliedMigrations(deps.sql);
    // Unhealthy until the schema is in place, so a deploy without it never goes live.
    const ok = migrations.length >= EXPECTED_MIGRATIONS;
    return c.json({ ok, migrations: migrations.length }, ok ? 200 : 503);
  });

  // Stripe and browsers call these, so no app version check and no token.
  v1.route("/billing", billingPublicRoutes(deps));

  v1.use("*", requireAppVersion(deps));
  v1.route("/auth", authRoutes(deps));

  v1.get("/config", async (c) => {
    const config = await deps.config.current();
    c.header("ETag", config.etag);
    c.header("Cache-Control", "private, max-age=3600");
    if (c.req.header("if-none-match") === config.etag) return c.body(null, 304);
    const { toolAllowlist, ...doc } = config.doc;
    return c.json({ version: config.version, ...doc });
  });

  const authed = new Hono<AppEnv>();
  authed.use("*", requireAuth(deps));
  authed.route("/agent", proxyRoutes(deps));
  authed.route("/billing", billingRoutes(deps));
  authed.route("/account", linkEmailRoutes(deps));
  authed.route("/", accountRoutes(deps));
  v1.route("/", authed);

  app.route("/v1", v1);
  return app;
}
