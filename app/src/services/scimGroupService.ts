// AUTH-013: SCIM Groups -> local-role assignment.
//
// Groups in SCIM are first-class resources, but for our purposes a group's
// only meaning is "anyone in this group should have role X". The
// (group displayName -> local role) map lives on the auth_providers row
// (see authProviderService.scim_group_mappings) and is configured by the
// admin. When the IdP PUT/PATCHes a Group with members, we recompute each
// member's role set against the map and apply assign/revoke deltas.
//
// We don't persist a separate Groups table — the IdP's representation is
// transient (we don't need it for any subsequent decision). The user→role
// state is the source of truth that the app already enforces via AUTH-002.

import type { PoolClient } from "pg";
import appDb = require("../lib/appDb");
import authProviderService = require("./authProviderService");
import auditService = require("./auditService");
import roleService = require("./roleService");
import scimUserService = require("./scimUserService");

export const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";

interface ScimMember {
  value?: string;
  [key: string]: unknown;
}

interface ScimGroupRepresentation {
  schemas: string[];
  id: string;
  displayName: string | null;
  members: ScimMember[];
  meta: {
    resourceType: string;
    location: string;
    provider_id: string;
  };
}

interface ApplyDeltaArgs {
  providerId: string;
  provider: unknown;
  groupName: string;
  addMembers?: ScimMember[];
  removeMembers?: ScimMember[];
  actorUserId?: string | null;
}

interface ApplyDeltaResult {
  ok: true;
  applied: { added_roles: string[]; removed_roles: string[] };
}

interface ScimErrorResult {
  statusCode: number;
  body: unknown;
}

interface ScimOperation {
  op?: string;
  path?: string;
  value?: unknown;
}

interface ScimGroupBody {
  id?: string;
  externalId?: string;
  displayName?: string;
  members?: ScimMember[];
  Operations?: ScimOperation[];
}

function scimGroupListEmpty(): {
  schemas: string[];
  totalResults: number;
  itemsPerPage: number;
  startIndex: number;
  Resources: unknown[];
} {
  return {
    schemas: [scimUserService.SCIM_LIST_RESPONSE_SCHEMA],
    totalResults: 0,
    itemsPerPage: 0,
    startIndex: 1,
    Resources: []
  };
}

// Resolve a group's `members[].value` (each is a SCIM user id — our users.id
// or an externalId) to local user rows for the given provider.
async function resolveMembers(providerId: string, members: ScimMember[]): Promise<Array<{ id: string }>> {
  if (!Array.isArray(members) || members.length === 0) return [];
  const ids = members.map((m) => (m && typeof m.value === "string" ? m.value : null)).filter((v): v is string => v !== null);
  const out: Array<{ id: string }> = [];
  for (const id of ids) {
    const row = await scimUserService.findUserByExternalIdOrUserId(providerId, id);
    if (row) out.push(row);
  }
  return out;
}

function rolesForGroupName(provider: unknown, groupName: string): string[] {
  return authProviderService.scimGroupsToRoles(provider, [groupName]);
}

export async function applyMembershipDelta(
  { providerId, provider, groupName, addMembers = [], removeMembers = [], actorUserId = null }: ApplyDeltaArgs
): Promise<ApplyDeltaResult> {
  const targetRoles = rolesForGroupName(provider, groupName);
  if (targetRoles.length === 0) {
    // Unmapped group — no role changes to apply, but still a 200 success so
    // the IdP doesn't treat this as a failure to push.
    return { ok: true, applied: { added_roles: [], removed_roles: [] } };
  }

  const addedRows = await resolveMembers(providerId, addMembers);
  const removedRows = await resolveMembers(providerId, removeMembers);

  if (addedRows.length === 0 && removedRows.length === 0) {
    return { ok: true, applied: { added_roles: [], removed_roles: [] } };
  }

  await appDb.withTransaction(async (client: PoolClient) => {
    for (const user of addedRows) {
      await roleService.assignRolesByName(client, {
        userId: user.id,
        roleNames: targetRoles,
        actorUserId
      });
    }
    for (const user of removedRows) {
      await roleService.revokeRolesByName(client, {
        userId: user.id,
        roleNames: targetRoles,
        actorUserId
      });
    }
  });

  await auditService
    .writeEvent({
      actorUserId,
      action: "scim.group.synced",
      outcome: "success",
      details: {
        provider_id: providerId,
        group: groupName,
        roles: targetRoles,
        added_user_ids: addedRows.map((u) => u.id),
        removed_user_ids: removedRows.map((u) => u.id)
      }
    })
    .catch(() => {});

  return { ok: true, applied: { added_roles: targetRoles, removed_roles: targetRoles } };
}

