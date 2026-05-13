// AUTH-012: resolve an external-IdP principal (OIDC today, SAML/LDAP later)
// to a local user, applying the per-provider linking + JIT rules.
//
// Return shapes:
//   { ok: true, user, mode }
//     where `mode` is one of:
//       "linked_by_sub"    — subject was already attached to this user
//       "linked_by_email"  — auto-linked by email on first SSO from this IdP
//       "provisioned"      — user did not exist; created via JIT
//   { ok: false, code, status, message }
//     for refusals. `code` is stable for tests / clients; the status the
//     route should send is in `status`; `message` is human-readable.

const appDb = require("../lib/appDb");
const authService = require("../services/authService");
const auditService = require("../services/auditService");
const linkedIdentityService = require("./linkedIdentityService");
const roleService = require("./roleService");

function loadUserById(id, exec = appDb) {
  return exec
    .query(
      `SELECT id, email, password_hash, display_name, is_active, last_login_at, created_at, updated_at
         FROM users WHERE id = $1`,
      [id]
    )
    .then((r) => r.rows[0] || null);
}

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    is_active: row.is_active,
    last_login_at: row.last_login_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function emailDomain(email) {
  if (typeof email !== "string") return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase();
}

function domainAllowed(email, allowedDomains) {
  if (!Array.isArray(allowedDomains) || allowedDomains.length === 0) return true;
  const domain = emailDomain(email);
  if (!domain) return false;
  return allowedDomains.some((d) => String(d).toLowerCase() === domain);
}

async function recordAuditLinkRejected({ provider, principal, reason, context }) {
  await auditService
    .writeEvent({
      actorEmail: principal.email,
      action: "auth.identity.link_rejected",
      outcome: "failure",
      details: {
        provider: provider.name,
        provider_id: provider.id,
        subject: principal.sub || null,
        reason
      },
      ipAddress: context && context.ipAddress,
      userAgent: context && context.userAgent
    })
    .catch(() => {});
}

