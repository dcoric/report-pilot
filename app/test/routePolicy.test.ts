import "./helpers/setupEnv";
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

import { findPolicy, POLICIES } from "../src/lib/routePolicy";

function requirePolicy(method: string, path: string) {
  const policy = findPolicy(method, path);
  assert.ok(policy, `expected a policy for ${method} ${path}`);
  return policy;
}

test("findPolicy maps known endpoints to the expected policy", () => {
  // Public
  assert.deepEqual(findPolicy("GET", "/health"), { method: "GET", pattern: /^\/health$/, public: true });
  assert.equal(requirePolicy("POST", "/v1/auth/login").public, true);
  assert.equal(requirePolicy("POST", "/v1/auth/logout").public, true);
  assert.equal(requirePolicy("GET", "/v1/auth/me").public, true);

  // Admin role
  assert.equal(requirePolicy("GET", "/v1/admin/users").role, "admin");
  assert.equal(requirePolicy("POST", "/v1/admin/users").role, "admin");
  assert.equal(requirePolicy("POST", "/v1/admin/users/00000000-0000-4000-8000-000000000001/roles").role, "admin");

  // Read permissions
  assert.equal(requirePolicy("GET", "/v1/data-sources").permission, "data_sources.read");
  assert.equal(requirePolicy("GET", "/v1/saved-queries").permission, "saved_queries.read");
  assert.equal(requirePolicy("GET", "/v1/saved-queries/00000000-0000-4000-8000-000000000001").permission, "saved_queries.read");
  assert.equal(requirePolicy("GET", "/v1/rag/notes").permission, "data_sources.read");
  assert.equal(requirePolicy("GET", "/v1/llm/providers").permission, "providers.read");
  assert.equal(requirePolicy("GET", "/v1/observability/metrics").permission, "observability.read");

  // Write permissions
  assert.equal(requirePolicy("POST", "/v1/data-sources").permission, "data_sources.write");
  assert.equal(requirePolicy("DELETE", "/v1/data-sources/00000000-0000-4000-8000-000000000001").permission, "data_sources.write");
  assert.equal(requirePolicy("POST", "/v1/saved-queries").permission, "saved_queries.write");
  assert.equal(requirePolicy("PUT", "/v1/saved-queries/00000000-0000-4000-8000-000000000001").permission, "saved_queries.write");
  assert.equal(requirePolicy("POST", "/v1/semantic-entities").permission, "semantic.write");
  assert.equal(requirePolicy("POST", "/v1/rag/notes").permission, "rag.write");
  assert.equal(requirePolicy("POST", "/v1/llm/providers").permission, "providers.write");
  assert.equal(requirePolicy("POST", "/v1/observability/release-gates/report").permission, "observability.write");

  // Query / run
  assert.equal(requirePolicy("POST", "/v1/query/sessions").permission, "query.run");
  assert.equal(requirePolicy("POST", "/v1/saved-queries/00000000-0000-4000-8000-000000000001/run").permission, "query.run");
  assert.equal(requirePolicy("GET", "/v1/exports/00000000-0000-4000-8000-000000000001/status").permission, "query.run");
});

test("findPolicy returns null for unknown /v1 paths", () => {
  assert.equal(findPolicy("GET", "/v1/nonexistent"), null);
  assert.equal(findPolicy("POST", "/v1/data-sources/abc/unknown"), null);
  assert.equal(findPolicy("PATCH", "/v1/data-sources"), null);
});

test("every policy entry has exactly one effective access rule", () => {
  for (const policy of POLICIES) {
    const tags = [
      policy.public ? "public" : null,
      policy.role ? "role" : null,
      policy.permission ? "permission" : null
    ].filter(Boolean);
    assert.equal(
      tags.length,
      1,
      `${policy.method} ${policy.pattern} must declare exactly one of public/role/permission (got ${tags.join("+") || "none"})`
    );
  }
});
