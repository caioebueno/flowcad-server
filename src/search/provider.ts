/** One web result, as any search provider gives it. */
export interface WebResult {
  title: string;
  url: string;
  description?: string;
}

/** A web search API. The key lives here, never in the app. */
export interface SearchProvider {
  search(query: string, count: number, signal?: AbortSignal): Promise<WebResult[]>;
}

/**
 * Brave Search's web API (https://api.search.brave.com). It takes `site:`
 * operators, so the allowlist goes into the query; results are filtered by
 * host again after, as an operator is only a hint.
 */
export class BraveSearch implements SearchProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.search.brave.com/res/v1/web/search",
  ) {}

  async search(query: string, count: number, signal?: AbortSignal): Promise<WebResult[]> {
    const url = new URL(this.baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(Math.max(count, 1), 20)));
    url.searchParams.set("safesearch", "strict");
    const res = await fetch(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": this.apiKey },
      signal: signal ?? AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`brave_${res.status}`);
    const body = (await res.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    return (body.web?.results ?? []).flatMap((r) =>
      r.title && r.url ? [{ title: r.title, url: r.url, description: r.description }] : [],
    );
  }
}

/**
 * A SearXNG instance (self-hosted meta search, no per-query bill). Its
 * settings.yml must list `json` under search.formats, or it answers 403.
 */
export class SearxngSearch implements SearchProvider {
  constructor(private readonly baseUrl: string) {}

  async search(query: string, count: number, signal?: AbortSignal): Promise<WebResult[]> {
    const url = new URL("search", this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("categories", "general");
    url.searchParams.set("safesearch", "1");
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: signal ?? AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`searxng_${res.status}`);
    const body = (await res.json()) as {
      results?: { title?: string; url?: string; content?: string }[];
      unresponsive_engines?: [string, string][];
    };
    // No results because every engine was blocked (a CAPTCHA, "too many requests") isn't "nothing found":
    // say so, or the agent tells the person the part doesn't exist online.
    const down = body.unresponsive_engines ?? [];
    if (!body.results?.length && down.length > 0) {
      throw new Error(`searxng_engines_down: ${down.map(([name, why]) => `${name} (${why})`).join(", ")}`);
    }
    return (body.results ?? [])
      .flatMap((r) => (r.title && r.url ? [{ title: r.title, url: r.url, description: r.content }] : []))
      .slice(0, count);
  }
}

/**
 * GitHub code search for .step and .stp files: every hit is a file Keel can
 * download. Needs a token (any fine-grained token with public read access).
 * The site operators in the query mean nothing here, so they're cut.
 */
export class GitHubStepSearch implements SearchProvider {
  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://api.github.com/search/code",
  ) {}

  async search(query: string, count: number, signal?: AbortSignal): Promise<WebResult[]> {
    const words = query.replace(/\(.*\)/g, " ").replace(/\bSTEP model\b/i, " ").replace(/\s+/g, " ").trim();
    const out: WebResult[] = [];
    for (const ext of ["step", "stp"]) {
      const url = new URL(this.baseUrl);
      url.searchParams.set("q", `${words} extension:${ext}`);
      url.searchParams.set("per_page", String(Math.min(Math.max(count, 1), 20)));
      const res = await fetch(url, {
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.token}`, "User-Agent": "keel-account-service" },
        signal: signal ?? AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`github_${res.status}`);
      const body = (await res.json()) as { items?: { name?: string; html_url?: string; repository?: { full_name?: string } }[] };
      for (const item of body.items ?? []) {
        if (item.name && item.html_url) out.push({ title: item.name, url: item.html_url, description: item.repository?.full_name });
      }
    }
    return out.slice(0, count);
  }
}

/**
 * Several providers at once: each one's results in order, the first first.
 * One that fails is skipped; only all of them failing is an error.
 */
export class CombinedSearch implements SearchProvider {
  constructor(private readonly providers: SearchProvider[]) {}

  async search(query: string, count: number, signal?: AbortSignal): Promise<WebResult[]> {
    const settled = await Promise.allSettled(this.providers.map((p) => p.search(query, count, signal)));
    if (settled.every((s) => s.status === "rejected")) throw (settled[0] as PromiseRejectedResult).reason;
    return settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
  }
}
