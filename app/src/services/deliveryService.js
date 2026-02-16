const appDb = require("../lib/appDb");
const { exportQueryResult, SUPPORTED_FORMATS } = require("./exportService");
const { sendExportEmail } = require("./emailService");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate an array of email addresses.
 * @param {string[]} emails
 * @returns {{ok: boolean, invalid: string[]}}
 */
function validateRecipients(emails) {
  const invalid = emails.filter((e) => !EMAIL_REGEX.test(e));
  return { ok: invalid.length === 0, invalid };
}

/**
 * Create a delivery record and, for email mode, kick off async delivery.
 *
 * @param {Object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.deliveryMode  'download' | 'email'
 * @param {string} opts.format        'json' | 'csv' | 'xlsx' | 'tsv' | 'parquet'
 * @param {string[]} [opts.recipients]
 * @param {string} opts.requestedBy
 * @returns {Promise<Object>} delivery record (for download mode includes buffer)
 */
async function createDelivery({ sessionId, deliveryMode, format, recipients, requestedBy }) {
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
  const insertResult = await appDb.query(
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
        [delivery.id, err.message]
      );
      throw err;
    }
  }

  // Email mode: run async
  processEmailDelivery(delivery.id, sessionId, format, recipients).catch((err) => {
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
async function processEmailDelivery(deliveryId, sessionId, format, recipients) {
  await appDb.query(
    "UPDATE export_deliveries SET status = 'processing' WHERE id = $1",
    [deliveryId]
  );

  try {
    const { buffer, contentType, filename } = await exportQueryResult(sessionId, format);

    // Fetch session question for email subject
    const sessionResult = await appDb.query(
      "SELECT question FROM query_sessions WHERE id = $1",
      [sessionId]
    );
    const question = sessionResult.rows[0]?.question || "Query Export";

    await sendExportEmail({
      recipients,
      subject: `AI-DB Export: ${question.substring(0, 80)}`,
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
      [deliveryId, err.message]
    );
    throw err;
  }
}

/**
 * Fetch a delivery record by ID.
 * @param {string} exportId
 * @returns {Promise<Object|null>}
 */
async function getDeliveryStatus(exportId) {
  const result = await appDb.query(
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

module.exports = { createDelivery, getDeliveryStatus };
