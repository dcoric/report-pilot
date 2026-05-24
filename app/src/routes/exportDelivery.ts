import appDb = require("../lib/appDb");
import type { ServerResponse } from "http";
import { json, badRequest, internalError, readJsonBody } from "../lib/http";
import { exportQueryResult, SUPPORTED_FORMATS } from "../services/exportService";
import { createDelivery, getDeliveryStatus } from "../services/deliveryService";
import { enforceDataSourceAccess, type AuthedRequest } from "../lib/authGate";

async function loadSessionDataSourceId(sessionId: string): Promise<string | null> {
  const result = await appDb.query(
    "SELECT data_source_id FROM query_sessions WHERE id = $1",
    [sessionId]
  );
  return result.rowCount > 0 ? result.rows[0].data_source_id : null;
}

async function handleExportSession(req: AuthedRequest, res: ServerResponse, sessionId: string): Promise<void> {
  const body = await readJsonBody(req).catch(() => ({})) as any; // Body optional
  const requestUrl = new URL(req.url, "http://localhost");
  const format = body.format || requestUrl.searchParams.get("format") || "json";

  if (!SUPPORTED_FORMATS.has(format)) {
    return badRequest(res, `Unsupported format: ${format}`);
  }

  const sessionDsId = await loadSessionDataSourceId(sessionId);
  if (!sessionDsId) {
    return json(res, 404, { error: "not_found", message: "Session not found" });
  }
  if (!(await enforceDataSourceAccess(req, res, sessionDsId))) {
    return undefined;
  }

  try {
    const { buffer, contentType, filename } = await exportQueryResult(sessionId, format);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": buffer.length
    });
    res.end(buffer);
  } catch (err) {
    if (err.message === "Session not found" || err.message === "No successful query attempts found for this session") {
      return json(res, 404, { error: "not_found", message: err.message });
    }
    console.error("[export] failed:", err);
    return internalError(res);
  }
}

async function handleExportDeliver(req: AuthedRequest, res: ServerResponse, sessionId: string): Promise<void> {
  const body = await readJsonBody(req) as any;
  const { delivery_mode: deliveryMode, format = "json", recipients } = body;

  if (!deliveryMode || !["download", "email"].includes(deliveryMode)) {
    return badRequest(res, "delivery_mode must be 'download' or 'email'");
  }

  const sessionDsId = await loadSessionDataSourceId(sessionId);
  if (!sessionDsId) {
    return json(res, 404, { error: "not_found", message: "Session not found" });
  }
  if (!(await enforceDataSourceAccess(req, res, sessionDsId))) {
    return undefined;
  }

  const requestedBy = req.user && req.user.id ? req.user.id : "anonymous";

  try {
    const delivery = await createDelivery({ sessionId, deliveryMode, format, recipients, requestedBy });

    if (deliveryMode === "download") {
      const dl = delivery as any;
      res.writeHead(200, {
        "Content-Type": dl.contentType,
        "Content-Disposition": `attachment; filename="${dl.filename}"`,
        "Content-Length": dl.buffer.length,
        "x-export-id": dl.id
      });
      res.end(dl.buffer);
      return;
    }

    // Email mode: return accepted with tracking ID
    return json(res, 202, {
      export_id: delivery.id,
      status: delivery.status,
      delivery_mode: delivery.delivery_mode
    });
  } catch (err) {
    const e = err as any;
    if (e.statusCode === 400) {
      return badRequest(res, e.message);
    }
    if (e.message === "Session not found" || e.message === "No successful query attempts found for this session") {
      return json(res, 404, { error: "not_found", message: e.message });
    }
    console.error("[export/deliver] failed:", err);
    return internalError(res);
  }
}

async function handleExportStatus(req: AuthedRequest, res: ServerResponse, exportId: string): Promise<void> {
  const delivery = await getDeliveryStatus(exportId);
  if (!delivery) {
    return json(res, 404, { error: "not_found", message: "Export delivery not found" });
  }
  const sessionDsId = await loadSessionDataSourceId(delivery.session_id);
  if (sessionDsId && !(await enforceDataSourceAccess(req, res, sessionDsId))) {
    return undefined;
  }
  return json(res, 200, delivery);
}

export {
  handleExportSession,
  handleExportDeliver,
  handleExportStatus
};
