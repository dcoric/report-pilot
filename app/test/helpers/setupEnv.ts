// Side-effect-only module that primes test-time env vars before any other
// module loads `lib/appDb` (which requires DATABASE_URL on import). Tests
// that previously did `process.env.DATABASE_URL = ...` inline relied on
// CommonJS ordering; under ES imports the bare assignments would run after
// the hoisted imports, so we move them into this side-effect import which
// callers list first.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.PORT = process.env.PORT ?? "0";
process.env.AUTH_COOKIE_SECURE = process.env.AUTH_COOKIE_SECURE ?? "false";
