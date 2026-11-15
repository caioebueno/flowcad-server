import type { Context } from "hono";

/**
 * The client's IP, for rate limits. Railway's proxy appends the address it saw
 * to X-Forwarded-For, so the right-most entry is the one a client can't forge;
 * anything to its left came from the client and is ignored.
 */
export const rateLimitIp = (c: Context) => {
  const forwarded = c.req.header("x-forwarded-for");
  const last = forwarded?.split(",").map((s) => s.trim()).filter(Boolean).at(-1);
  return last || c.req.header("x-real-ip")?.trim() || "unknown";
};
