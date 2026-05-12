const test = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const authService = require("../src/services/authService");

test("normalizeEmail trims, lowercases, and rejects malformed addresses", () => {
  assert.equal(authService.normalizeEmail("  Alice@Example.COM "), "alice@example.com");
  assert.equal(authService.normalizeEmail("plain"), null);
  assert.equal(authService.normalizeEmail("a@b"), null);
  assert.equal(authService.normalizeEmail(""), null);
  assert.equal(authService.normalizeEmail(undefined), null);
  assert.equal(authService.normalizeEmail("a@b.c d"), null);
});

test("validatePassword enforces length and character-class policy (AUTH-009)", () => {
  // Length floor
  assert.equal(authService.validatePassword("short"), false);
  // Length ceiling
  assert.equal(authService.validatePassword("x".repeat(257)), false);
  // Empty / non-string
  assert.equal(authService.validatePassword(""), false);
  assert.equal(authService.validatePassword(123456789), false);
  // Single character class — rejected post-AUTH-009
  assert.equal(authService.validatePassword("12345678"), false);
  // Two character classes — accepted
  assert.equal(authService.validatePassword("hunter22ok"), true);
});

test("hashPassword + verifyPassword round-trip and reject wrong values", () => {
  const encoded = authService.hashPassword("correct horse battery staple");
  assert.match(encoded, /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]+$/);

  assert.equal(authService.verifyPassword("correct horse battery staple", encoded), true);
  assert.equal(authService.verifyPassword("wrong password", encoded), false);
  assert.equal(authService.verifyPassword("correct horse battery staple", ""), false);
  assert.equal(authService.verifyPassword("correct horse battery staple", "scrypt$1$1$1$00$00"), false);
});

test("hashPassword produces unique encodings per call (random salt)", () => {
  const a = authService.hashPassword("hunter22ok");
  const b = authService.hashPassword("hunter22ok");
  assert.notEqual(a, b);
  assert.equal(authService.verifyPassword("hunter22ok", a), true);
  assert.equal(authService.verifyPassword("hunter22ok", b), true);
});

test("generateSessionToken returns a 64-char hex string and hashSessionToken is deterministic", () => {
  const token = authService.generateSessionToken();
  assert.match(token, /^[0-9a-f]{64}$/);

  const hashed = authService.hashSessionToken(token);
  assert.equal(hashed.length, 64);
  assert.equal(authService.hashSessionToken(token), hashed);
});
