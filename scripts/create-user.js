#!/usr/bin/env node
// AUTH-001: bootstrap a user account (e.g. the initial admin) without going
// through the (not-yet-built) admin API. Reads DATABASE_URL from the env.
//
// Usage:
//   node scripts/create-user.js --email alice@example.com --password 'hunter22ok'
//   node scripts/create-user.js --email alice@example.com --password '...' --display-name 'Alice' --update-if-exists

const path = require("path");
const readline = require("readline");

const authService = require(path.resolve(__dirname, "../app/src/services/authService"));
const appDb = require(path.resolve(__dirname, "../app/src/lib/appDb"));

function parseArgs(argv) {
  const opts = { updateIfExists: false };
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

function printHelp() {
  process.stdout.write(`Usage: node scripts/create-user.js --email <email> [options]\n\n`
    + `Options:\n`
    + `  --email <email>        Email address (required)\n`
    + `  --password <pw>        Password. If omitted, you'll be prompted.\n`
    + `  --display-name <name>  Optional display name\n`
    + `  --update-if-exists     Reset password and display name if the user already exists\n`
    + `  -h, --help             Show this help\n`);
}

function promptHidden(prompt) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (char) => {
      const c = String(char);
      if (c === "\n" || c === "\r" || c === "") {
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

async function main() {
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
    const result = await appDb.query(
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
    process.stdout.write(`Updated user ${result.rows[0].email} (id=${result.rows[0].id}).\n`);
  } else {
    const created = await authService.createUser({
      email: normalized,
      password: opts.password,
      displayName: opts.displayName
    });
    process.stdout.write(`Created user ${created.email} (id=${created.id}).\n`);
  }
}

main()
  .catch((err) => {
    process.stderr.write(`[create-user] ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await appDb.close();
    } catch {
      // already closed
    }
  });
