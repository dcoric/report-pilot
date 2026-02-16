const nodemailer = require("nodemailer");

const SMTP_HOST = process.env.SMTP_HOST || "localhost";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false") === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || "Report Pilot Reports <noreply@report-pilot.local>";

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
    });
  }
  return transporter;
}

/**
 * Send an email with an export file attached.
 *
 * @param {Object} opts
 * @param {string[]} opts.recipients
 * @param {string} opts.subject
 * @param {string} opts.textBody
 * @param {Buffer} opts.fileBuffer
 * @param {string} opts.fileName
 * @param {string} opts.contentType
 * @returns {Promise<{messageId: string}>}
 */
async function sendExportEmail({ recipients, subject, textBody, fileBuffer, fileName, contentType }) {
  const transport = getTransporter();

  const info = await transport.sendMail({
    from: SMTP_FROM,
    to: recipients.join(", "),
    subject,
    text: textBody,
    attachments: [
      {
        filename: fileName,
        content: fileBuffer,
        contentType
      }
    ]
  });

  return { messageId: info.messageId };
}

module.exports = { sendExportEmail };
