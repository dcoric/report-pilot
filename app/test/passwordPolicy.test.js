// AUTH-009: server-side password policy. Pure unit tests against the
// policy function — no DB / HTTP setup needed, but authService transitively
// requires appDb which insists on a DATABASE_URL even when it's never used.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const authService = require("../src/services/authService");

test("rejects passwords below the minimum length", () => {
  const result = authService.checkPasswordPolicy("Ab1!");
  assert.equal(result.ok, false);
  assert.equal(result.code, "password_too_short");
});

test("rejects passwords above the maximum length", () => {
  const tooLong = "A1!".repeat(100);
  const result = authService.checkPasswordPolicy(tooLong);
  assert.equal(result.ok, false);
  assert.equal(result.code, "password_too_long");
});

test("rejects passwords with only one character class", () => {
  const result = authService.checkPasswordPolicy("aaaaaaaaaaaaaa");
  assert.equal(result.ok, false);
  assert.equal(result.code, "password_too_weak");
});

test("accepts passwords with two character classes", () => {
  const result = authService.checkPasswordPolicy("hunter22ok");
  assert.equal(result.ok, true);
});

test("rejects banned common passwords regardless of case", () => {
  for (const variant of ["password1", "Password1", "PASSWORD1"]) {
    const result = authService.checkPasswordPolicy(variant);
    assert.equal(result.ok, false, `should reject ${variant}`);
    assert.equal(result.code, "password_banned");
  }
});

test("rejects passwords that equal the email local-part", () => {
  const result = authService.checkPasswordPolicy("alice123", { email: "alice123@example.com" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "password_matches_email");
});

test("passes a strong password unrelated to the email", () => {
  const result = authService.checkPasswordPolicy("Tr0ub4dor!!", { email: "alice@example.com" });
  assert.equal(result.ok, true);
});

test("rejects non-string input", () => {
  assert.equal(authService.checkPasswordPolicy(undefined).ok, false);
  assert.equal(authService.checkPasswordPolicy(null).ok, false);
  assert.equal(authService.checkPasswordPolicy(12345678).ok, false);
});

test("validatePassword is a boolean shim over checkPasswordPolicy", () => {
  assert.equal(authService.validatePassword("hunter22ok"), true);
  assert.equal(authService.validatePassword("short"), false);
});