function groupToScim({ providerId, body }: { providerId: string; body: ScimGroupBody }): ScimGroupRepresentation {
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: typeof body.id === "string" && body.id ? body.id : (typeof body.externalId === "string" ? body.externalId : ""),
    displayName: typeof body.displayName === "string" ? body.displayName : null,
    members: Array.isArray(body.members) ? body.members : [],
    meta: {
      resourceType: "Group",
      location: `/scim/v2/Groups/${typeof body.id === "string" ? body.id : ""}`,
      provider_id: providerId
    }
  };
}

export async function createOrReplaceGroup(
  { providerId, body, actorUserId = null }: { providerId: string; body: ScimGroupBody; actorUserId?: string | null }
): Promise<ScimErrorResult> {
  if (!body || typeof body.displayName !== "string" || !body.displayName.trim()) {
    return scimUserService.scimError(400, "displayName is required", "invalidValue");
  }
  const provider = await authProviderService.findProviderById(providerId, { withSecret: true });
  if (!provider) {
    return scimUserService.scimError(404, "provider not found");
  }
  const members: ScimMember[] = Array.isArray(body.members) ? body.members : [];
  // Treat this as the canonical set: everyone in `members` should hold the
  // mapped role(s), nobody else needs to.
  await applyMembershipDelta({
    providerId,
    provider,
    groupName: body.displayName.trim(),
    addMembers: members,
    actorUserId
  });
  return { statusCode: 200, body: groupToScim({ providerId, body }) };
}

export async function patchGroup(
  { providerId, body, actorUserId = null }: { providerId: string; body: ScimGroupBody; actorUserId?: string | null }
): Promise<ScimErrorResult> {
  if (!body || !Array.isArray(body.Operations)) {
    return scimUserService.scimError(400, "Operations array is required", "invalidSyntax");
  }
  const provider = await authProviderService.findProviderById(providerId, { withSecret: true });
  if (!provider) {
    return scimUserService.scimError(404, "provider not found");
  }
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : null;
  let addMembers: ScimMember[] = [];
  let removeMembers: ScimMember[] = [];
  let groupName = displayName;
  for (const op of body.Operations) {
    if (!op || typeof op.op !== "string") continue;
    const opName = op.op.toLowerCase();
    if (op.path === "displayName" && typeof op.value === "string") {
      groupName = op.value.trim();
    }
    if (op.path === "members" || (op.path && op.path.startsWith("members"))) {
      const value: ScimMember[] = Array.isArray(op.value) ? (op.value as ScimMember[]) : [];
      if (opName === "add" || opName === "replace") addMembers = addMembers.concat(value);
      if (opName === "remove") removeMembers = removeMembers.concat(value);
    }
  }
  if (!groupName) {
    return scimUserService.scimError(400, "displayName is required", "invalidValue");
  }
  await applyMembershipDelta({
    providerId,
    provider,
    groupName,
    addMembers,
    removeMembers,
    actorUserId
  });
  return {
    statusCode: 200,
    body: groupToScim({ providerId, body: { displayName: groupName, members: addMembers } })
  };
}

// SCIM Groups list / get are stubbed because we don't persist the group set
// — return an empty list so IdPs that probe for existence don't error.
export function listGroups(): ScimErrorResult {
  return { statusCode: 200, body: scimGroupListEmpty() };
}
