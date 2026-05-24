import appDb = require("../lib/appDb");
import {
  json,
  badRequest,
  internalError,
  readJsonBody,
  errorMessage,
  type RouteHandlerWithId
} from "../lib/http";
import {
  exportQueryResult,
  SUPPORTED_FORMATS,
  type ExportFormat
} from "../services/exportService";
import { createDelivery, getDeliveryStatus } from "../services/deliveryService";
import { enforceDataSourceAccess } from "../lib/authGate";
import type { ExportRequest, ExportDeliverRequest } from "../types";

async function loadSessionDataSourceId(sessionId: string): Promise<string | null> {
  const result = await appDb.query<{ data_source_id: string }>(
    "SELECT data_source_id FROM query_sessions WHERE id = $1",
    [sessionId]
  );
  return (result.rowCount ?? 0) > 0 ? result.rows[0].data_source_id : null;
}

interface HttpishError {
  statusCode?: number;
  message?: string;
}

function isStatusCodeError(err: unknown): err is HttpishError & { statusCode: number } {
  return Boolean(err && typeof err === "object" && typeof (err as HttpishError).statusCode === "number");
}

function isNotFoundExportError(message: string): boolean {
  return message === "Session not found"
    || message === "No successful query attempts found for this session";
}

const handleExportSession: RouteHandlerWithId<ExportRequest> = async (req, res, sessionId) => {
  // Body is optional — POST may carry `{ format }` or it can come from `?format=`.
  const body = await readJsonBody<Partial<ExportRequest>>(req).catch(() => ({} as Partial<ExportRequest>));
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  const format = (body.format || requestUrl.searchParams.get("format") || "json") as ExportFormat;

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
    const message = errorMessage(err);
    if (isNotFoundExportError(message)) {
      return json(res, 404, { error: "not_found", message });
    }
    console.error("[export] failed:", err);
    return internalError(res);
  }
};

const handleExportDeliver: RouteHandlerWithId<ExportDeliverRequest> = async (req, res, sessionId) => {
  const body = await readJsonBody<Partial<ExportDeliverRequest>>(req);
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
    const delivery = await createDelivery({
      sessionId,
      deliveryMode,
      format: format as ExportFormat,
      recipients,
      requestedBy
    });

    if (delivery.delivery_mode === "download") {
      res.writeHead(200, {
        "Content-Type": delivery.contentType,
        "Content-Disposition": `attachment; filename="${delivery.filename}"`,
        "Content-Length": delivery.buffer.length,
        "x-export-id": delivery.id
      });
      res.end(delivery.buffer);
      return;
    }

    // Email mode: return accepted with tracking ID
    return json(res, 202, {
      export_id: delivery.id,
      status: delivery.status,
      delivery_mode: delivery.delivery_mode
    });
  } catch (err) {
    if (isStatusCodeError(err) && err.statusCode === 400) {
      return badRequest(res, err.message);
    }
    const message = errorMessage(err);
    if (isNotFoundExportError(message)) {
      return json(res, 404, { error: "not_found", message });
    }
    console.error("[export/deliver] failed:", err);
    return internalError(res);
  }
};

const handleExportStatus: RouteHandlerWithId = async (req, res, exportId) => {
  const delivery = await getDeliveryStatus(exportId);
  if (!delivery) {
    return json(res, 404, { error: "not_found", message: "Export delivery not found" });
  }
  const sessionDsId = await loadSessionDataSourceId(delivery.session_id);
  if (sessionDsId && !(await enforceDataSourceAccess(req, res, sessionDsId))) {
    return undefined;
  }
  return json(res, 200, delivery);
};

export {
  handleExportSession,
  handleExportDeliver,
  handleExportStatus
};
