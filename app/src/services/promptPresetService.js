// AUTH-007: prompt preset CRUD + visibility-aware listing.
//
// Ownership is enforced by callers passing the authenticated user's id;
// the service refuses any update / delete that doesn't match the owner.
// Listing returns the union of:
//   - the caller's own presets (regardless of visibility)
//   - other users' presets with visibility = 'shared'
//
// `data_source_id` is optional; when set we keep it referentially intact
// via the FK (ON DELETE SET NULL in the migration). The frontend can filter
// the list to "presets that apply to my current data source" on its own.

const appDb = require("../lib/appDb");

const TITLE_MAX = 200;
const PROMPT_MAX = 8 * 1024;
const TAGS_MAX = 16;
const TAG_MAX_LEN = 64;
const ALLOWED_VISIBILITY = new Set(["private", "shared"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rowToPreset(row) {
  if (!row) return null;
  return {
    id: row.id,
    owner_user_id: row.owner_user_id,
    title: row.title,
    prompt_text: row.prompt_text,
    data_source_id: row.data_source_id,
    tags: row.tags || [],
    visibility: row.visibility,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function normalizeTags(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  if (value.length > TAGS_MAX) return null;
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed.length > TAG_MAX_LEN) return null;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(trimmed);
  }
  return out;
}

// Returns `{ ok: true, value }` or `{ ok: false, code, message }`.
function validatePreset(body, { partial = false } = {}) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, code: "invalid_body", message: "preset body must be a JSON object" };
  }
  const value = {};

  const requireField = (key, validator, code, message) => {
    const has = Object.prototype.hasOwnProperty.call(body, key);
    if (!has) {
      if (partial) return null;
      return { ok: false, code, message };
    }
    const validated = validator(body[key]);
    if (validated.ok) {
      value[key] = validated.value;
      return null;
    }
    return { ok: false, code, message: validated.message || message };
  };

  const titleErr = requireField(
    "title",
    (raw) => {
      if (typeof raw !== "string") return { ok: false, message: "title must be a string" };
      const trimmed = raw.trim();
      if (!trimmed) return { ok: false, message: "title is required" };
      if (trimmed.length > TITLE_MAX) return { ok: false, message: `title must be at most ${TITLE_MAX} characters` };
      return { ok: true, value: trimmed };
    },
    "invalid_title",
    "title is required"
  );
  if (titleErr) return titleErr;

  const promptErr = requireField(
    "prompt_text",
    (raw) => {
      if (typeof raw !== "string") return { ok: false, message: "prompt_text must be a string" };
      const trimmed = raw.trim();
      if (!trimmed) return { ok: false, message: "prompt_text is required" };
      if (trimmed.length > PROMPT_MAX) return { ok: false, message: `prompt_text must be at most ${PROMPT_MAX} characters` };
      return { ok: true, value: trimmed };
    },
    "invalid_prompt_text",
    "prompt_text is required"
  );
  if (promptErr) return promptErr;

  // Optional fields. When omitted on create we apply sensible defaults;
  // when omitted on partial update we leave the existing column alone.
  if (Object.prototype.hasOwnProperty.call(body, "data_source_id")) {
    const raw = body.data_source_id;
    if (raw === null || raw === "") {
      value.data_source_id = null;
    } else if (typeof raw === "string" && UUID_RE.test(raw)) {
      value.data_source_id = raw;
    } else {
      return { ok: false, code: "invalid_data_source_id", message: "data_source_id must be a UUID or null" };
    }
  } else if (!partial) {
    value.data_source_id = null;
  }

  if (Object.prototype.hasOwnProperty.call(body, "tags")) {
    const tags = normalizeTags(body.tags);
    if (tags === null) {
      return { ok: false, code: "invalid_tags", message: `tags must be an array of up to ${TAGS_MAX} strings (each up to ${TAG_MAX_LEN} chars)` };
    }
    value.tags = tags;
  } else if (!partial) {
    value.tags = [];
  }

  if (Object.prototype.hasOwnProperty.call(body, "visibility")) {
    const raw = body.visibility;
    if (typeof raw !== "string" || !ALLOWED_VISIBILITY.has(raw)) {
      return { ok: false, code: "invalid_visibility", message: `visibility must be one of: ${[...ALLOWED_VISIBILITY].join(", ")}` };
    }
    value.visibility = raw;
  } else if (!partial) {
    value.visibility = "private";
  }

  return { ok: true, value };
}

