// In-process mock OIDC IdP used by the AUTH-010 callback tests. Serves the
// `.well-known/openid-configuration`, a JWKS endpoint, an `/authorize` page
// that auto-consents and bounces back to the caller, a `/token` endpoint that
// exchanges the code for an RS256-signed id_token (plus access token), and a
// `/userinfo` endpoint that returns the configured claims.
//
// Usage:
//   const idp = await createMockOidcIdp({ user: { email: "alice@example.com", name: "Alice" } });
//   await idp.start();
//   // idp.issuer is a URL string the auth_providers row should point at.
//   await idp.stop();

import * as http from "http";
import * as crypto from "crypto";
import { URL } from "url";

interface MockOidcUser {
  sub: string;
  email: string;
  name: string;
}

export interface CreateMockOidcIdpOptions {
  user?: Partial<MockOidcUser>;
  clientId?: string;
  clientSecret?: string;
}

export interface MockOidcIdp {
  start(): Promise<string>;
  stop(): Promise<void>;
  readonly issuer: string | null;
  clientId: string;
  clientSecret: string;
  updateUser(next: Partial<MockOidcUser>): void;
}

function base64url(buf: Buffer | string): string {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

interface JwtSignOptions {
  privateKey: crypto.KeyObject;
  kid: string;
  alg?: string;
}

function signJwt(payload: Record<string, unknown>, { privateKey, kid, alg = "RS256" }: JwtSignOptions): string {
  const header = { alg, kid, typ: "JWT" };
  const segments = [base64url(JSON.stringify(header)), base64url(JSON.stringify(payload))];
  const signingInput = segments.join(".");
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

interface IssuedCodeRecord {
  codeChallenge: string;
  nonce: string | null;
  redirectUri: string;
}

export async function createMockOidcIdp({
  user: initialUser = { sub: "user-123", email: "alice@example.com", name: "Alice" },
  clientId = "test-client",
  clientSecret = "test-secret"
}: CreateMockOidcIdpOptions = {}): Promise<MockOidcIdp> {
  const user: MockOidcUser = {
    sub: initialUser.sub ?? "user-123",
    email: initialUser.email ?? "alice@example.com",
    name: initialUser.name ?? "Alice"
  };
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; [k: string]: unknown };
  const kid = base64url(crypto.createHash("sha256").update(jwk.n).digest()).slice(0, 16);

  // Track issued authorization codes so /token only honors them once.
  const issuedCodes = new Map<string, IssuedCodeRecord>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      const issuer = `http://${req.headers.host}`;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["openid", "email", "profile"]
      }));
    }

    if (req.method === "GET" && url.pathname === "/.well-known/jwks.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }]
      }));
    }

    if (req.method === "GET" && url.pathname === "/authorize") {
      const responseType = url.searchParams.get("response_type");
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const nonce = url.searchParams.get("nonce");
      const codeChallenge = url.searchParams.get("code_challenge");
      const codeChallengeMethod = url.searchParams.get("code_challenge_method");

      if (responseType !== "code" || !redirectUri || !state || !codeChallenge || codeChallengeMethod !== "S256") {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid_request" }));
      }
      const code = base64url(crypto.randomBytes(24));
      issuedCodes.set(code, { codeChallenge, nonce, redirectUri });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", state);
      res.writeHead(302, { Location: target.href });
      return res.end();
    }

    if (req.method === "POST" && url.pathname === "/token") {
      const body = await parseBody(req);
      const params = new URLSearchParams(body);
      const grantType = params.get("grant_type");
      const code = params.get("code");
      const codeVerifier = params.get("code_verifier");
      const redirectUri = params.get("redirect_uri");

      if (grantType !== "authorization_code" || !code || !codeVerifier) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid_grant" }));
      }
      const record = issuedCodes.get(code);
      if (!record) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid_grant", error_description: "unknown code" }));
      }
      issuedCodes.delete(code);
      if (redirectUri !== record.redirectUri) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid_grant", error_description: "redirect_uri mismatch" }));
      }
      const challenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
      if (challenge !== record.codeChallenge) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid_grant", error_description: "pkce mismatch" }));
      }

      const issuer = `http://${req.headers.host}`;
      const now = Math.floor(Date.now() / 1000);
      const idToken = signJwt({
        iss: issuer,
        sub: user.sub,
        aud: clientId,
        iat: now,
        exp: now + 600,
        nonce: record.nonce,
        email: user.email,
        name: user.name
      }, { privateKey, kid });

      const accessToken = base64url(crypto.randomBytes(24));
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 600,
        id_token: idToken,
        scope: "openid email profile"
      }));
    }

    if (req.method === "GET" && url.pathname === "/userinfo") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        sub: user.sub,
        email: user.email,
        name: user.name
      }));
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found", path: url.pathname }));
  });

  let issuer: string | null = null;

  return {
    start: async () => new Promise<string>((resolve, reject) => {
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("mock OIDC IdP failed to bind"));
          return;
        }
        issuer = `http://127.0.0.1:${address.port}`;
        resolve(issuer);
      });
    }),
    stop: async () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
    get issuer() { return issuer; },
    clientId,
    clientSecret,
    updateUser(next: Partial<MockOidcUser>) { Object.assign(user, next); }
  };
}
