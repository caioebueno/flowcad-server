import type { StepSearch } from "../config/schema.js";
import type { WebResult } from "./provider.js";

/** What the app gets for each model: the page, and the file when Keel can fetch it without a sign-in. */
export interface StepModelResult {
  title: string;
  url: string;
  fileUrl: string | null;
  source: string;
  snippet: string | null;
  license: string | null;
}

type Site = StepSearch["sites"][number];

const STEP_FILE = /\.(step|stp)$/i;

/** The query sent to the provider: the part, the file type, and the allowed sites. */
export function buildQuery(query: string, sites: Site[]): string {
  const cleaned = query
    .replace(/\b(site|filetype|ext|inurl|intitle):\S*/gi, " ")
    .replace(/[()"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${cleaned} STEP model (${sites.map((s) => `site:${s.host}`).join(" OR ")})`;
}

export function siteFor(url: URL, sites: Site[]): Site | null {
  const host = url.hostname.toLowerCase();
  return sites.find((s) => host === s.host || host.endsWith(`.${s.host}`)) ?? null;
}

/**
 * The STEP file itself, when the page is one on a site that serves files to
 * anyone: a GitHub blob becomes its raw address, a GitLab blob its /-/raw/ one.
 */
export function directFile(url: URL, site: Site): string | null {
  if (!site.direct || url.protocol !== "https:" || !STEP_FILE.test(url.pathname)) return null;
  const host = url.hostname.toLowerCase();
  if (host === "github.com") {
    const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
    return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : null;
  }
  if (host === "gitlab.com" || host.endsWith(".gitlab.com")) {
    return url.pathname.includes("/-/blob/") ? `${url.origin}${url.pathname.replace("/-/blob/", "/-/raw/")}` : url.href.split("#")[0]!;
  }
  return url.href.split("#")[0]!;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

/** Providers mark matches with tags and entities; the app shows plain text. */
export function plain(text: string | undefined, max: number): string {
  return (text ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e]!)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Provider results on allowed sites only, one per address, as the app reads them. */
export function toStepModels(results: WebResult[], sites: Site[], limit: number): StepModelResult[] {
  const seen = new Set<string>();
  const out: StepModelResult[] = [];
  for (const r of results) {
    let url: URL;
    try {
      url = new URL(r.url);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    const site = siteFor(url, sites);
    if (!site) continue;
    const key = url.href.split("#")[0]!;
    if (seen.has(key)) continue;
    seen.add(key);
    const title = plain(r.title, 160);
    if (!title) continue;
    out.push({
      title,
      url: key,
      fileUrl: directFile(url, site),
      source: site.name,
      snippet: plain(r.description, 300) || null,
      license: site.license ?? null,
    });
    if (out.length >= limit) break;
  }
  // Files Keel can fetch first: they go straight into the Import sheet.
  return out.sort((a, b) => Number(b.fileUrl !== null) - Number(a.fileUrl !== null));
}
