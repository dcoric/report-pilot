// HMAC-signed short-lived cookie used to carry OIDC flow state (provider id,
// PKCE code_verifier, state, nonce) between /v1/auth/oidc/login and
// /v1/auth/oidc/callback. The verifier never leaves the user agent and the
// signature prevents tampering; the cookie is HttpOnly + SameSite=Lax + Secure
// when appropriate.

const crypto = require("crypto");

const COOKIE_NAME = "rp_oidc_flow";
const FLOW_MAX_AGE_SECONDS = 10 * 60; // 10 minutes is plenty for the user to log in

let cachedSecret = null;

function getFlowSecret() {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.AUTH_FLOW_SECRET;
  if (fromEnv && fromEnv.length >= 32) {
    cachedSecret = Buffer.from(fromEnv);
    return cachedSecret;
  }
  // Fall back to a process-lifetime random secret. Flows in-flight at the
  // moment of a restart will fail; the user just retries login. Anyone running
  // multiple instances should set AUTH_FLOW_SECRET to a shared 32+ byte value.
  cachedSecret = crypto.randomBytes(32);
  if (process.env.NODE_ENV === "production") {
    // eslint-disable-next-line no-console
    console.warn(
      "[auth] AUTH_FLOW_SECRET is not set; OIDC flows will fail across instances/restarts. Set a shared 32+ byte secret."
    );
  }
  return cachedSecret;
}

function isSecureCookie() {
  if (process.env.AUTH_COOKIE_SECURE === "true") return true;
  if (process.env.AUTH_COOKIE_SECURE === "false") return false;
  return process.env.NODE_ENV === "production";
}

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payload) {
  const expiresAt = Math.floor(Date.now() / 1000) + FLOW_MAX_AGE_SECONDS;
  const body = JSON.stringify({ ...payload, exp: expiresAt });
  const bodyB64 = base64UrlEncode(body);
  const mac = crypto.createHmac("sha256", getFlowSecret()).update(bodyB64).digest();
  return `${bodyB64}.${base64UrlEncode(mac)}`;
}

function verify(value) {
  if (typeof value !== "string" || !value.includes(".")) return null;
  const [bodyB64, sigB64] = value.split(".");
  if (!bodyB64 || !sigB64) return null;
  const expected = crypto.createHmac("sha256", getFlowSecret()).update(bodyB64).digest();
  let provided;
  try {
    provided = base64UrlDecode(sigB64);
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(provided, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(bodyB64).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}

function buildFlowCookie(payload) {
  const value = sign(payload);
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${FLOW_MAX_AGE_SECONDS}`
  ];
  if (isSecureCookie()) parts.push("Secure");
  return parts.join("; ");
}

function buildClearFlowCookie() {
  const parts = [
    `${COOKIE_NAME}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Max-Age=0"
  ];
  if (isSecureCookie()) parts.push("Secure");
  return parts.join("; ");
}

function readFlowCookie(req) {
  const header = req.headers.cookie;
  if (typeof header !== "string" || !header) return null;
  for (const segment of header.split(";")) {
    const idx = segment.indexOf("=");
    if (idx === -1) continue;
    const name = segment.slice(0, idx).trim();
    if (name !== COOKIE_NAME) continue;
    let raw = segment.slice(idx + 1).trim();
    try {
      raw = decodeURIComponent(raw);
    } catch {
      // already decoded
    }
    return verify(raw);
  }
  return null;
}

module.exports = {
  COOKIE_NAME,
  FLOW_MAX_AGE_SECONDS,
  buildFlowCookie,
  buildClearFlowCookie,
  readFlowCookie,
  // exposed for tests
  __sign: sign,
  __verify: verify
};
