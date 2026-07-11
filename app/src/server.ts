import * as http from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { createRequestId, logEvent } from "./lib/observability";
import { json, notFound, badRequest, internalError, errorMessage } from "./lib/http";
import { PORT } from "./lib/constants";
import {
  serveSwaggerDocs,
  serveOpenApiSpec,
  serveFrontendIndex,
  serveFrontendAsset,
  shouldServeFrontendApp,
  checkDatabase
} from "./lib/staticServing";

// Route modules
import {
  handleCreateDataSource,
  handleListDataSources,
  handleDeleteDataSource,
  handleIntrospect,
  handleImportSchema
} from "./routes/dataSources";
import {
  handleExportDataSource,
  handleImportDataSource
} from "./routes/dataSourceExportImport";
import {
  handleListSchemaObjects,
  handlePatchSchemaObject
} from "./routes/schema";
import {
  handleUpsertSemanticEntity,
  handleUpsertMetricDefinition,
  handleUpsertJoinPolicy
} from "./routes/semantic";
import {
  handleListRagNotes,
  handleUpsertRagNote,
  handleDeleteRagNote,
  handleRagReindex
} from "./routes/rag";
import {
  handleCreateSession,
  handlePromptHistory,
  handleRunSession,
  handleCancelClarification,
  handleFeedback
} from "./routes/query";
import {
  handleCreateSavedQuery,
  handleListSavedQueries,
  handleGetSavedQuery,
  handleUpdateSavedQuery,
  handleDeleteSavedQuery,
  handleValidateParams,
  handleRunSavedQuery,
  handleShareSavedQuery,
  handleGetSavedQueryAccess,
  handleListSavedQueryVersions,
  handleRestoreSavedQueryVersion
} from "./routes/savedQueries";
import {
  handleCreateSavedQueryFolder,
  handleListSavedQueryFolders,
  handleUpdateSavedQueryFolder,
  handleDeleteSavedQueryFolder,
  handleMoveSavedQuery
} from "./routes/savedQueryFolders";
import {
  handleCreateSchedule,
  handleListSchedules,
  handleUpdateSchedule,
  handleDeleteSchedule,
  handleRetrySchedule
} from "./routes/savedQuerySchedules";
import {
  handleExportSession,
  handleExportDeliver,
  handleExportStatus
} from "./routes/exportDelivery";
import {
  handleProviderList,
  handleProviderUpsert,
  handleRoutingRuleUpsert,
  handleProviderHealth
} from "./routes/providers";
import {
  handleObservabilityMetrics,
  handleReleaseGates,
  handleBenchmarkCommand,
  handleCreateBenchmarkReport
} from "./routes/observability";
import {
  handleLogin,
  handleLogout,
  handleMe
} from "./routes/auth";
import {
  handleListUsers,
  handleCreateUser,
  handleUpdateUserRoles,
  handleListDataSourceAccess,
  handleGrantDataSourceAccess,
  handleRevokeDataSourceAccess,
  handleListAuthProviders,
  handleUpsertAuthProvider,
  handleDeleteAuthProvider,
  handleTestAuthProvider,
  handleUpsertAuthProviderMappingRules,
  handleListUserLinkedIdentities,
  handleDeleteUserLinkedIdentity,
  handleUpsertScimGroupMappings,
  handleListScimTokens,
  handleIssueScimToken,
  handleRevokeScimToken,
  handleListAuditEvents
} from "./routes/admin";
import {
  handleListEnabledProviders,
  handleStartLogin,
  handleCallback
} from "./routes/oidc";
import {
  handleGetConfig as handleGetUserConfig,
  handlePutConfig as handlePutUserConfig
} from "./routes/userConfig";
import {
  handleList as handleListPromptPresets,
  handleCreate as handleCreatePromptPreset,
  handleUpdate as handleUpdatePromptPreset,
  handleDelete as handleDeletePromptPreset
} from "./routes/promptPresets";
import {
  handleServiceProviderConfig,
  handleResourceTypes,
  handleSchemas,
  handleListUsers as handleScimListUsers,
  handleCreateUser as handleScimCreateUser,
  handleGetUser as handleScimGetUser,
  handleReplaceUser as handleScimReplaceUser,
  handlePatchUser as handleScimPatchUser,
  handleDeleteUser as handleScimDeleteUser,
  handleListGroups as handleScimListGroups,
  handleCreateOrReplaceGroup as handleScimCreateGroup,
  handlePatchGroup as handleScimPatchGroup
} from "./routes/scim";
import { findPolicy } from "./lib/routePolicy";
import { enforcePolicy, type AuthedRequest } from "./lib/authGate";

