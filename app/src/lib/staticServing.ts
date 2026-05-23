import * as fs from "fs";
import * as path from "path";
import type { IncomingMessage, ServerResponse } from "http";
import appDb = require("./appDb");
import {
  OPENAPI_SPEC_PATH,
  FRONTEND_DIST_PATH,
  FRONTEND_INDEX_PATH,
  STATIC_CONTENT_TYPES
} from "./constants";

let cachedOpenApiSpec: string | null = null;
let cachedFrontendIndex: Buffer | null = null;

function loadOpenApiSpec(): string {
  if (cachedOpenApiSpec === null) {
    cachedOpenApiSpec = fs.readFileSync(OPENAPI_SPEC_PATH, "utf8");
  }
  return cachedOpenApiSpec;
}

function swaggerUiHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Report Pilot API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      SwaggerUIBundle({
        url: "/openapi.yaml",
        dom_id: "#swagger-ui"
      });
    </script>
  </body>
</html>`;
}

export function serveSwaggerDocs(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(swaggerUiHtml());
}

export function serveOpenApiSpec(res: ServerResponse): void {
  const spec = loadOpenApiSpec();
  res.writeHead(200, { "Content-Type": "application/yaml; charset=utf-8" });
  res.end(spec);
}

function frontendIsAvailable(): boolean {
  return fs.existsSync(FRONTEND_INDEX_PATH);
}

function getStaticContentType(filePath: string): string {
  const extname = path.extname(filePath).toLowerCase();
  return STATIC_CONTENT_TYPES[extname] || "application/octet-stream";
}

function isPathWithin(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function serveFrontendIndex(res: ServerResponse): boolean {
  if (!frontendIsAvailable()) {
    return false;
  }

  if (cachedFrontendIndex === null) {
    cachedFrontendIndex = fs.readFileSync(FRONTEND_INDEX_PATH);
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(cachedFrontendIndex);
  return true;
}

export function serveFrontendAsset(res: ServerResponse, pathname: string): boolean {
  if (!frontendIsAvailable()) {
    return false;
  }

  const relativeAssetPath = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (!relativeAssetPath) {
    return false;
  }

  const assetPath = path.resolve(FRONTEND_DIST_PATH, relativeAssetPath);
  if (!isPathWithin(FRONTEND_DIST_PATH, assetPath)) {
    return false;
  }

  if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
    return false;
  }

  const asset = fs.readFileSync(assetPath);
  res.writeHead(200, { "Content-Type": getStaticContentType(assetPath) });
  res.end(asset);
  return true;
}

export function shouldServeFrontendApp(req: IncomingMessage, pathname: string): boolean {
  if (req.method !== "GET" || !frontendIsAvailable()) {
    return false;
  }

  if (
    pathname === "/health" ||
    pathname === "/ready" ||
    pathname === "/docs" ||
    pathname === "/docs/" ||
    pathname === "/openapi.yaml" ||
    pathname.startsWith("/v1/")
  ) {
    return false;
  }

  if (path.extname(pathname)) {
    return false;
  }

  const accept = String(req.headers.accept || "");
  return accept.includes("text/html");
}

export interface DatabaseCheckResult {
  ok: boolean;
  error?: string;
}

export async function checkDatabase(): Promise<DatabaseCheckResult> {
  try {
    await appDb.query("SELECT 1");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
