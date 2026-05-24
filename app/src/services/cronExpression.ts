// QUERY-007: minimal 5-field cron parser + timezone-aware next-run computation.
//
// Why hand-rolled: the repo deliberately keeps backend deps lean (see
// `package.json` — no chrono/cron lib is already on the tree). A 5-field
// cron is small enough to parse and step through deterministically. If the
// scope grows (RRULE, seconds, "@every 5m"), swap in `cron-parser` / `croner`
// here without touching the dispatcher.
//
// Supported syntax:
//   field 1 — minute (0-59)
//   field 2 — hour (0-23)
//   field 3 — day-of-month (1-31)
//   field 4 — month (1-12)
//   field 5 — day-of-week (0-6, Sunday=0; 7 also Sunday)
// Each field accepts:
//   *          — every value
//   N          — literal
//   N-M        — inclusive range
//   N,M,...    — comma list
//   * / step   — every `step` units (e.g. "*/15", "0-30/5")
//
// Timezone: an IANA TZ name (e.g. "Europe/London"). Calculation walks the
// schedule's wall-clock minutes forward and converts back to UTC via Intl;
// DST transitions are handled by the underlying Date math (we keep stepping
// until a UTC instant is found that matches the local-wall-clock fields).

type Range = readonly [number, number];

export interface ParsedCron {
  expression: string;
  minutes: Set<number>;
  hours: Set<number>;
  doms: Set<number>;
  months: Set<number>;
  dows: Set<number>;
  domStarred: boolean;
  dowStarred: boolean;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dayOfWeek: number;
}

const MINUTE_RANGE: Range = [0, 59];
const HOUR_RANGE: Range = [0, 23];
const DOM_RANGE: Range = [1, 31];
const MONTH_RANGE: Range = [1, 12];
const DOW_RANGE: Range = [0, 6];

function parseField(spec: string, [min, max]: Range): Set<number> {
  if (typeof spec !== "string" || !spec.length) {
    throw new Error(`cron field must be a non-empty string`);
  }
  const result = new Set<number>();
  for (const part of spec.split(",")) {
    if (!part.length) {
      throw new Error(`cron field has empty list entry`);
    }
    const stepIndex = part.indexOf("/");
    const base = stepIndex === -1 ? part : part.slice(0, stepIndex);
    const step = stepIndex === -1 ? 1 : Number(part.slice(stepIndex + 1));
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`cron step must be a positive integer`);
    }
    let rangeStart: number;
    let rangeEnd: number;
    if (base === "*") {
      rangeStart = min;
      rangeEnd = max;
    } else if (base.includes("-")) {
      const [a, b] = base.split("-");
      rangeStart = Number(a);
      rangeEnd = Number(b);
    } else {
      rangeStart = Number(base);
      rangeEnd = rangeStart;
    }
    if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd)) {
      throw new Error(`cron field has non-integer value: ${part}`);
    }
    if (rangeStart < min || rangeEnd > max || rangeStart > rangeEnd) {
      throw new Error(`cron field out of range (${min}-${max}): ${part}`);
    }
    for (let v = rangeStart; v <= rangeEnd; v += step) {
      result.add(v);
    }
  }
  return result;
}

export function parseCronExpression(expression: unknown): ParsedCron {
  if (typeof expression !== "string") {
    throw new Error("cron expression must be a string");
  }
  const trimmed = expression.trim().replace(/\s+/g, " ");
  const fields = trimmed.split(" ");
  if (fields.length !== 5) {
    throw new Error(`cron expression must have exactly 5 fields (got ${fields.length})`);
  }
  const minutes = parseField(fields[0], MINUTE_RANGE);
  const hours = parseField(fields[1], HOUR_RANGE);
  const doms = parseField(fields[2], DOM_RANGE);
  const months = parseField(fields[3], MONTH_RANGE);
  let dowSpec = fields[4];
  // Accept "7" as Sunday → normalize to 0 to fit our set semantics.
  if (dowSpec.includes("7")) {
    dowSpec = dowSpec.replace(/\b7\b/g, "0");
  }
  const dows = parseField(dowSpec, DOW_RANGE);

  return {
    expression: trimmed,
    minutes,
    hours,
    doms,
    months,
    dows,
    domStarred: fields[2] === "*",
    dowStarred: fields[4] === "*"
  };
}