interface HttpishError {
  statusCode?: number;
  message?: string;
  stack?: string;
}

function statusCodeFromError(err: unknown): number | null {
  if (err && typeof err === "object" && typeof (err as HttpishError).statusCode === "number") {
    return (err as HttpishError).statusCode!;
  }
  return null;
}

async function routeRequest(req: AuthedRequest, res: ServerResponse): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  const { pathname } = requestUrl;

  // AUTH-013: SCIM routes carry their own bearer-token auth gate and do
  // NOT participate in the session-cookie policy table. Skip the /v1
  // enforcement entirely and dispatch directly below.
  const isScimPath = pathname.startsWith("/scim/v2/");

  // Centralized authorization for any /v1/* route. Static / docs / health
  // paths are matched by explicit public policies below; anything else outside
  // /v1 is handled by the static-asset and frontend-fallback branches.
  if (!isScimPath) {
    if (pathname.startsWith("/v1/")) {
      const policy = findPolicy(req.method ?? "", pathname);
      if (!policy) {
        return notFound(res);
      }
      const decision = await enforcePolicy(req, res, policy);
      if (!decision.allowed) {
        return;
      }
    } else {
      // Public surfaces — apply the policy table where one exists (records an
      // audit event for transparency) and otherwise fall through to the static
      // routing below.
      const policy = findPolicy(req.method ?? "", pathname);
      if (policy && policy.public) {
        await enforcePolicy(req, res, policy);
      }
    }
  }

  if (req.method === "GET" && pathname === "/health") {
    return json(res, 200, { status: "ok" });
  }

  if (req.method === "GET" && pathname === "/ready") {
    const db = await checkDatabase();
    if (db.ok) {
      return json(res, 200, { status: "ready" });
    }
    return json(res, 503, { status: "not_ready", reason: db.error });
  }

  if (req.method === "GET" && pathname === "/") {
    if (serveFrontendIndex(res)) {
      return;
    }

    return json(res, 200, {
      service: "report-pilot",
      status: "running",
      endpoints: ["/health", "/ready", "/docs", "/openapi.yaml", "/v1/*"]
    });
  }

  if (req.method === "GET" && (pathname === "/docs" || pathname === "/docs/")) {
    return serveSwaggerDocs(res);
  }

  if (req.method === "GET" && pathname === "/openapi.yaml") {
    return serveOpenApiSpec(res);
  }

  if (req.method === "GET" && serveFrontendAsset(res, pathname)) {
    return;
  }

  // AUTH-013: SCIM 2.0 surface. Bearer-token auth happens inside each
  // handler.
  if (isScimPath) {
    if (req.method === "GET" && pathname === "/scim/v2/ServiceProviderConfig") {
      return handleServiceProviderConfig(req, res);
    }
    if (req.method === "GET" && pathname === "/scim/v2/ResourceTypes") {
      return handleResourceTypes(req, res);
    }
    if (req.method === "GET" && pathname === "/scim/v2/Schemas") {
      return handleSchemas(req, res);
    }
    if (req.method === "GET" && pathname === "/scim/v2/Users") {
      return handleScimListUsers(req, res, requestUrl);
    }
    if (req.method === "POST" && pathname === "/scim/v2/Users") {
      return handleScimCreateUser(req, res);
    }
    const scimUserIdMatch = pathname.match(/^\/scim\/v2\/Users\/([^/]+)$/);
    if (scimUserIdMatch) {
      if (req.method === "GET") return handleScimGetUser(req, res, scimUserIdMatch[1]);
      if (req.method === "PUT") return handleScimReplaceUser(req, res, scimUserIdMatch[1]);
      if (req.method === "PATCH") return handleScimPatchUser(req, res, scimUserIdMatch[1]);
      if (req.method === "DELETE") return handleScimDeleteUser(req, res, scimUserIdMatch[1]);
    }
    if (req.method === "GET" && pathname === "/scim/v2/Groups") {
      return handleScimListGroups(req, res);
    }
    if ((req.method === "POST" || req.method === "PUT") && pathname.match(/^\/scim\/v2\/Groups(\/[^/]+)?$/)) {
      return handleScimCreateGroup(req, res);
    }
    if (req.method === "PATCH" && pathname.match(/^\/scim\/v2\/Groups\/[^/]+$/)) {
      return handleScimPatchGroup(req, res);
    }
    return notFound(res);
  }

  if (req.method === "POST" && pathname === "/v1/auth/login") {
    return handleLogin(req, res);
  }

  if (req.method === "POST" && pathname === "/v1/auth/logout") {
    return handleLogout(req, res);
  }

  if (req.method === "GET" && pathname === "/v1/auth/me") {
    return handleMe(req, res);
  }

  if (req.method === "GET" && pathname === "/v1/auth/oidc/providers") {
    return handleListEnabledProviders(req, res);
  }

  if (req.method === "GET" && pathname === "/v1/auth/oidc/login") {
    return handleStartLogin(req, res, requestUrl);
  }

  if (req.method === "GET" && pathname === "/v1/auth/oidc/callback") {
    return handleCallback(req, res, requestUrl);
  }

  // AUTH-006: per-user configuration profile
  if (req.method === "GET" && pathname === "/v1/users/me/config") {
    return handleGetUserConfig(req, res);
  }
  if (req.method === "PUT" && pathname === "/v1/users/me/config") {
    return handlePutUserConfig(req, res);
  }

  // AUTH-007: per-user prompt presets
  if (req.method === "GET" && pathname === "/v1/users/me/prompt-presets") {
    return handleListPromptPresets(req, res);
  }
  if (req.method === "POST" && pathname === "/v1/users/me/prompt-presets") {
    return handleCreatePromptPreset(req, res);
  }
  const promptPresetIdMatch = pathname.match(/^\/v1\/users\/me\/prompt-presets\/([^/]+)$/);
  if (promptPresetIdMatch) {
    if (req.method === "PUT") return handleUpdatePromptPreset(req, res, promptPresetIdMatch[1]);
    if (req.method === "DELETE") return handleDeletePromptPreset(req, res, promptPresetIdMatch[1]);
  }

  if (req.method === "GET" && pathname === "/v1/admin/users") {
    return handleListUsers(req, res);
  }

  if (req.method === "POST" && pathname === "/v1/admin/users") {
    return handleCreateUser(req, res);
  }

  const adminUserRolesMatch = pathname.match(/^\/v1\/admin\/users\/([^/]+)\/roles$/);
  if (req.method === "POST" && adminUserRolesMatch) {
    return handleUpdateUserRoles(req, res, adminUserRolesMatch[1]);
  }

  const adminDataSourceAccessMatch = pathname.match(/^\/v1\/admin\/data-sources\/([^/]+)\/access$/);
  if (req.method === "GET" && adminDataSourceAccessMatch) {
    return handleListDataSourceAccess(req, res, adminDataSourceAccessMatch[1]);
  }
  if (req.method === "POST" && adminDataSourceAccessMatch) {
    return handleGrantDataSourceAccess(req, res, adminDataSourceAccessMatch[1]);
  }

  const adminDataSourceRevokeMatch = pathname.match(/^\/v1\/admin\/data-sources\/([^/]+)\/access\/([^/]+)$/);
  if (req.method === "DELETE" && adminDataSourceRevokeMatch) {
    return handleRevokeDataSourceAccess(req, res, adminDataSourceRevokeMatch[1], adminDataSourceRevokeMatch[2]);
  }

  if (req.method === "GET" && pathname === "/v1/admin/auth-providers") {
    return handleListAuthProviders(req, res);
  }
  if (req.method === "POST" && pathname === "/v1/admin/auth-providers") {
    return handleUpsertAuthProvider(req, res);
  }

  const adminAuthProviderTestMatch = pathname.match(/^\/v1\/admin\/auth-providers\/([^/]+)\/test$/);
  if (req.method === "POST" && adminAuthProviderTestMatch) {
    return handleTestAuthProvider(req, res, adminAuthProviderTestMatch[1]);
  }

  const adminAuthProviderMappingMatch = pathname.match(/^\/v1\/admin\/auth-providers\/([^/]+)\/mapping-rules$/);
  if (req.method === "POST" && adminAuthProviderMappingMatch) {
    return handleUpsertAuthProviderMappingRules(req, res, adminAuthProviderMappingMatch[1]);
  }

  const adminScimGroupMappingsMatch = pathname.match(/^\/v1\/admin\/auth-providers\/([^/]+)\/scim-group-mappings$/);
  if (req.method === "POST" && adminScimGroupMappingsMatch) {
    return handleUpsertScimGroupMappings(req, res, adminScimGroupMappingsMatch[1]);
  }

  const adminScimTokensListMatch = pathname.match(/^\/v1\/admin\/auth-providers\/([^/]+)\/scim-tokens$/);
  if (adminScimTokensListMatch) {
    if (req.method === "GET") return handleListScimTokens(req, res, adminScimTokensListMatch[1]);
    if (req.method === "POST") return handleIssueScimToken(req, res, adminScimTokensListMatch[1]);
  }

  const adminScimTokenDeleteMatch = pathname.match(/^\/v1\/admin\/auth-providers\/([^/]+)\/scim-tokens\/([^/]+)$/);
  if (req.method === "DELETE" && adminScimTokenDeleteMatch) {
    return handleRevokeScimToken(req, res, adminScimTokenDeleteMatch[1], adminScimTokenDeleteMatch[2]);
  }

  const adminAuthProviderDeleteMatch = pathname.match(/^\/v1\/admin\/auth-providers\/([^/]+)$/);
  if (req.method === "DELETE" && adminAuthProviderDeleteMatch) {
    return handleDeleteAuthProvider(req, res, adminAuthProviderDeleteMatch[1]);
  }

  const adminUserLinkedIdentitiesMatch = pathname.match(/^\/v1\/admin\/users\/([^/]+)\/linked-identities$/);
  if (req.method === "GET" && adminUserLinkedIdentitiesMatch) {
    return handleListUserLinkedIdentities(req, res, adminUserLinkedIdentitiesMatch[1]);
  }

  const adminUserLinkedIdentityDeleteMatch = pathname.match(/^\/v1\/admin\/users\/([^/]+)\/linked-identities\/([^/]+)$/);
  if (req.method === "DELETE" && adminUserLinkedIdentityDeleteMatch) {
    return handleDeleteUserLinkedIdentity(
      req,
      res,
      adminUserLinkedIdentityDeleteMatch[1],
      adminUserLinkedIdentityDeleteMatch[2]
    );
  }

  if (req.method === "GET" && pathname === "/v1/admin/audit-events") {
    return handleListAuditEvents(req, res, requestUrl);
  }

  if (req.method === "POST" && pathname === "/v1/data-sources") {
    return handleCreateDataSource(req, res);
  }

  if (req.method === "GET" && pathname === "/v1/data-sources") {
    return handleListDataSources(req, res);
  }

  const deleteDataSourceMatch = pathname.match(/^\/v1\/data-sources\/([^/]+)$/);
  if (req.method === "DELETE" && deleteDataSourceMatch) {
    return handleDeleteDataSource(req, res, deleteDataSourceMatch[1]);
  }

  const introspectMatch = pathname.match(/^\/v1\/data-sources\/([^/]+)\/introspect$/);
  if (req.method === "POST" && introspectMatch) {
    return handleIntrospect(req, res, introspectMatch[1]);
  }

  const importSchemaMatch = pathname.match(/^\/v1\/data-sources\/([^/]+)\/import-schema$/);
  if (req.method === "POST" && importSchemaMatch) {
    return handleImportSchema(req, res, importSchemaMatch[1]);
  }

  if (req.method === "POST" && pathname === "/v1/data-sources/import") {
    return handleImportDataSource(req, res);
  }

  const exportDataSourceMatch = pathname.match(/^\/v1\/data-sources\/([^/]+)\/export$/);
  if (req.method === "GET" && exportDataSourceMatch) {
    return handleExportDataSource(req, res, exportDataSourceMatch[1]);
  }

  if (req.method === "GET" && pathname === "/v1/schema-objects") {
    return handleListSchemaObjects(req, res, requestUrl);
  }

  const schemaObjectMatch = pathname.match(/^\/v1\/schema-objects\/([^/]+)$/);
  if (req.method === "PATCH" && schemaObjectMatch) {
    return handlePatchSchemaObject(req, res, schemaObjectMatch[1]);
  }

  if (req.method === "POST" && pathname === "/v1/semantic-entities") {
    return handleUpsertSemanticEntity(req, res);
  }

  if (req.method === "POST" && pathname === "/v1/metric-definitions") {
    return handleUpsertMetricDefinition(req, res);
  }

  if (req.method === "POST" && pathname === "/v1/join-policies") {
    return handleUpsertJoinPolicy(req, res);
  }

  if (req.method === "POST" && pathname === "/v1/query/sessions") {
    return handleCreateSession(req, res);
  }

  if (req.method === "GET" && pathname === "/v1/query/prompts/history") {
    return handlePromptHistory(req, res, requestUrl);
  }

  if (req.method === "POST" && pathname === "/v1/saved-queries") {
    return handleCreateSavedQuery(req, res);
  }

  if (req.method === "GET" && pathname === "/v1/saved-queries") {
    return handleListSavedQueries(req, res, requestUrl);
  }

  const savedQueryValidateParamsMatch = pathname.match(/^\/v1\/saved-queries\/([^/]+)\/validate-params$/);
  if (req.method === "POST" && savedQueryValidateParamsMatch) {
    return handleValidateParams(req, res, savedQueryValidateParamsMatch[1]);
  }

  const savedQueryRunMatch = pathname.match(/^\/v1\/saved-queries\/([^/]+)\/run$/);
  if (req.method === "POST" && savedQueryRunMatch) {
    return handleRunSavedQuery(req, res, savedQueryRunMatch[1]);
  }

  const savedQueryShareMatch = pathname.match(/^\/v1\/saved-queries\/([^/]+)\/share$/);
  if (req.method === "POST" && savedQueryShareMatch) {
    return handleShareSavedQuery(req, res, savedQueryShareMatch[1]);
  }

  const savedQueryAccessMatch = pathname.match(/^\/v1\/saved-queries\/([^/]+)\/access$/);
  if (req.method === "GET" && savedQueryAccessMatch) {
    return handleGetSavedQueryAccess(req, res, savedQueryAccessMatch[1]);
  }

  const savedQueryVersionsMatch = pathname.match(/^\/v1\/saved-queries\/([^/]+)\/versions$/);
  if (req.method === "GET" && savedQueryVersionsMatch) {
    return handleListSavedQueryVersions(req, res, savedQueryVersionsMatch[1]);
  }

  const savedQueryRestoreMatch = pathname.match(/^\/v1\/saved-queries\/([^/]+)\/versions\/([^/]+)\/restore$/);
  if (req.method === "POST" && savedQueryRestoreMatch) {
    return handleRestoreSavedQueryVersion(req, res, savedQueryRestoreMatch[1], savedQueryRestoreMatch[2]);
  }

  // QUERY-007: scheduled delivery — matched before the generic /:id catch-all.
  const savedQueryScheduleRetryMatch = pathname.match(/^\/v1\/saved-queries\/([^/]+)\/schedules\/([^/]+)\/retry$/);
  if (req.method === "POST" && savedQueryScheduleRetryMatch) {
    return handleRetrySchedule(req, res, savedQueryScheduleRetryMatch[1], savedQueryScheduleRetryMatch[2]);
  }

  const savedQueryScheduleIdMatch = pathname.match(/^\/v1\/saved-queries\/([^/]+)\/schedules\/([^/]+)$/);
  if (savedQueryScheduleIdMatch) {
    if (req.method === "PUT") {
      return handleUpdateSchedule(req, res, savedQueryScheduleIdMatch[1], savedQueryScheduleIdMatch[2]);
    }
    if (req.method === "DELETE") {
      return handleDeleteSchedule(req, res, savedQueryScheduleIdMatch[1], savedQueryScheduleIdMatch[2]);
    }
  }

  const savedQuerySchedulesMatch = pathname.match(/^\/v1\/saved-queries\/([^/]+)\/schedules$/);
  if (savedQuerySchedulesMatch) {
    if (req.method === "POST") {
      return handleCreateSchedule(req, res, savedQuerySchedulesMatch[1]);
    }
    if (req.method === "GET") {
      return handleListSchedules(req, res, savedQuerySchedulesMatch[1]);
    }
  }

  // QUERY-008: saved-query foldering. The /move route on a saved-query id
  // lives here so it's matched before the generic /v1/saved-queries/:id
  // catch-all below. Folder CRUD is a sibling resource.
  const savedQueryMoveMatch = pathname.match(/^\/v1\/saved-queries\/([^/]+)\/move$/);
  if (req.method === "POST" && savedQueryMoveMatch) {
    return handleMoveSavedQuery(req, res, savedQueryMoveMatch[1]);
  }

  if (req.method === "POST" && pathname === "/v1/saved-query-folders") {
    return handleCreateSavedQueryFolder(req, res);
  }

  if (req.method === "GET" && pathname === "/v1/saved-query-folders") {
    return handleListSavedQueryFolders(req, res);
  }

  const savedQueryFolderMatch = pathname.match(/^\/v1\/saved-query-folders\/([^/]+)$/);
  if (req.method === "PUT" && savedQueryFolderMatch) {
    return handleUpdateSavedQueryFolder(req, res, savedQueryFolderMatch[1]);
  }
  if (req.method === "DELETE" && savedQueryFolderMatch) {
    return handleDeleteSavedQueryFolder(req, res, savedQueryFolderMatch[1]);
  }

  const savedQueryMatch = pathname.match(/^\/v1\/saved-queries\/([^/]+)$/);
  if (req.method === "GET" && savedQueryMatch) {
    return handleGetSavedQuery(req, res, savedQueryMatch[1]);
  }

  if (req.method === "PUT" && savedQueryMatch) {
    return handleUpdateSavedQuery(req, res, savedQueryMatch[1]);
  }

  if (req.method === "DELETE" && savedQueryMatch) {
    return handleDeleteSavedQuery(req, res, savedQueryMatch[1]);
  }

  const runMatch = pathname.match(/^\/v1\/query\/sessions\/([^/]+)\/run$/);
  if (req.method === "POST" && runMatch) {
    return handleRunSession(req, res, runMatch[1]);
  }

  const cancelClarificationMatch = pathname.match(/^\/v1\/query\/sessions\/([^/]+)\/clarification\/cancel$/);
  if (req.method === "POST" && cancelClarificationMatch) {
    return handleCancelClarification(req, res, cancelClarificationMatch[1]);
  }

  const feedbackMatch = pathname.match(/^\/v1\/query\/sessions\/([^/]+)\/feedback$/);
  if (req.method === "POST" && feedbackMatch) {
    return handleFeedback(req, res, feedbackMatch[1]);
  }

  const exportMatch = pathname.match(/^\/v1\/query\/sessions\/([^/]+)\/export$/);
  if (req.method === "POST" && exportMatch) {
    return handleExportSession(req, res, exportMatch[1]);
  }

  const deliverMatch = pathname.match(/^\/v1\/query\/sessions\/([^/]+)\/export\/deliver$/);
  if (req.method === "POST" && deliverMatch) {
    return handleExportDeliver(req, res, deliverMatch[1]);
  }

  const exportStatusMatch = pathname.match(/^\/v1\/exports\/([^/]+)\/status$/);
  if (req.method === "GET" && exportStatusMatch) {
    return handleExportStatus(req, res, exportStatusMatch[1]);
  }

  if (req.method === "GET" && pathname === "/v1/llm/providers") {
    return handleProviderList(req, res);
  }

  if (req.method === "POST" && pathname === "/v1/llm/providers") {
    return handleProviderUpsert(req, res);
  }

  if (req.method === "POST" && pathname === "/v1/llm/routing-rules") {
    return handleRoutingRuleUpsert(req, res);
  }

  if (req.method === "GET" && pathname === "/v1/health/providers") {
    return handleProviderHealth(req, res);
  }

  if (req.method === "GET" && pathname === "/v1/observability/metrics") {
    return handleObservabilityMetrics(req, res, requestUrl);
  }

  if (req.method === "GET" && pathname === "/v1/observability/release-gates") {
    return handleReleaseGates(req, res);
  }

  if (req.method === "GET" && pathname === "/v1/observability/benchmark-command") {
    return handleBenchmarkCommand(req, res);
  }

  if (req.method === "POST" && pathname === "/v1/observability/release-gates/report") {
    return handleCreateBenchmarkReport(req, res);
  }

  if (req.method === "GET" && pathname === "/v1/rag/notes") {
    return handleListRagNotes(req, res, requestUrl);
  }

  if (req.method === "POST" && pathname === "/v1/rag/notes") {
    return handleUpsertRagNote(req, res);
  }

  const ragNoteDeleteMatch = pathname.match(/^\/v1\/rag\/notes\/([^/]+)$/);
  if (req.method === "DELETE" && ragNoteDeleteMatch) {
    return handleDeleteRagNote(req, res, ragNoteDeleteMatch[1]);
  }

  if (req.method === "POST" && pathname === "/v1/rag/reindex") {
    return handleRagReindex(req, res, requestUrl);
  }

  if (shouldServeFrontendApp(req, pathname)) {
    serveFrontendIndex(res);
    return;
  }

  return notFound(res);
}

