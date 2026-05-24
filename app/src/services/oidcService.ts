// OIDC authorization-code + PKCE flow, wrapping `openid-client@^6`.
//
// startLogin(provider) generates state/nonce/PKCE, returns the authorize URL
// the browser should be redirected to, and the cookie payload the caller
// stores in a signed cookie.
//
// completeLogin(provider, currentUrl, expected) validates the IdP response,
// pulls claims from id_token + userinfo, and returns the email + display name
// the route handler matches against the local users table.

export interface OidcProvider {
  id: string;
  enabled: boolean;
  issuer: string;
  client_id: string;
  client_secret?: string | null;
  redirect_uri: string;
  scopes?: string[] | null;
  claims_mapping?: { email?: string; display_name?: string } | null;
}

export interface FlowState {
  provider_id: string;
  state: string;
  nonce: string;
  code_verifier: string;
}

export interface StartLoginResult {
  authorizeUrl: string;
  flowState: FlowState;
}

export interface CompleteLoginResult {
  email: string;
  display_name: string | null;
  sub: string | null;
  issuer: string;
  claims: Record<string, unknown>;
}

export interface TestConnectionResult {
  ok: boolean;
  error?: string;
  issuer?: string;
  authorization_endpoint?: string | null;
  token_endpoint?: string | null;
  userinfo_endpoint?: string | null;
  jwks_uri?: string | null;
  id_token_signing_alg_values_supported?: string[];
  code_challenge_methods_supported?: string[];
  response_types_supported?: string[];
}

let oidcClient: Promise<typeof import("openid-client")> | null = null;
function getOidcClient(): Promise<typeof import("openid-client")> {
  if (!oidcClient) {
    // openid-client v6 is ESM-only. Use dynamic import so this module can
    // be `require`'d normally in the rest of the codebase.
    oidcClient = import("openid-client");
  }
  return oidcClient;
}

const DEFAULT_CLAIM_EMAIL = "email";
const DEFAULT_CLAIM_DISPLAY_NAME = "name";

function emailClaimFor(provider: OidcProvider): string {
  return (provider.claims_mapping && provider.claims_mapping.email) || DEFAULT_CLAIM_EMAIL;
}

function displayNameClaimFor(provider: OidcProvider): string {
  return (provider.claims_mapping && provider.claims_mapping.display_name) || DEFAULT_CLAIM_DISPLAY_NAME;
}

// AUTH-015: clock-skew tolerance for ID-token validation. Most production
// IdPs sit behind load balancers whose clock can drift a handful of seconds;
// 60s is the openid-client recommended default for production deployments
// and matches what every major IdP documents. Configurable so deployments
// with stricter requirements can dial it down.
function getClockToleranceSeconds(): number {
  const raw = Number(process.env.AUTH_OIDC_CLOCK_TOLERANCE_SECONDS);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 600) {
    return Math.floor(raw);
  }
  return 60;
}

async function buildConfiguration(provider: OidcProvider): Promise<unknown> {
  const client = await getOidcClient();
  const issuerUrl = new URL(provider.issuer);
  // openid-client v6 rejects http:// issuers by default. Allow them for
  // localhost / dev / tests; production should be https anyway.
  const allowHttp = issuerUrl.protocol === "http:";
  const options = allowHttp ? { execute: [(client as Record<string, unknown>).allowInsecureRequests] } : undefined;
  // Metadata object carries the clientSecret (when present) and the
  // clock-skew tolerance. openid-client treats clockTolerance as a Symbol
  // key on the metadata object.
  const clockToleranceKey = (client as { clockTolerance: symbol }).clockTolerance;
  const metadata: Record<string | symbol, unknown> = {
    [clockToleranceKey]: getClockToleranceSeconds()
  };
  if (provider.client_secret) {
    metadata.client_secret = provider.client_secret;
  }
  return (client as { discovery: (issuer: URL, clientId: string, metadata: unknown, jwks: unknown, options: unknown) => Promise<unknown> })
    .discovery(issuerUrl, provider.client_id, metadata, undefined, options);
}

