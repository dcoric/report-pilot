const { SESSION_COOKIE_NAME } = require("../services/authService");

function parseCookieHeader(header) {
  const cookies = {};
  if (typeof header !== "string" || !header) {
    return cookies;
  }
  for (const segment of header.split(";")) {
    const idx = segment.indexOf("=");
    if (idx === -1) {
      continue;
    }
    const name = segment.slice(0, idx).trim();
    const value = segment.slice(idx + 1).trim();
    if (!name) {
      continue;
    }
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function readSessionToken(req) {
  const cookies = parseCookieHeader(req.headers.cookie);
  return cookies[SESSION_COOKIE_NAME] || null;
}

function isSecureCookie() {
  if (process.env.AUTH_COOKIE_SECURE === "true") {
    return true;
  }
  if (process.env.AUTH_COOKIE_SECURE === "false") {
    return false;
  }
  return process.env.NODE_ENV === "production";
}

function buildSessionCookie(token, expiresAt) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax"
  ];
  if (expiresAt) {
    const expires = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    parts.push(`Expires=${expires.toUTCString()}`);
    // AUTH-009: pair Expires with Max-Age so a clock-skewed client still
    // receives a finite-lifetime cookie. Clamp to 0 to avoid negative values
    // if the server passes an already-expired timestamp.
    const maxAgeSeconds = Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000));
    parts.push(`Max-Age=${maxAgeSeconds}`);
  }
  if (isSecureCookie()) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function buildClearSessionCookie() {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Max-Age=0"
  ];
  if (isSecureCookie()) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

module.exports = {
  parseCookieHeader,
  readSessionToken,
  buildSessionCookie,
  buildClearSessionCookie
};