export function startServer(): Promise<http.Server> {
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const authedReq = req as AuthedRequest;
    const startedAt = Date.now();
    const requestId = createRequestId();
    authedReq.requestId = requestId;
    res.setHeader("x-request-id", requestId);

    // CORS
    const origin = (req.headers.origin as string | undefined) || "*";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Vary", "Origin");

    // AUTH-009 baseline security headers — applied to every response so that
    // both the JSON API and the served frontend HTML get them.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
    );
    // HSTS only makes sense when the deployment terminates TLS. Gated on the
    // same flag we use for `Secure` cookies so test/dev runs don't accidentally
    // pin localhost browsers to HTTPS.
    if (process.env.AUTH_COOKIE_SECURE === "true" || process.env.NODE_ENV === "production") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    res.on("finish", () => {
      logEvent("http_request", {
        request_id: requestId,
        method: req.method,
        path: req.url,
        status_code: res.statusCode,
        duration_ms: Date.now() - startedAt
      });
    });

    try {
      await routeRequest(authedReq, res);
    } catch (err) {
      if (statusCodeFromError(err) === 400) {
        return badRequest(res, (err as HttpishError).message);
      }
      logEvent(
        "http_error",
        {
          request_id: requestId,
          method: req.method,
          path: req.url,
          error: errorMessage(err),
          stack: (err as HttpishError).stack || null
        },
        "error"
      );
      return internalError(res);
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(PORT, () => {
      logEvent("server_started", { port: PORT });
      resolve(server);
    });
  });
}