async function resolveExternalLogin(provider, principal, context = {}) {
  if (!provider) {
    return { ok: false, code: "no_provider", status: 404, message: "auth provider not found" };
  }
  if (!principal || !principal.email) {
    return { ok: false, code: "missing_email", status: 400, message: "external login missing email" };
  }
  if (!principal.sub) {
    // A subject claim is required so we have a stable handle for re-logins.
    return { ok: false, code: "missing_subject", status: 400, message: "external login missing sub claim" };
  }

  // 1) Existing link by (provider, subject) — the fast path for returning users.
  const existing = await linkedIdentityService.findByProviderAndSubject(provider.id, principal.sub);
  if (existing) {
    const userRow = await loadUserById(existing.user_id);
    if (!userRow || !userRow.is_active) {
      return {
        ok: false,
        code: "inactive_user",
        status: 403,
        message: "linked local account is inactive"
      };
    }
    await linkedIdentityService.touchLastSeen(existing.id).catch(() => {});
    return { ok: true, user: rowToUser(userRow), mode: "linked_by_sub" };
  }

  // AUTH-015: when the IdP exposes an `email_verified` claim and it's
  // explicitly false, refuse any path that trusts the email (auto-link
  // by email + JIT). Linking by subject already happened above and is
  // unaffected — the IdP's prior attestation of subject ownership is what
  // protects that path.
  const emailUnverified = provider.require_email_verified !== false
    && principal.claims
    && principal.claims.email_verified === false;

  // 2) No existing link — look for a local user by email.
  const userByEmail = await authService.findUserByEmail(principal.email);
  if (userByEmail) {
    if (!userByEmail.is_active) {
      return {
        ok: false,
        code: "inactive_user",
        status: 403,
        message: "local account is inactive"
      };
    }
    if (emailUnverified) {
      await auditService
        .writeEvent({
          actorEmail: principal.email,
          action: "auth.security.email_unverified",
          outcome: "failure",
          details: {
            provider: provider.name,
            provider_id: provider.id,
            subject: principal.sub,
            phase: "auto_link"
          },
          ipAddress: context.ipAddress,
          userAgent: context.userAgent
        })
        .catch(() => {});
      return {
        ok: false,
        code: "email_unverified",
        status: 403,
        message: `cannot link ${principal.email}: the IdP did not assert that the email is verified.`
      };
    }
    if (!provider.auto_link_by_email) {
      await recordAuditLinkRejected({
        provider, principal, reason: "auto_link_disabled", context
      });
      return {
        ok: false,
        code: "email_collision",
        status: 409,
        message: `an account already exists for ${principal.email}; ask an administrator to link it to ${provider.name}.`
      };
    }
    try {
      await linkedIdentityService.linkIdentity({
        userId: userByEmail.id,
        providerId: provider.id,
        subject: principal.sub,
        email: principal.email
      });
    } catch (err) {
      if (err && err.code === "23505") {
        await recordAuditLinkRejected({
          provider, principal, reason: "subject_owned_by_another_user", context
        });
        return {
          ok: false,
          code: "subject_owned_by_another_user",
          status: 409,
          message: "this external identity is already linked to a different local account."
        };
      }
      throw err;
    }
    await auditService
      .writeEvent({
        actorUserId: userByEmail.id,
        actorEmail: userByEmail.email,
        targetUserId: userByEmail.id,
        action: "auth.identity.linked",
        outcome: "success",
        details: {
          provider: provider.name,
          provider_id: provider.id,
          subject: principal.sub,
          method: "email"
        },
        ipAddress: context.ipAddress,
        userAgent: context.userAgent
      })
      .catch(() => {});
    return { ok: true, user: rowToUser(userByEmail), mode: "linked_by_email" };
  }

  // 3) No local user, no link — JIT path.
  if (!provider.jit_enabled) {
    await recordAuditLinkRejected({
      provider, principal, reason: "jit_disabled", context
    });
    return {
      ok: false,
      code: "jit_disabled",
      status: 403,
      message: `no active local account for ${principal.email}. Ask an administrator to create one.`
    };
  }
  if (emailUnverified) {
    await auditService
      .writeEvent({
        actorEmail: principal.email,
        action: "auth.security.email_unverified",
        outcome: "failure",
        details: {
          provider: provider.name,
          provider_id: provider.id,
          subject: principal.sub,
          phase: "jit"
        },
        ipAddress: context.ipAddress,
        userAgent: context.userAgent
      })
      .catch(() => {});
    return {
      ok: false,
      code: "email_unverified",
      status: 403,
      message: `cannot provision ${principal.email}: the IdP did not assert that the email is verified.`
    };
  }
  if (!domainAllowed(principal.email, provider.jit_allowed_domains)) {
    await recordAuditLinkRejected({
      provider, principal, reason: "domain_not_allowed", context
    });
    return {
      ok: false,
      code: "domain_not_allowed",
      status: 403,
      message: `email domain is not allowed for just-in-time provisioning on ${provider.name}.`
    };
  }

  // Atomically create the user, attach the requested role, and record the
  // external identity. If any step trips a unique violation we surface it as
  // a conflict instead of a 500.
  let created;
  try {
    created = await appDb.withTransaction(async (client) => {
      const trimmedDisplayName = typeof principal.display_name === "string" && principal.display_name.trim()
        ? principal.display_name.trim()
        : null;
      const userInsert = await client.query(
        `INSERT INTO users (email, password_hash, display_name)
         VALUES ($1, NULL, $2)
         RETURNING id, email, display_name, is_active, last_login_at, created_at, updated_at`,
        [principal.email, trimmedDisplayName]
      );
      const user = userInsert.rows[0];

      await roleService.writeAuditEntry(client, {
        actorUserId: null,
        targetUserId: user.id,
        action: "user.created",
        details: { email: user.email, source: "jit", provider: provider.name }
      });

      const defaultRole = provider.jit_default_role || "viewer";
      await roleService.assignRolesByName(client, {
        userId: user.id,
        roleNames: [defaultRole],
        actorUserId: null
      });

      await client.query(
        `INSERT INTO linked_identities (user_id, provider_id, subject, email_at_link)
         VALUES ($1, $2, $3, $4)`,
        [user.id, provider.id, principal.sub, principal.email]
      );
      return user;
    });
  } catch (err) {
    if (err && err.code === "23505") {
      // Race: another OIDC callback for the same email or subject committed
      // first. Re-resolve from scratch — the caller will get whatever the
      // committed state now is (most likely a linked_by_email or
      // linked_by_sub return).
      return resolveExternalLogin(provider, principal, context);
    }
    if (err && err.code === "unknown_role") {
      return {
        ok: false,
        code: "unknown_default_role",
        status: 500,
        message: `JIT default role '${provider.jit_default_role}' is not defined`
      };
    }
    throw err;
  }

  await auditService
    .writeEvent({
      actorUserId: null,
      actorEmail: created.email,
      targetUserId: created.id,
      action: "auth.user.provisioned",
      outcome: "success",
      details: {
        provider: provider.name,
        provider_id: provider.id,
        subject: principal.sub,
        role: provider.jit_default_role || "viewer"
      },
      ipAddress: context.ipAddress,
      userAgent: context.userAgent
    })
    .catch(() => {});

  await auditService
    .writeEvent({
      actorUserId: created.id,
      actorEmail: created.email,
      targetUserId: created.id,
      action: "auth.identity.linked",
      outcome: "success",
      details: {
        provider: provider.name,
        provider_id: provider.id,
        subject: principal.sub,
        method: "jit"
      },
      ipAddress: context.ipAddress,
      userAgent: context.userAgent
    })
    .catch(() => {});

  return { ok: true, user: rowToUser(created), mode: "provisioned" };
}

module.exports = {
  resolveExternalLogin
};
