import { createHash } from "node:crypto";

/** JSON with object keys sorted at every level, so equal schemas hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The hash the tool allowlist stores: sha256 hex of the canonical JSON of the
 * tool's name and input schema. Descriptions and cache_control are left out
 * so wording tweaks don't need a config change. The Mac app computes the same
 * hash in its tests to keep the two in step.
 */
export function toolHash(tool: { name: string; input_schema: unknown }): string {
  return createHash("sha256").update(canonicalJson({ name: tool.name, input_schema: tool.input_schema })).digest("hex");
}
