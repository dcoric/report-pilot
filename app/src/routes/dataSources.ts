import appDb = require("../lib/appDb");
import { json, badRequest, readJsonBody } from "../lib/http";
import { isSupportedDbType } from "../adapters/dbAdapterFactory";
import { runIntrospection, persistSnapshot, IntrospectionDataSource } from "../services/introspectionService";
import { parseSchemaFromDdl } from "../services/ddlImportService";
import ragService = require("../services/ragService");
import { enforceDataSourceAccess, listAccessibleDataSourceIds } from "../lib/authGate";
import type { ServerResponse } from "http";
import type { AuthedRequest } from "../lib/authGate";

async function runIntrospectionJob(jobId: string, dataSource: IntrospectionDataSource) {
  try {
    await appDb.query(
      `
        UPDATE introspection_jobs
        SET status = 'running', updated_at = NOW()
        WHERE id = $1
      `,
      [jobId]
    );

    await runIntrospection(dataSource);
    await ragService.reindexRagDocuments(dataSource.id);

    await appDb.query(
      `
        UPDATE introspection_jobs
        SET status = 'succeeded', updated_at = NOW()
        WHERE id = $1
      `,
      [jobId]
    );
  } catch (err) {
    await appDb.query(
      `
        UPDATE introspection_jobs
        SET status = 'failed', error_message = $2, updated_at = NOW()
        WHERE id = $1
      `,
      [jobId, (err as Error).message]
    );
    console.error(`[introspection] Job ${jobId} failed: ${(err as Error).message}`);
  }
}

async function handleCreateDataSource(req: AuthedRequest, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req) as any;
  const { name, db_type: dbType, connection_ref: connectionRef } = body;
  const normalizedDbType = String(dbType || "").trim().toLowerCase();

  if (!name || !dbType || !connectionRef) {
    return badRequest(res, "name, db_type and connection_ref are required");
  }

  if (!isSupportedDbType(normalizedDbType)) {
    return badRequest(res, "Unsupported db_type. Supported values: postgres, mssql");
  }

  const result = await appDb.query(
    `
      INSERT INTO data_sources (name, db_type, connection_ref, status)
      VALUES ($1, $2, $3, 'active')
      RETURNING id, name, db_type, status
    `,
    [name, normalizedDbType, connectionRef]
  );

  return json(res, 201, result.rows[0]);
}

async function handleListDataSources(req: AuthedRequest, res: ServerResponse): Promise<void> {
  const accessible = await listAccessibleDataSourceIds(req);
  let result;
  if (accessible === null) {
    result = await appDb.query(
      `
        SELECT id, name, db_type, connection_ref, status, created_at
        FROM data_sources
        ORDER BY created_at DESC
      `
    );
  } else if (accessible.length === 0) {
    return json(res, 200, { items: [] });
  } else {
    result = await appDb.query(
      `
        SELECT id, name, db_type, connection_ref, status, created_at
        FROM data_sources
        WHERE id = ANY($1::uuid[])
        ORDER BY created_at DESC
      `,
      [accessible]
    );
  }
  return json(res, 200, { items: result.rows });
}

async function handleDeleteDataSource(_req: AuthedRequest, res: ServerResponse, dataSourceId: string): Promise<void> {
  const result = await appDb.query(
    "DELETE FROM data_sources WHERE id = $1 RETURNING id",
    [dataSourceId]
  );

  if (result.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "Data source not found" });
  }

  return json(res, 200, { ok: true, id: dataSourceId });
}

async function handleIntrospect(req: AuthedRequest, res: ServerResponse, dataSourceId: string): Promise<void> {
  const result = await appDb.query(
    "SELECT id, db_type, connection_ref FROM data_sources WHERE id = $1",
    [dataSourceId]
  );
  const dataSource = result.rows[0] as IntrospectionDataSource;
  if (!dataSource) {
    return json(res, 404, { error: "not_found", message: "Data source not found" });
  }

  if (!(await enforceDataSourceAccess(req, res, dataSourceId))) {
    return undefined;
  }

  if (!isSupportedDbType(dataSource.db_type)) {
    return badRequest(res, `Unsupported db_type for introspection: ${dataSource.db_type}`);
  }

  const jobInsert = await appDb.query(
    `
      INSERT INTO introspection_jobs (data_source_id, status)
      VALUES ($1, 'queued')
      RETURNING id
    `,
    [dataSourceId]
  );
  const jobId = jobInsert.rows[0].id;

  setImmediate(() => {
    runIntrospectionJob(jobId, dataSource).catch((err: Error) => {
      console.error(`[introspection] Unexpected error for job ${jobId}: ${err.message}`);
    });
  });

  return json(res, 202, { job_id: jobId, status: "queued" });
}

async function handleImportSchema(req: AuthedRequest, res: ServerResponse, dataSourceId: string): Promise<void> {
  const result = await appDb.query(
    "SELECT id, db_type FROM data_sources WHERE id = $1",
    [dataSourceId]
  );
  const dataSource = result.rows[0];
  if (!dataSource) {
    return json(res, 404, { error: "not_found", message: "Data source not found" });
  }

  if (!(await enforceDataSourceAccess(req, res, dataSourceId))) {
    return undefined;
  }

  const body = await readJsonBody(req) as any;
  const ddl = String(body.ddl || "").trim();
  if (!ddl) {
    return badRequest(res, "ddl field is required and must be a non-empty string");
  }

  const snapshot = parseSchemaFromDdl(ddl);
  if (snapshot.objects.length === 0) {
    return badRequest(res, "No tables or views found in the provided DDL");
  }

  await persistSnapshot(dataSourceId, snapshot);
  ragService.reindexRagDocuments(dataSourceId).catch((err: Error) => {
    console.error(`[import-schema] RAG reindex failed for ${dataSourceId}: ${err.message}`);
  });

  return json(res, 200, { ok: true, object_count: snapshot.objects.length });
}

export {
  handleCreateDataSource,
  handleListDataSources,
  handleDeleteDataSource,
  handleIntrospect,
  handleImportSchema
};
