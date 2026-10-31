import type { Context } from "hono";
import type { z } from "zod";
import { ApiError } from "../errors.js";

export async function parseJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError(400, "invalid_request", "Body must be JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    // Paths only, never values: values may contain user content.
    const issues = parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), code: i.code }));
    throw new ApiError(400, "invalid_request", "Request body is invalid", { issues });
  }
  return parsed.data;
}
