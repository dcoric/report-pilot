import "./helpers/setupEnv";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import appDb = require("../src/lib/appDb");
import { retrieveRagContext } from "../src/services/ragRetrieval";

let originalQuery: typeof appDb.query;
let capturedSql = "";
let capturedParams: unknown[] = [];

before(() => {
  originalQuery = appDb.query;
  appDb.query = (async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized.includes("group by re.embedding_model")) {
      return { rowCount: 1, rows: [{ embedding_model: "local-hash-v1", doc_count: 2 }] };
    }
    capturedSql = normalized;
    capturedParams = params;
    return {
      rowCount: 2,
      rows: [
        {
          id: "doc-revenue",
          doc_type: "schema",
          ref_id: "table-revenue",
          content: "schema object public.payment revenue amount",
          metadata_json: {},
          vector_json: null
        },
        {
          id: "doc-recent",
          doc_type: "schema",
          ref_id: "table-recent",
          content: "schema object public.inventory",
          metadata_json: {},
          vector_json: null
        }
      ]
    };
  }) as typeof appDb.query;
});

after(() => {
  appDb.query = originalQuery;
});

test("retrieval uses the current version and indexed bounded candidates", async () => {
  const docs = await retrieveRagContext("source-1", "total revenue", {
    limit: 2,
    docTypes: ["schema"],
    candidateLimit: 25,
    fallbackLimit: 5
  });

  assert.equal(docs[0].id, "doc-revenue");
  assert.match(capturedSql, /websearch_to_tsquery\('simple', \$3\)/);
  assert.match(capturedSql, /rd\.search_vector @@ qt\.query/);
  assert.match(capturedSql, /ci\.schema_version = rd\.schema_version/);
  assert.doesNotMatch(capturedSql, /limit 400/);
  assert.deepEqual(capturedParams, ["source-1", "local-hash-v1", "total revenue", ["schema"], 25, 5, 30]);
});
