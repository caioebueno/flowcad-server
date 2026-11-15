/**
 * Single Sign-On through WorkOS (https://workos.com/docs/reference/sso).
 * WorkOS speaks SAML and OIDC to each company's identity provider and hands
 * this service a profile; the app never talks to WorkOS directly.
 */

export interface SsoProfile {
  /** WorkOS profile id: stable for this person in this connection. */
  id: string;
  email: string;
  organizationId: string | null;
  firstName: string | null;
  lastName: string | null;
}

export interface SsoProvider {
  /** The WorkOS organization that owns this email domain, or null when none does. */
  organizationForDomain(domain: string): Promise<string | null>;
  authorizeUrl(opts: { organizationId: string; redirectUri: string; state: string; loginHint?: string }): string;
  /** Exchanges the authorization code WorkOS sent to the callback for the person's profile. */
  profile(code: string): Promise<SsoProfile>;
}

export class SsoProviderError extends Error {}

const WORKOS_API = "https://api.workos.com";

export class WorkOSProvider implements SsoProvider {
  constructor(
    private readonly apiKey: string,
    private readonly clientId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async organizationForDomain(domain: string): Promise<string | null> {
    const url = new URL("/organizations", WORKOS_API);
    url.searchParams.append("domains", domain);
    url.searchParams.set("limit", "1");
    const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${this.apiKey}` } });
    if (!res.ok) throw new SsoProviderError(`WorkOS organizations: ${res.status}`);
    const body = (await res.json()) as { data?: { id: string }[] };
    return body.data?.[0]?.id ?? null;
  }

  authorizeUrl(opts: { organizationId: string; redirectUri: string; state: string; loginHint?: string }): string {
    const url = new URL("/sso/authorize", WORKOS_API);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", opts.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", opts.state);
    url.searchParams.set("organization", opts.organizationId);
    if (opts.loginHint) url.searchParams.set("login_hint", opts.loginHint);
    return url.toString();
  }

  async profile(code: string): Promise<SsoProfile> {
    const res = await this.fetchImpl(new URL("/sso/token", WORKOS_API), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.apiKey,
        grant_type: "authorization_code",
        code,
      }),
    });
    if (!res.ok) throw new SsoProviderError(`WorkOS token: ${res.status}`);
    const body = (await res.json()) as {
      profile?: { id?: string; email?: string; organization_id?: string | null; first_name?: string | null; last_name?: string | null };
    };
    const p = body.profile;
    if (!p?.id || !p.email) throw new SsoProviderError("WorkOS profile has no id or email");
    return {
      id: p.id,
      email: p.email,
      organizationId: p.organization_id ?? null,
      firstName: p.first_name ?? null,
      lastName: p.last_name ?? null,
    };
  }
}