async function listForUser({ userId, includeShared = true } = {}) {
  if (!userId) return [];
  const sql = includeShared
    ? `SELECT id, owner_user_id, title, prompt_text, data_source_id, tags,
              visibility, created_at, updated_at
         FROM prompt_presets
         WHERE owner_user_id = $1 OR visibility = 'shared'
         ORDER BY created_at DESC`
    : `SELECT id, owner_user_id, title, prompt_text, data_source_id, tags,
              visibility, created_at, updated_at
         FROM prompt_presets
         WHERE owner_user_id = $1
         ORDER BY created_at DESC`;
  const result = await appDb.query(sql, [userId]);
  return result.rows.map(rowToPreset);
}

async function findById(id) {
  if (typeof id !== "string" || !id) return null;
  const result = await appDb.query(
    `SELECT id, owner_user_id, title, prompt_text, data_source_id, tags,
            visibility, created_at, updated_at
       FROM prompt_presets WHERE id = $1`,
    [id]
  );
  return rowToPreset(result.rows[0] || null);
}

async function createPreset({ ownerUserId, body }) {
  if (!ownerUserId) {
    return { statusCode: 401, body: { error: "unauthenticated" } };
  }
  const parsed = validatePreset(body);
  if (!parsed.ok) {
    return { statusCode: 400, body: { error: "bad_request", code: parsed.code, message: parsed.message } };
  }
  const v = parsed.value;
  // Guard against orphan FKs returning a 500 — surface a clean 400 instead.
  if (v.data_source_id) {
    const exists = await appDb.query("SELECT id FROM data_sources WHERE id = $1", [v.data_source_id]);
    if (exists.rowCount === 0) {
      return {
        statusCode: 400,
        body: { error: "bad_request", code: "unknown_data_source", message: "data_source_id does not match any existing data source" }
      };
    }
  }
  const result = await appDb.query(
    `INSERT INTO prompt_presets (owner_user_id, title, prompt_text, data_source_id, tags, visibility)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, owner_user_id, title, prompt_text, data_source_id, tags,
               visibility, created_at, updated_at`,
    [ownerUserId, v.title, v.prompt_text, v.data_source_id, v.tags, v.visibility]
  );
  return { statusCode: 201, body: rowToPreset(result.rows[0]) };
}

async function updatePreset({ ownerUserId, id, body }) {
  if (!ownerUserId) return { statusCode: 401, body: { error: "unauthenticated" } };
  const existing = await findById(id);
  if (!existing) return { statusCode: 404, body: { error: "not_found", message: "preset not found" } };
  if (existing.owner_user_id !== ownerUserId) {
    return { statusCode: 403, body: { error: "forbidden", message: "only the owner can edit this preset" } };
  }
  // Partial update: keep existing values for fields the caller doesn't send.
  const parsed = validatePreset(body, { partial: true });
  if (!parsed.ok) {
    return { statusCode: 400, body: { error: "bad_request", code: parsed.code, message: parsed.message } };
  }
  const merged = { ...existing, ...parsed.value };
  if (merged.data_source_id) {
    const exists = await appDb.query("SELECT id FROM data_sources WHERE id = $1", [merged.data_source_id]);
    if (exists.rowCount === 0) {
      return {
        statusCode: 400,
        body: { error: "bad_request", code: "unknown_data_source", message: "data_source_id does not match any existing data source" }
      };
    }
  }
  const result = await appDb.query(
    `UPDATE prompt_presets
        SET title = $2,
            prompt_text = $3,
            data_source_id = $4,
            tags = $5,
            visibility = $6,
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, owner_user_id, title, prompt_text, data_source_id, tags,
                visibility, created_at, updated_at`,
    [id, merged.title, merged.prompt_text, merged.data_source_id, merged.tags, merged.visibility]
  );
  return { statusCode: 200, body: rowToPreset(result.rows[0]) };
}

async function deletePreset({ ownerUserId, id }) {
  if (!ownerUserId) return { statusCode: 401, body: { error: "unauthenticated" } };
  const existing = await findById(id);
  if (!existing) return { statusCode: 404, body: { error: "not_found", message: "preset not found" } };
  if (existing.owner_user_id !== ownerUserId) {
    return { statusCode: 403, body: { error: "forbidden", message: "only the owner can delete this preset" } };
  }
  await appDb.query("DELETE FROM prompt_presets WHERE id = $1", [id]);
  return { statusCode: 200, body: { ok: true, id } };
}

module.exports = {
  TITLE_MAX,
  PROMPT_MAX,
  TAGS_MAX,
  TAG_MAX_LEN,
  ALLOWED_VISIBILITY,
  validatePreset,
  listForUser,
  findById,
  createPreset,
  updatePreset,
  deletePreset
};
