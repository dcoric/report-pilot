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

const appDb = require("../lib/appDb");
const authProviderService = require("./authProviderService");
const auditService = require("./auditService");
const roleService = require("./roleService");
const scimUserService = require("./scimUserService");

const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";

function scimGroupListEmpty() {
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
async function resolveMembers(providerId, members) {
  if (!Array.isArray(members) || members.length === 0) return [];
  const ids = members.map((m) => (m && typeof m.value === "string" ? m.value : null)).filter(Boolean);
  const out = [];
  for (const id of ids) {
    const row = await scimUserService.findUserByExternalIdOrUserId(providerId, id);
    if (row) out.push(row);
  }
  return out;
}

function rolesForGroupName(provider, groupName) {
  return authProviderService.scimGroupsToRoles(provider, [groupName]);
}

async function applyMembershipDelta({ providerId, provider, groupName, addMembers = [], removeMembers = [], actorUserId = null }) {
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

  await appDb.withTransaction(async (client) => {
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

function groupToScim({ providerId, body }) {
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

async function createOrReplaceGroup({ providerId, body, actorUserId = null }) {
  if (!body || typeof body.displayName !== "string" || !body.displayName.trim()) {
    return scimUserService.scimError(400, "displayName is required", "invalidValue");
  }
  const provider = await authProviderService.findProviderById(providerId, { withSecret: true });
  if (!provider) {
    return scimUserService.scimError(404, "provider not found");
  }
  const members = Array.isArray(body.members) ? body.members : [];
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

async function patchGroup({ providerId, body, actorUserId = null }) {
  if (!body || !Array.isArray(body.Operations)) {
    return scimUserService.scimError(400, "Operations array is required", "invalidSyntax");
  }
  const provider = await authProviderService.findProviderById(providerId, { withSecret: true });
  if (!provider) {
    return scimUserService.scimError(404, "provider not found");
  }
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : null;
  let addMembers = [];
  let removeMembers = [];
  let groupName = displayName;
  for (const op of body.Operations) {
    if (!op || typeof op.op !== "string") continue;
    const opName = op.op.toLowerCase();
    if (op.path === "displayName" && typeof op.value === "string") {
      groupName = op.value.trim();
    }
    if (op.path === "members" || (op.path && op.path.startsWith("members"))) {
      const value = Array.isArray(op.value) ? op.value : [];
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
function listGroups() {
  return { statusCode: 200, body: scimGroupListEmpty() };
}

module.exports = {
  SCIM_GROUP_SCHEMA,
  createOrReplaceGroup,
  patchGroup,
  listGroups,
  applyMembershipDelta
};
