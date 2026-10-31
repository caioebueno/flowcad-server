/**
 * App Attest (phase 2). The routes already call this interface so turning it
 * on is a matter of providing a real verifier and setting APP_ATTEST_MODE=enforce.
 *
 * A real implementation verifies the attestation object once per key at sign
 * in (stores the public key on the device row) and then each assertion's
 * signature and counter on agent requests.
 */
export interface AttestationInput {
  deviceId: string;
  keyId?: string;
  /** Base64 attestation object (sign in) or assertion (later requests). */
  payload?: string;
  /** The exact bytes the app signed over, usually a hash of the request. */
  clientDataHash?: string;
}

export interface AttestationVerifier {
  readonly enforced: boolean;
  verify(input: AttestationInput): Promise<boolean>;
}

export const attestationDisabled: AttestationVerifier = {
  enforced: false,
  verify: async () => true,
};

/** Placeholder for enforce mode until the real verifier lands: refuses everything. */
export const attestationNotImplemented: AttestationVerifier = {
  enforced: true,
  verify: async () => false,
};
