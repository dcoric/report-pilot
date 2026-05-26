#!/usr/bin/env node
// AUTH-001/AUTH-002: bootstrap a user account (e.g. the initial admin) without
// going through the admin API. Reads DATABASE_URL from the env.
//
// Usage (run via tsx since this file lives outside the compiled `dist/`):
//   npx tsx scripts/create-user.ts --email alice@example.com --password 'hunter22ok'
//   npx tsx scripts/create-user.ts --email alice@example.com --password '...' --display-name 'Alice' --update-if-exists
//   npx tsx scripts/create-user.ts --email alice@example.com --password '...' --role analyst --role viewer
//
// Default role behavior:
//   * If --role is supplied (one or more), exactly those roles are assigned.
//   * If --role is not supplied AND no users exist yet, the new user gets the
//     `admin` role so the system has an initial administrator.
//   * Otherwise the new user gets the standard default role (`viewer`).

import * as readline from "readline";
import * as authService from "../app/src/services/authService";
import * as roleService from "../app/src/services/roleService";
import appDb = require("../app/src/lib/appDb");
import { errorMessage } from "../app/src/lib/http";

interface CliOptions {
  email?: string;
  password?: string;
  displayName?: string;
  roles: string[];
  updateIfExists: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { updateIfExists: false, roles: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--email":
        opts.email = argv[++i];
        break;
      case "--password":
        opts.password = argv[++i];
        break;
      case "--display-name":
        opts.displayName = argv[++i];
        break;
      case "--role":
        opts.roles.push(argv[++i]);
        break;
      case "--update-if-exists":
        opts.updateIfExists = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp(): void {
  process.stdout.write(`Usage: npx tsx scripts/create-user.ts --email <email> [options]\n\n`
    + `Options:\n`
    + `  --email <email>        Email address (required)\n`
    + `  --password <pw>        Password. If omitted, you'll be prompted.\n`
    + `  --display-name <name>  Optional display name\n`
    + `  --role <name>          Role to assign. May be passed multiple times.\n`
    + `                         Defaults to 'admin' if no users exist yet,\n`
    + `                         otherwise 'viewer'.\n`
    + `  --update-if-exists     Reset password and display name if the user already exists\n`
    + `  -h, --help             Show this help\n`);
}

function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (char: Buffer | string) => {
      const c = String(char);
      if (c === "\n" || c === "\r" || c === "") {
        process.stdin.removeListener("data", onData);
        return;
      }
      // Re-render the prompt without echoing the character.
      readline.cursorTo(process.stdout, prompt.length);
      readline.clearLine(process.stdout, 1);
    };
    process.stdin.on("data", onData);
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (!answer) {
        reject(new Error("Password is required."));
        return;
      }
      resolve(answer);
    });
  });
}

interface ApplyRolesInput {
  userId: string;
  roleNames: string[];
}

async function applyRoles({ userId, roleNames }: ApplyRolesInput): Promise<void> {
  const currentRoles = await roleService.listRoleNamesForUser(userId);
  const desired = roleService.uniqueRoleNames(roleNames) || [];
  const toAssign = desired.filter((name) => !currentRoles.includes(name));
  const toRevoke = currentRoles.filter((name) => !desired.includes(name));
  if (toAssign.length === 0 && toRevoke.length === 0) {
    return;
  }
  await appDb.withTransaction(async (client) => {
    if (toAssign.length > 0) {
      await roleService.assignRolesByName(client, {
        userId,
        roleNames: toAssign,
        actorUserId: null
      });
    }
    if (toRevoke.length > 0) {
      await roleService.revokeRolesByName(client, {
        userId,
        roleNames: toRevoke,
        actorUserId: null
      });
    }
  });
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  if (!opts.email) {
    printHelp();
    throw new Error("--email is required");
  }
  if (!opts.password) {
    opts.password = await promptHidden(`Password for ${opts.email}: `);
  }
  const normalized = authService.normalizeEmail(opts.email);
  if (!normalized) {
    throw new Error("Email is not a valid address.");
  }
  if (!authService.validatePassword(opts.password)) {
    throw new Error(`Password must be ${authService.PASSWORD_MIN_LENGTH}-${authService.PASSWORD_MAX_LENGTH} characters.`);
  }

  const existing = await authService.findUserByEmail(normalized);
  if (existing && !opts.updateIfExists) {
    throw new Error(`User ${normalized} already exists. Pass --update-if-exists to reset the password.`);
  }

  if (existing) {
    const passwordHash = authService.hashPassword(opts.password);
    const result = await appDb.query<{ id: string; email: string }>(
      `
        UPDATE users
        SET password_hash = $1,
            display_name = COALESCE($2, display_name),
            updated_at = NOW()
        WHERE id = $3
        RETURNING id, email
      `,
      [passwordHash, opts.displayName || null, existing.id]
    );
    if (opts.roles.length > 0) {
      await applyRoles({ userId: existing.id, roleNames: opts.roles });
    }
    process.stdout.write(`Updated user ${result.rows[0].email} (id=${result.rows[0].id}).\n`);
    return;
  }

  const userCountResult = await appDb.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM users");
  const hasExistingUsers = userCountResult.rows[0].count > 0;
  const rolesToAssign = opts.roles.length > 0
    ? opts.roles
    : [hasExistingUsers ? roleService.DEFAULT_ROLE : "admin"];

  const created = await appDb.withTransaction(async (client) => {
    const insert = await client.query<{ id: string; email: string }>(
      `
        INSERT INTO users (email, password_hash, display_name)
        VALUES ($1, $2, $3)
        RETURNING id, email
      `,
      [normalized, authService.hashPassword(opts.password as string), opts.displayName || null]
    );
    const user = insert.rows[0];
    await roleService.writeAuditEntry(client, {
      actorUserId: null,
      targetUserId: user.id,
      action: "user.created",
      details: { email: user.email, via: "scripts/create-user.ts" }
    });
    await roleService.assignRolesByName(client, {
      userId: user.id,
      roleNames: rolesToAssign,
      actorUserId: null
    });
    return user;
  });

  process.stdout.write(`Created user ${created.email} (id=${created.id}) with roles: ${rolesToAssign.join(", ")}.\n`);
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`[create-user] ${errorMessage(err)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await appDb.close();
    } catch {
      // already closed
    }
  });
