import * as crypto from "crypto";
import * as http from "http";
import * as zlib from "zlib";
import { URL } from "url";

interface MockSamlUser {
  sub: string;
  email: string;
  displayName: string;
}

export interface CreateMockSamlIdpOptions {
  user?: Partial<MockSamlUser>;
}

export interface MockSamlIdp {
  start(): Promise<string>;
  stop(): Promise<void>;
  readonly ssoUrl: string | null;
  readonly entityId: string | null;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function samlTimestamp(offsetSeconds: number): string {
  return new Date(Date.now() + offsetSeconds * 1000).toISOString();
}

function extractXmlAttribute(xml: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]+)"`).exec(xml);
  return match?.[1] ?? null;
}

function extractXmlElement(xml: string, name: string): string | null {
  const match = new RegExp(`<[^>]*:?${name}\\b[^>]*>([\\s\\S]*?)</[^>]*:?${name}>`).exec(xml);
  return match?.[1]?.trim() ?? null;
}

function decodeAuthnRequest(value: string): string {
  const compressed = Buffer.from(value, "base64");
  return zlib.inflateRawSync(compressed).toString("utf8");
}

function encodeSamlResponse(xml: string): string {
  return Buffer.from(xml, "utf8").toString("base64");
}

function buildSamlResponse(params: {
  readonly idpEntityId: string;
  readonly spEntityId: string;
  readonly acsUrl: string;
  readonly inResponseTo: string;
  readonly user: MockSamlUser;
}): string {
  const responseId = `_${crypto.randomBytes(12).toString("hex")}`;
  const assertionId = `_${crypto.randomBytes(12).toString("hex")}`;
  const now = samlTimestamp(0);
  return encodeSamlResponse(`<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${responseId}" Version="2.0" IssueInstant="${now}" Destination="${escapeXml(params.acsUrl)}" InResponseTo="${escapeXml(params.inResponseTo)}">
  <saml:Issuer>${escapeXml(params.idpEntityId)}</saml:Issuer>
  <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success" /></samlp:Status>
  <saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${now}">
    <saml:Issuer>${escapeXml(params.idpEntityId)}</saml:Issuer>
    <saml:Subject>
      <saml:NameID>${escapeXml(params.user.sub)}</saml:NameID>
      <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml:SubjectConfirmationData InResponseTo="${escapeXml(params.inResponseTo)}" Recipient="${escapeXml(params.acsUrl)}" NotOnOrAfter="${samlTimestamp(300)}" />
      </saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions NotBefore="${samlTimestamp(-60)}" NotOnOrAfter="${samlTimestamp(300)}">
      <saml:AudienceRestriction><saml:Audience>${escapeXml(params.spEntityId)}</saml:Audience></saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AttributeStatement>
      <saml:Attribute Name="email"><saml:AttributeValue>${escapeXml(params.user.email)}</saml:AttributeValue></saml:Attribute>
      <saml:Attribute Name="displayName"><saml:AttributeValue>${escapeXml(params.user.displayName)}</saml:AttributeValue></saml:Attribute>
    </saml:AttributeStatement>
  </saml:Assertion>
</samlp:Response>`);
}

export function createMockSamlIdp({
  user: initialUser = { sub: "saml-user-1", email: "Alice@Example.COM", displayName: "Alice SAML" }
}: CreateMockSamlIdpOptions = {}): MockSamlIdp {
  const user: MockSamlUser = {
    sub: initialUser.sub ?? "saml-user-1",
    email: initialUser.email ?? "Alice@Example.COM",
    displayName: initialUser.displayName ?? "Alice SAML"
  };
  let ssoUrl: string | null = null;
  let entityId: string | null = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const baseUrl = `http://${req.headers.host}`;
    if (req.method === "GET" && url.pathname === "/metadata") {
      res.writeHead(200, { "Content-Type": "application/samlmetadata+xml" });
      res.end(`<EntityDescriptor entityID="${baseUrl}/idp"><IDPSSODescriptor><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${baseUrl}/sso" /></IDPSSODescriptor></EntityDescriptor>`);
      return;
    }
    if (req.method === "GET" && url.pathname === "/sso") {
      const samlRequest = url.searchParams.get("SAMLRequest");
      if (!samlRequest) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("SAML SSO endpoint");
        return;
      }
      const requestXml = decodeAuthnRequest(samlRequest);
      const acsUrl = extractXmlAttribute(requestXml, "AssertionConsumerServiceURL");
      const requestId = extractXmlAttribute(requestXml, "ID");
      const spEntityId = extractXmlElement(requestXml, "Issuer") ?? "report-pilot";
      if (!acsUrl || !requestId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_saml_request" }));
        return;
      }
      const callback = new URL(acsUrl);
      callback.searchParams.set("SAMLResponse", buildSamlResponse({ idpEntityId: `${baseUrl}/idp`, spEntityId, acsUrl, inResponseTo: requestId, user }));
      const relayState = url.searchParams.get("RelayState");
      if (relayState) callback.searchParams.set("RelayState", relayState);
      res.writeHead(302, { Location: callback.href });
      res.end();
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found", path: url.pathname }));
  });

  return {
    start: async () => new Promise<string>((resolve, reject) => {
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("mock SAML IdP failed to bind"));
          return;
        }
        ssoUrl = `http://127.0.0.1:${address.port}/sso`;
        entityId = `http://127.0.0.1:${address.port}/idp`;
        resolve(ssoUrl);
      });
    }),
    stop: async () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
    get ssoUrl() { return ssoUrl; },
    get entityId() { return entityId; }
  };
}
