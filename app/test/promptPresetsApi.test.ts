// AUTH-007: end-to-end coverage for the /v1/users/me/prompt-presets surface.

import "./helpers/setupEnv";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.PORT = "0";
process.env.AUTH_COOKIE_SECURE = "false";

import appDb = require("../src/lib/appDb");
import { createAuthTestStub } from "./helpers/authTestStub";
import type {
  PromptPreset,
  PromptPresetRow,
  PresetVisibility
} from "../src/services/promptPresetService";

interface ErrorPayload {
  code: string;
}

interface PromptPresetListPayload {
  items: PromptPreset[];
}

interface CallResult<T> {
  status: number;
  payload: T;
}

let server: import("http").Server;
let baseUrl: string;
let authStub: import("./helpers/authTestStub").AuthTestStub;
let originalQuery: typeof appDb.query;
let presets: Map<string, PromptPresetRow>;       // id -> row
let dataSources: Map<string, { id: string }>;   // id -> row
let presetCounter: number;
let aliceCookie: string;
let bobCookie: string;
let aliceId: string;

function uuid(prefix: string, counter: number) {
  return `00000000-0000-4000-8000-${prefix}${String(counter).padStart(8, "0")}`;
}
function nextPresetId() { presetCounter += 1; return uuid("9988", presetCounter); }

function normalize(sql: string) {
  return String(sql).replace(/\s+/g, " ").trim().toLowerCase();
}

async function call<T = unknown>(
  method: string,
  path: string,
  { cookie, body }: { cookie?: string; body?: unknown } = {}
): Promise<CallResult<T>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let payload: unknown = null;
  if ((response.headers.get("content-type") || "").includes("application/json")) {
    try { payload = await response.json(); } catch { payload = null; }
  }
  return { status: response.status, payload: payload as T };
}

before(async () => {
  authStub = createAuthTestStub();
  originalQuery = appDb.query;
  presets = new Map();
  dataSources = new Map();
  presetCounter = 0;

  const alice = authStub.seedUser({ email: "alice@example.com", roles: ["analyst"], password: "Hunter22ok!" });
  const bob = authStub.seedUser({ email: "bob@example.com", roles: ["analyst"], password: "Hunter22ok!" });
  aliceId = alice.id;
  aliceCookie = authStub.cookieFor(authStub.seedSession(alice.id).token);
  bobCookie = authStub.cookieFor(authStub.seedSession(bob.id).token);

  // Pre-seed one data source so the FK check has something to find.
  dataSources.set("00000000-0000-4000-8000-d5d5d5d5d5d5", { id: "00000000-0000-4000-8000-d5d5d5d5d5d5" });

  appDb.query = (async (sql: string, params: unknown[] = []) => {
    const auth = authStub.handleSql(sql, params);
    if (auth) return auth;

    const n = normalize(sql);

    if (n.startsWith("select id, owner_user_id, title, prompt_text, data_source_id, tags, visibility, created_at, updated_at from prompt_presets where owner_user_id = $1 or visibility = 'shared'")) {
      const [userId] = params as [string];
      const rows = [...presets.values()]
        .filter((p) => p.owner_user_id === userId || p.visibility === "shared")
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return { rowCount: rows.length, rows };
    }
    if (n.startsWith("select id, owner_user_id, title, prompt_text, data_source_id, tags, visibility, created_at, updated_at from prompt_presets where id = $1")) {
      const [id] = params as [string];
      const row = presets.get(id);
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }

    if (n.startsWith("select id from data_sources where id = $1")) {
      const [id] = params as [string];
      return dataSources.has(id) ? { rowCount: 1, rows: [{ id }] } : { rowCount: 0, rows: [] };
    }

    if (n.startsWith("insert into prompt_presets")) {
      const [ownerUserId, title, promptText, dataSourceId, tags, visibility] = params as [
        string,
        string,
        string,
        string | null,
        string[] | null,
        PresetVisibility
      ];
      const row: PromptPresetRow = {
        id: nextPresetId(),
        owner_user_id: ownerUserId,
        title,
        prompt_text: promptText,
        data_source_id: dataSourceId,
        tags: tags || [],
        visibility,
        created_at: new Date(Date.now() + presetCounter).toISOString(),
        updated_at: new Date().toISOString()
      };
      presets.set(row.id, row);
      return { rowCount: 1, rows: [row] };
    }

    if (n.startsWith("update prompt_presets set title = $2, prompt_text = $3, data_source_id = $4, tags = $5, visibility = $6, updated_at = now() where id = $1")) {
      const [id, title, promptText, dataSourceId, tags, visibility] = params as [
        string,
        string,
        string,
        string | null,
        string[] | null,
        PresetVisibility
      ];
      const row = presets.get(id);
      if (!row) return { rowCount: 0, rows: [] };
      row.title = title;
      row.prompt_text = promptText;
      row.data_source_id = dataSourceId;
      row.tags = tags || [];
      row.visibility = visibility;
      row.updated_at = new Date().toISOString();
      presets.set(id, row);
      return { rowCount: 1, rows: [row] };
    }

    if (n.startsWith("delete from prompt_presets where id = $1")) {
      const [id] = params as [string];
      const had = presets.delete(id);
      return { rowCount: had ? 1 : 0, rows: [] };
    }

    throw new Error(`Unexpected SQL in prompt-presets test stub: ${n}`);
  }) as unknown as typeof appDb.query;

  delete require.cache[require.resolve("../src/server")];
  const { startServer } = require("../src/server");
  server = await startServer();
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  appDb.query = originalQuery;
});

