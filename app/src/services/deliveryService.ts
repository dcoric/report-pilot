import appDb = require("../lib/appDb");
import { exportQueryResult, SUPPORTED_FORMATS } from "./exportService";
import emailService = require("./emailService");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type DeliveryMode = "download" | "email";
export type DeliveryFormat = "json" | "csv" | "xlsx" | "tsv" | "parquet";

export interface CreateDeliveryInput {
  sessionId: string;
  deliveryMode: DeliveryMode;
  format: DeliveryFormat;
  recipients?: string[];
  requestedBy: string;
}

export interface DownloadDeliveryResult {
  id: string;
  status: "completed";
  delivery_mode: "download";
  buffer: Buffer;
  contentType: string;
  filename: string;
}

export interface EmailDeliveryAck {
  id: string;
  status: "processing";
  delivery_mode: "email";
}

export type CreateDeliveryResult = DownloadDeliveryResult | EmailDeliveryAck;

export interface DeliveryRecord {
  id: string;
  session_id: string;
  delivery_mode: DeliveryMode;
  format: DeliveryFormat;
  recipients: string[] | null;
  status: string;
  error_message: string | null;
  file_name: string | null;
  file_size_bytes: number | null;
  requested_by: string;
  created_at: Date | string;
  completed_at: Date | string | null;
}

/**
 * Validate an array of email addresses.
 */
function validateRecipients(emails: string[]): { ok: boolean; invalid: string[] } {
  const invalid = emails.filter((e) => !EMAIL_REGEX.test(e));
  return { ok: invalid.length === 0, invalid };
}

/**
 * Create a delivery record and, for email mode, kick off async delivery.
 */
export async function createDelivery({ sessionId, deliveryMode, format, recipients, requestedBy }: CreateDeliveryInput): Promise<CreateDeliveryResult> {
  if (!SUPPORTED_FORMATS.has(format)) {
    throw Object.assign(new Error(`Unsupported format: ${format}`), { statusCode: 400 });
  }

  if (deliveryMode === "email") {
    if (!recipients || recipients.length === 0) {
      throw Object.assign(new Error("recipients are required for email delivery"), { statusCode: 400 });
    }
    const validation = validateRecipients(recipients);
    if (!validation.ok) {
      throw Object.assign(
        new Error(`Invalid recipient email(s): ${validation.invalid.join(", ")}`),
        { statusCode: 400 }
      );
    }
  }

  // Insert delivery record
  const insertResult = await appDb.query<{ id: string; status: string; created_at: Date | string }>(
    `
      INSERT INTO export_deliveries (session_id, delivery_mode, format, recipients, status, requested_by)
      VALUES ($1, $2, $3, $4, 'pending', $5)
      RETURNING id, status, created_at
    `,
    [sessionId, deliveryMode, format, recipients || null, requestedBy]
  );

  const delivery = insertResult.rows[0];

  if (deliveryMode === "download") {
    // Synchronous: generate export and return file
    try {
      const { buffer, contentType, filename } = await exportQueryResult(sessionId, format);

      await appDb.query(
        `
          UPDATE export_deliveries
          SET status = 'completed', file_name = $2, file_size_bytes = $3, completed_at = NOW()
          WHERE id = $1
        `,
        [delivery.id, filename, buffer.length]
      );

      return {
        id: delivery.id,
        status: "completed",
        delivery_mode: "download",
        buffer,
        contentType,
        filename
      };
    } catch (err) {
      await appDb.query(
        `
          UPDATE export_deliveries
          SET status = 'failed', error_message = $2, completed_at = NOW()
          WHERE id = $1
        `,
        [delivery.id, (err as Error).message]
      );
      throw err;
    }
  }

  // Email mode: run async
  processEmailDelivery(delivery.id, sessionId, format, recipients!).catch((err: Error) => {
    console.error(`[delivery] Email delivery ${delivery.id} failed: ${err.message}`);
  });

  return {
    id: delivery.id,
    status: "processing",
    delivery_mode: "email"
  };
}

/**
 * Process email delivery asynchronously.
 */
async function processEmailDelivery(deliveryId: string, sessionId: string, format: DeliveryFormat, recipients: string[]): Promise<void> {
  await appDb.query(
    "UPDATE export_deliveries SET status = 'processing' WHERE id = $1",
    [deliveryId]
  );

  try {
    const { buffer, contentType, filename } = await exportQueryResult(sessionId, format);

    // Fetch session question for email subject
    const sessionResult = await appDb.query<{ question: string | null }>(
      "SELECT question FROM query_sessions WHERE id = $1",
      [sessionId]
    );
    const question = sessionResult.rows[0]?.question || "Query Export";

    await emailService.sendExportEmail({
      recipients,
      subject: `Report Pilot Export: ${question.substring(0, 80)}`,
      textBody: `Your requested export for the query "${question}" is attached.\n\nFormat: ${format.toUpperCase()}\nFile: ${filename}`,
      fileBuffer: buffer,
      fileName: filename,
      contentType
    });

    await appDb.query(
      `
        UPDATE export_deliveries
        SET status = 'completed', file_name = $2, file_size_bytes = $3, completed_at = NOW()
        WHERE id = $1
      `,
      [deliveryId, filename, buffer.length]
    );
  } catch (err) {
    await appDb.query(
      `
        UPDATE export_deliveries
        SET status = 'failed', error_message = $2, completed_at = NOW()
        WHERE id = $1
      `,
      [deliveryId, (err as Error).message]
    );
    throw err;
  }
}

/**
 * Fetch a delivery record by ID.
 */
export async function getDeliveryStatus(exportId: string): Promise<DeliveryRecord | null> {
  const result = await appDb.query<DeliveryRecord>(
    `
      SELECT id, session_id, delivery_mode, format, recipients, status, error_message,
             file_name, file_size_bytes, requested_by, created_at, completed_at
      FROM export_deliveries
      WHERE id = $1
    `,
    [exportId]
  );

  return result.rows[0] || null;
}
