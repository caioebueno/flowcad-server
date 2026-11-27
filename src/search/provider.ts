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