beforeEach(() => {
  presets.clear();
  presetCounter = 0;
});

test("GET is unauthenticated → 401", async () => {
  const result = await call("GET", "/v1/users/me/prompt-presets");
  assert.equal(result.status, 401);
});

test("POST creates a private preset for the caller", async () => {
  const result = await call<PromptPreset>("POST", "/v1/users/me/prompt-presets", {
    cookie: aliceCookie,
    body: { title: "Revenue YoY", prompt_text: "Show revenue YoY by region" }
  });
  assert.equal(result.status, 201, JSON.stringify(result.payload));
  assert.equal(result.payload.title, "Revenue YoY");
  assert.equal(result.payload.visibility, "private");
  assert.equal(result.payload.owner_user_id, aliceId);
});

test("POST rejects invalid input with a stable code", async () => {
  const result = await call<ErrorPayload>("POST", "/v1/users/me/prompt-presets", {
    cookie: aliceCookie,
    body: { title: "" }
  });
  assert.equal(result.status, 400);
  assert.equal(result.payload.code, "invalid_title");
});

test("POST with unknown data_source_id returns 400", async () => {
  const result = await call<ErrorPayload>("POST", "/v1/users/me/prompt-presets", {
    cookie: aliceCookie,
    body: { title: "Foo", prompt_text: "bar", data_source_id: "00000000-0000-4000-8000-deadbeef0001" }
  });
  assert.equal(result.status, 400);
  assert.equal(result.payload.code, "unknown_data_source");
});

test("GET returns the caller's own presets + shared presets from others", async () => {
  // Alice creates a private preset.
  await call("POST", "/v1/users/me/prompt-presets", {
    cookie: aliceCookie,
    body: { title: "Alice private", prompt_text: "p1" }
  });
  // Bob creates a private preset (should NOT show in Alice's list).
  await call("POST", "/v1/users/me/prompt-presets", {
    cookie: bobCookie,
    body: { title: "Bob private", prompt_text: "p2" }
  });
  // Bob creates a shared preset (SHOULD show in Alice's list).
  await call("POST", "/v1/users/me/prompt-presets", {
    cookie: bobCookie,
    body: { title: "Bob shared", prompt_text: "p3", visibility: "shared" }
  });

  const aliceList = await call<PromptPresetListPayload>("GET", "/v1/users/me/prompt-presets", { cookie: aliceCookie });
  assert.equal(aliceList.status, 200);
  const titles = aliceList.payload.items.map((it) => it.title).sort();
  assert.deepEqual(titles, ["Alice private", "Bob shared"]);
});

test("PUT enforces ownership: a non-owner gets 403", async () => {
  const created = await call<PromptPreset>("POST", "/v1/users/me/prompt-presets", {
    cookie: aliceCookie,
    body: { title: "Alice's", prompt_text: "p", visibility: "shared" }
  });
  assert.equal(created.status, 201);
  const update = await call("PUT", `/v1/users/me/prompt-presets/${created.payload.id}`, {
    cookie: bobCookie,
    body: { title: "Bob renamed" }
  });
  assert.equal(update.status, 403);
});

test("PUT by owner applies a partial update", async () => {
  const created = await call<PromptPreset>("POST", "/v1/users/me/prompt-presets", {
    cookie: aliceCookie,
    body: { title: "Draft", prompt_text: "x" }
  });
  const update = await call<PromptPreset>("PUT", `/v1/users/me/prompt-presets/${created.payload.id}`, {
    cookie: aliceCookie,
    body: { visibility: "shared", tags: ["finance"] }
  });
  assert.equal(update.status, 200);
  assert.equal(update.payload.title, "Draft", "title untouched when omitted");
  assert.equal(update.payload.visibility, "shared");
  assert.deepEqual(update.payload.tags, ["finance"]);
});

test("DELETE enforces ownership and returns 404 for unknown ids", async () => {
  const created = await call<PromptPreset>("POST", "/v1/users/me/prompt-presets", {
    cookie: aliceCookie,
    body: { title: "x", prompt_text: "y" }
  });
  const bobDel = await call("DELETE", `/v1/users/me/prompt-presets/${created.payload.id}`, { cookie: bobCookie });
  assert.equal(bobDel.status, 403);

  const aliceDel = await call("DELETE", `/v1/users/me/prompt-presets/${created.payload.id}`, { cookie: aliceCookie });
  assert.equal(aliceDel.status, 200);

  const again = await call("DELETE", `/v1/users/me/prompt-presets/${created.payload.id}`, { cookie: aliceCookie });
  assert.equal(again.status, 404);
});

test("malformed ids return 400 before touching the DB", async () => {
  const bad = await call("PUT", "/v1/users/me/prompt-presets/not-a-uuid", {
    cookie: aliceCookie,
    body: { title: "x" }
  });
  assert.equal(bad.status, 400);
});