export function isCronExpressionValid(expression: unknown): boolean {
  try {
    parseCronExpression(expression);
    return true;
  } catch {
    return false;
  }
}

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
const DOW_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function getFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = FORMATTER_CACHE.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      weekday: "short"
    });
    FORMATTER_CACHE.set(timezone, formatter);
  }
  return formatter;
}

function getZonedParts(date: Date, timezone: string): ZonedParts {
  const formatter = getFormatter(timezone);
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
    minute: Number(parts.minute),
    dayOfWeek: DOW_MAP[parts.weekday]
  };
}

export function isTimezoneValid(timezone: unknown): timezone is string {
  if (typeof timezone !== "string" || !timezone.length) return false;
  try {
    // Will throw RangeError if invalid.
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function matchesCron(parsed: ParsedCron, parts: ZonedParts): boolean {
  if (!parsed.minutes.has(parts.minute)) return false;
  if (!parsed.hours.has(parts.hour)) return false;
  if (!parsed.months.has(parts.month)) return false;
  // Vixie-cron rule: when both dom and dow are restricted (neither is "*"),
  // either match suffices. Otherwise both must match.
  const domMatch = parsed.doms.has(parts.day);
  const dowMatch = parsed.dows.has(parts.dayOfWeek);
  if (!parsed.domStarred && !parsed.dowStarred) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

/**
 * Compute the next UTC Date strictly after `fromDate` at which the cron
 * expression fires in `timezone`. Walks one minute at a time — fine for the
 * cron grain we support (1-minute resolution) and avoids re-implementing
 * leap-second / DST math.
 *
 * Caps at 366 days of search; anything beyond that is a sign of an impossible
 * combination (e.g. "0 0 31 2 *").
 */
export function computeNextRun(expression: string, timezone: string, fromDate: Date = new Date()): Date {
  const parsed = parseCronExpression(expression);
  if (!isTimezoneValid(timezone)) {
    throw new Error(`invalid timezone: ${timezone}`);
  }
  // Step from the next whole minute strictly after fromDate.
  const start = new Date(fromDate.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);

  // Walk forward minute-by-minute but skip whole hours / days / months whenever
  // a coarser field doesn't match. Keeps the impossible-cron diagnostic loop
  // (e.g. "0 0 31 2 *") cheap rather than walking ~526k minutes one at a time.
  let cursor = start.getTime();
  const limit = cursor + 366 * 24 * 60 * 60_000;
  while (cursor <= limit) {
    const candidate = new Date(cursor);
    const parts = getZonedParts(candidate, timezone);
    if (matchesCron(parsed, parts)) {
      return candidate;
    }
    if (!parsed.months.has(parts.month)) {
      // Jump to the first minute of the next month in this timezone.
      cursor += (32 - parts.day) * 24 * 60 * 60_000;
      const sameTzNext = getZonedParts(new Date(cursor), timezone);
      cursor -= (sameTzNext.day - 1) * 24 * 60 * 60_000
        + sameTzNext.hour * 60 * 60_000
        + sameTzNext.minute * 60_000;
      continue;
    }
    const domStarred = parsed.domStarred;
    const dowStarred = parsed.dowStarred;
    const domOk = parsed.doms.has(parts.day);
    const dowOk = parsed.dows.has(parts.dayOfWeek);
    const dayMatches = (!domStarred && !dowStarred)
      ? (domOk || dowOk)
      : (domOk && dowOk);
    if (!dayMatches) {
      cursor += (24 - parts.hour) * 60 * 60_000 - parts.minute * 60_000;
      continue;
    }
    if (!parsed.hours.has(parts.hour)) {
      cursor += (60 - parts.minute) * 60_000;
      continue;
    }
    cursor += 60_000;
  }
  throw new Error(`no cron match within 366 days for expression "${expression}"`);
}