export async function startLogin(provider: OidcProvider): Promise<StartLoginResult> {
  if (!provider || !provider.enabled) {
    throw Object.assign(new Error("provider is disabled or not found"), { statusCode: 404 });
  }
  const client = await getOidcClient() as Record<string, unknown> & {
    randomState: () => string;
    randomNonce: () => string;
    randomPKCECodeVerifier: () => string;
    calculatePKCECodeChallenge: (verifier: string) => Promise<string>;
    buildAuthorizationUrl: (config: unknown, opts: Record<string, unknown>) => URL;
  };
  const config = await buildConfiguration(provider);

  const state = client.randomState();
  const nonce = client.randomNonce();
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);

  const authorizeUrl = client.buildAuthorizationUrl(config, {
    redirect_uri: provider.redirect_uri,
    scope: (provider.scopes || ["openid", "email", "profile"]).join(" "),
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  });

  return {
    authorizeUrl: authorizeUrl.href,
    flowState: {
      provider_id: provider.id,
      state,
      nonce,
      code_verifier: codeVerifier
    }
  };
}

export async function completeLogin(provider: OidcProvider, currentUrl: string, flowState: FlowState | null | undefined): Promise<CompleteLoginResult> {
  if (!provider) {
    throw Object.assign(new Error("provider not found"), { statusCode: 404 });
  }
  if (!flowState || flowState.provider_id !== provider.id) {
    throw Object.assign(new Error("invalid flow state"), { statusCode: 400 });
  }

  const client = await getOidcClient() as Record<string, unknown> & {
    authorizationCodeGrant: (config: unknown, url: URL, opts: Record<string, unknown>) => Promise<{
      claims?: () => Record<string, unknown> | null;
      access_token: string;
    }>;
    fetchUserInfo: (config: unknown, accessToken: string, sub: string | undefined) => Promise<Record<string, unknown>>;
  };
  const config = await buildConfiguration(provider);

  let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
  try {
    tokens = await client.authorizationCodeGrant(
      config,
      new URL(currentUrl),
      {
        pkceCodeVerifier: flowState.code_verifier,
        expectedState: flowState.state,
        expectedNonce: flowState.nonce
      }
    );
  } catch (err) {
    throw Object.assign(new Error(`OIDC token exchange failed: ${(err as Error).message}`), { statusCode: 400, cause: err });
  }

  const claims = tokens.claims ? tokens.claims() : null;
  let merged: Record<string, unknown> = { ...(claims || {}) };

  // Some IdPs only include email in the userinfo endpoint.
  if (!merged[emailClaimFor(provider)]) {
    try {
      const userinfo = await client.fetchUserInfo(config, tokens.access_token, claims ? (claims.sub as string | undefined) : undefined);
      merged = { ...merged, ...userinfo };
    } catch {
      // userinfo failure is non-fatal; we'll surface the missing-email error below.
    }
  }

  const email = merged[emailClaimFor(provider)];
  if (typeof email !== "string" || !email.trim()) {
    throw Object.assign(
      new Error(`OIDC response missing the '${emailClaimFor(provider)}' claim`),
      { statusCode: 400 }
    );
  }

  const displayName = merged[displayNameClaimFor(provider)];
  return {
    email: email.trim().toLowerCase(),
    display_name: typeof displayName === "string" && displayName.trim() ? displayName.trim() : null,
    sub: (merged.sub as string | undefined) || null,
    issuer: (merged.iss as string | undefined) || provider.issuer,
    claims: merged
  };
}

// Lightweight reachability check: runs discovery against the issuer (which
// fetches `.well-known/openid-configuration` and the JWKS) and returns a
// success/error summary the admin UI can show. We do not actually try to
// authenticate.
export async function testConnection(provider: OidcProvider | null | undefined): Promise<TestConnectionResult> {
  if (!provider) {
    return { ok: false, error: "provider not found" };
  }
  try {
    await getOidcClient();
    const config = await buildConfiguration(provider) as { serverMetadata: () => Record<string, unknown> };
    const metadata = config.serverMetadata();
    return {
      ok: true,
      issuer: (metadata.issuer as string) || provider.issuer,
      authorization_endpoint: (metadata.authorization_endpoint as string | null) || null,
      token_endpoint: (metadata.token_endpoint as string | null) || null,
      userinfo_endpoint: (metadata.userinfo_endpoint as string | null) || null,
      jwks_uri: (metadata.jwks_uri as string | null) || null,
      id_token_signing_alg_values_supported: (metadata.id_token_signing_alg_values_supported as string[]) || [],
      code_challenge_methods_supported: (metadata.code_challenge_methods_supported as string[]) || [],
      // Surface a name-only summary of what the IdP advertises so the UI can
      // sanity-check scope/response_type configuration without sending the
      // entire blob through.
      response_types_supported: (metadata.response_types_supported as string[]) || []
    };
  } catch (err) {
    return {
      ok: false,
      error: err && (err as Error).message ? (err as Error).message : String(err)
    };
  }
}
