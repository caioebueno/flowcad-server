import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface AppleIdentity {
  /** Apple's stable user id (`sub`), unique per developer team. */
  userId: string;
  email: string | null;
}

export interface AppleIdentityVerifier {
  verify(identityToken: string, rawNonce?: string): Promise<AppleIdentity>;
}

export const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_KEYS_URL = new URL("https://appleid.apple.com/auth/keys");

export class IdentityTokenError extends Error {}

/**
 * Verifies a Sign in with Apple identity token: signature against Apple's
 * published keys, issuer, audience (the app's bundle id) and expiry. When the
 * app sent a nonce with the authorization request, the token's `nonce` claim
 * is the SHA-256 hex of it.
 */
export function appleVerifier(clientId: string, keys: JWTVerifyGetKey = createRemoteJWKSet(APPLE_KEYS_URL)): AppleIdentityVerifier {
  return {
    async verify(identityToken, rawNonce) {
      let payload;
      try {
        ({ payload } = await jwtVerify(identityToken, keys, {
          issuer: APPLE_ISSUER,
          audience: clientId,
          algorithms: ["RS256"],
        }));
      } catch (err) {
        throw new IdentityTokenError(`Identity token rejected: ${(err as Error).name}`);
      }
      if (!payload.sub) throw new IdentityTokenError("Identity token has no subject");
      if (rawNonce !== undefined) {
        const expected = createHash("sha256").update(rawNonce).digest("hex");
        if (payload.nonce !== expected) throw new IdentityTokenError("Identity token nonce mismatch");
      }
      const email = typeof payload.email === "string" ? payload.email : null;
      return { userId: payload.sub, email };
    },
  };
}
