import nodemailer, { type Transporter } from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST || "localhost";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false") === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || "Report Pilot Reports <noreply@report-pilot.local>";

interface SendExportEmailOptions {
  recipients: string[];
  subject: string;
  textBody: string;
  fileBuffer: Buffer;
  fileName: string;
  contentType: string;
}

interface SendExportEmailResult {
  messageId: string;
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
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
 */
async function sendExportEmail({ recipients, subject, textBody, fileBuffer, fileName, contentType }: SendExportEmailOptions): Promise<SendExportEmailResult> {
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

// Use CommonJS `module.exports` so tests can monkey-patch
// `emailService.sendExportEmail`. Named `export` statements compile to
// immutable getters under tsx, breaking the patch (see lib/appDb.ts).
export = {
  sendExportEmail
};
