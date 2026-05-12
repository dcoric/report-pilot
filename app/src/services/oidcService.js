// OIDC authorization-code + PKCE flow, wrapping `openid-client@^6`.
//
// startLogin(provider) generates state/nonce/PKCE, returns the authorize URL
// the browser should be redirected to, and the cookie payload the caller
// stores in a signed cookie.
//
// completeLogin(provider, currentUrl, expected) validates the IdP response,
// pulls claims from id_token + userinfo, and returns the email + display name
// the route handler matches against the local users table.

let oidcClient = null;
function getOidcClient() {
  if (!oidcClient) {
    // openid-client v6 is ESM-only. Require dynamic import so this module can
    // be `require`'d normally in the rest of the codebase.
    oidcClient = import("openid-client");
  }
  return oidcClient;
}

const DEFAULT_CLAIM_EMAIL = "email";
const DEFAULT_CLAIM_DISPLAY_NAME = "name";

function emailClaimFor(provider) {
  return (provider.claims_mapping && provider.claims_mapping.email) || DEFAULT_CLAIM_EMAIL;
}

function displayNameClaimFor(provider) {
  return (provider.claims_mapping && provider.claims_mapping.display_name) || DEFAULT_CLAIM_DISPLAY_NAME;
}

async function buildConfiguration(provider) {
  const client = await getOidcClient();
  const issuerUrl = new URL(provider.issuer);
  // openid-client v6 rejects http:// issuers by default. Allow them for
  // localhost / dev / tests; production should be https anyway.
  const allowHttp = issuerUrl.protocol === "http:";
  const options = allowHttp ? { execute: [client.allowInsecureRequests] } : undefined;
  if (provider.client_secret) {
    return client.discovery(issuerUrl, provider.client_id, provider.client_secret, undefined, options);
  }
  return client.discovery(issuerUrl, provider.client_id, undefined, undefined, options);
}

async function startLogin(provider) {
  if (!provider || !provider.enabled) {
    throw Object.assign(new Error("provider is disabled or not found"), { statusCode: 404 });
  }
  const client = await getOidcClient();
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

async function completeLogin(provider, currentUrl, flowState) {
  if (!provider) {
    throw Object.assign(new Error("provider not found"), { statusCode: 404 });
  }
  if (!flowState || flowState.provider_id !== provider.id) {
    throw Object.assign(new Error("invalid flow state"), { statusCode: 400 });
  }

  const client = await getOidcClient();
  const config = await buildConfiguration(provider);

  let tokens;
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
    throw Object.assign(new Error(`OIDC token exchange failed: ${err.message}`), { statusCode: 400, cause: err });
  }

  const claims = tokens.claims ? tokens.claims() : null;
  let merged = { ...(claims || {}) };

  // Some IdPs only include email in the userinfo endpoint.
  if (!merged[emailClaimFor(provider)]) {
    try {
      const userinfo = await client.fetchUserInfo(config, tokens.access_token, claims ? claims.sub : undefined);
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
    sub: merged.sub || null,
    issuer: merged.iss || provider.issuer,
    claims: merged
  };
}

module.exports = {
  startLogin,
  completeLogin
};
