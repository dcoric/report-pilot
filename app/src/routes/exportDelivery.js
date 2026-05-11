const appDb = require("../lib/appDb");
const { json, badRequest, internalError, readJsonBody } = require("../lib/http");
const { exportQueryResult, SUPPORTED_FORMATS } = require("../services/exportService");
const { createDelivery, getDeliveryStatus } = require("../services/deliveryService");

async function handleExportSession(req, res, sessionId) {
  const body = await readJsonBody(req).catch(() => ({})); // Body optional
  const requestUrl = new URL(req.url, "http://localhost");
  const format = body.format || requestUrl.searchParams.get("format") || "json";

  if (!SUPPORTED_FORMATS.has(format)) {
    return badRequest(res, `Unsupported format: ${format}`);
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

async function handleExportDeliver(req, res, sessionId) {
  const body = await readJsonBody(req);
  const { delivery_mode: deliveryMode, format = "json", recipients } = body;

  if (!deliveryMode || !["download", "email"].includes(deliveryMode)) {
    return badRequest(res, "delivery_mode must be 'download' or 'email'");
  }

  const sessionResult = await appDb.query("SELECT id FROM query_sessions WHERE id = $1", [sessionId]);
  if (sessionResult.rowCount === 0) {
    return json(res, 404, { error: "not_found", message: "Session not found" });
  }

  const requestedBy = req.user && req.user.id ? req.user.id : "anonymous";

  try {
    const delivery = await createDelivery({ sessionId, deliveryMode, format, recipients, requestedBy });

    if (deliveryMode === "download") {
      res.writeHead(200, {
        "Content-Type": delivery.contentType,
        "Content-Disposition": `attachment; filename="${delivery.filename}"`,
        "Content-Length": delivery.buffer.length,
        "x-export-id": delivery.id
      });
      return res.end(delivery.buffer);
    }

    // Email mode: return accepted with tracking ID
    return json(res, 202, {
      export_id: delivery.id,
      status: delivery.status,
      delivery_mode: delivery.delivery_mode
    });
  } catch (err) {
    if (err.statusCode === 400) {
      return badRequest(res, err.message);
    }
    if (err.message === "Session not found" || err.message === "No successful query attempts found for this session") {
      return json(res, 404, { error: "not_found", message: err.message });
    }
    console.error("[export/deliver] failed:", err);
    return internalError(res);
  }
}

async function handleExportStatus(_req, res, exportId) {
  const delivery = await getDeliveryStatus(exportId);
  if (!delivery) {
    return json(res, 404, { error: "not_found", message: "Export delivery not found" });
  }
  return json(res, 200, delivery);
}

module.exports = {
  handleExportSession,
  handleExportDeliver,
  handleExportStatus
};
