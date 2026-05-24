import type { PoolClient } from "pg";
import appDb = require("../lib/appDb");
import authService = require("./authService");
import roleService = require("./roleService");

export interface ServiceResult<T = unknown> {
  ok: boolean;
  statusCode: number;
  body: T;
}

export interface PublicUser {
  id: string;
  email: string;
  display_name: string | null;
  is_active: boolean;
  last_login_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  roles: string[];
}

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  is_active: boolean;
  last_login_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface UserRowWithRoles extends UserRow {
  roles: string[];
}

export interface CreateUserInput {
  email: unknown;
  password: unknown;
  displayName?: unknown;
  roles?: unknown;
  actorUserId?: string | null;
}

export interface UpdateUserRolesInput {
  userId: string;
  assign?: unknown;
  revoke?: unknown;
  actorUserId?: string | null;
}

interface ServiceErrorBody {
  error: string;
  code?: string;
  message: string;
}

function success<T>(body: T, statusCode = 200): ServiceResult<T> {
  return { ok: true, statusCode, body };
}

function failure(statusCode: number, body: ServiceErrorBody): ServiceResult<ServiceErrorBody> {
  return { ok: false, statusCode, body };
}

export function publicUser(user: UserRow, roles: string[] | unknown): PublicUser {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    is_active: user.is_active,
    last_login_at: user.last_login_at,
    created_at: user.created_at,
    updated_at: user.updated_at,
    roles: Array.isArray(roles) ? (roles as string[]) : []
  };
}

export async function listUsers(): Promise<ServiceResult<{ items: PublicUser[] }>> {
  const result = await appDb.query<UserRowWithRoles>(
    `
      SELECT
        u.id,
        u.email,
        u.display_name,
        u.is_active,
        u.last_login_at,
        u.created_at,
        u.updated_at,
        COALESCE(
          (
            SELECT array_agg(r.name ORDER BY r.name)
            FROM user_roles ur
            JOIN roles r ON r.id = ur.role_id
            WHERE ur.user_id = u.id
          ),
          ARRAY[]::text[]
        ) AS roles
      FROM users u
      ORDER BY lower(u.email)
    `
  );
  return success({
    items: result.rows.map((row) => publicUser(row, row.roles))
  });
}

export async function createUser({ email, password, displayName, roles, actorUserId }: CreateUserInput): Promise<ServiceResult<unknown>> {
  const normalizedEmail = authService.normalizeEmail(email);
  if (!normalizedEmail) {
    return failure(400, { error: "bad_request", message: "email is not a valid address" });
  }
  const policy = authService.checkPasswordPolicy(password, { email: normalizedEmail });
  if (policy.ok !== true) {
    const { code, message } = policy;
    return failure(400, { error: "bad_request", code, message });
  }

  let requestedRoleNames: string[] | null = null;
  if (roles !== undefined && roles !== null) {
    const parsed = roleService.uniqueRoleNames(roles);
    if (parsed === null) {
      return failure(400, { error: "bad_request", message: "roles must be an array of role names" });
    }
    requestedRoleNames = parsed;
  }
  const rolesToAssign = requestedRoleNames && requestedRoleNames.length > 0
    ? requestedRoleNames
    : [roleService.DEFAULT_ROLE];

  const passwordHash = authService.hashPassword(password);
  const trimmedDisplayName = typeof displayName === "string" && displayName.trim()
    ? displayName.trim()
    : null;

  try {
    const result = await appDb.withTransaction(async (client: PoolClient) => {
      const userInsert = await client.query<UserRow>(
        `
          INSERT INTO users (email, password_hash, display_name)
          VALUES ($1, $2, $3)
          RETURNING id, email, display_name, is_active, last_login_at, created_at, updated_at
        `,
        [normalizedEmail, passwordHash, trimmedDisplayName]
      );
      const user = userInsert.rows[0];

      await roleService.writeAuditEntry(client, {
        actorUserId,
        targetUserId: user.id,
        action: "user.created",
        details: { email: user.email }
      });

      const { assigned } = await roleService.assignRolesByName(client, {
        userId: user.id,
        roleNames: rolesToAssign,
        actorUserId
      });

      return { user, roles: assigned };
    });
    return success(publicUser(result.user, result.roles), 201);
  } catch (err) {
    const e = err as { code?: string; unknown?: string[] };
    if (e && e.code === "23505") {
      return failure(409, { error: "conflict", message: "a user with that email already exists" });
    }
    if (e && e.code === "unknown_role") {
      return failure(400, {
        error: "bad_request",
        message: `unknown role(s): ${(e.unknown || []).join(", ")}`
      });
    }
    throw err;
  }
}

export async function updateUserRoles({ userId, assign, revoke, actorUserId }: UpdateUserRolesInput): Promise<ServiceResult<unknown>> {
  const userResult = await appDb.query<UserRow>(
    "SELECT id, email, display_name, is_active, last_login_at, created_at, updated_at FROM users WHERE id = $1",
    [userId]
  );
  if (userResult.rowCount === 0) {
    return failure(404, { error: "not_found", message: "user not found" });
  }
  const user = userResult.rows[0];

  let assignNames: string[] = [];
  let revokeNames: string[] = [];
  if (assign !== undefined && assign !== null) {
    const parsed = roleService.uniqueRoleNames(assign);
    if (parsed === null) {
      return failure(400, { error: "bad_request", message: "assign must be an array of role names" });
    }
    assignNames = parsed;
  }
  if (revoke !== undefined && revoke !== null) {
    const parsed = roleService.uniqueRoleNames(revoke);
    if (parsed === null) {
      return failure(400, { error: "bad_request", message: "revoke must be an array of role names" });
    }
    revokeNames = parsed;
  }
  if (assignNames.length === 0 && revokeNames.length === 0) {
    return failure(400, { error: "bad_request", message: "assign or revoke must contain at least one role" });
  }

  const overlap = assignNames.filter((name) => revokeNames.includes(name));
  if (overlap.length > 0) {
    return failure(400, {
      error: "bad_request",
      message: `cannot assign and revoke the same role(s): ${overlap.join(", ")}`
    });
  }

  try {
    return await appDb.withTransaction(async (client: PoolClient) => {
      const assignResult = await roleService.assignRolesByName(client, {
        userId: user.id,
        roleNames: assignNames,
        actorUserId
      });
      const revokeResult = await roleService.revokeRolesByName(client, {
        userId: user.id,
        roleNames: revokeNames,
        actorUserId
      });
      const rolesAfter = await roleService.listRoleNamesForUser(user.id, client);
      return success({
        user: publicUser(user, rolesAfter),
        assigned: assignResult.assigned,
        revoked: revokeResult.revoked,
        skipped_assign: assignResult.skipped,
        skipped_revoke: revokeResult.skipped
      });
    });
  } catch (err) {
    const e = err as { code?: string; unknown?: string[] };
    if (e && e.code === "unknown_role") {
      return failure(400, {
        error: "bad_request",
        message: `unknown role(s): ${(e.unknown || []).join(", ")}`
      });
    }
    throw err;
  }
}
