import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseCronExpression,
  isCronExpressionValid,
  isTimezoneValid,
  computeNextRun
} from "../src/services/cronExpression";

test("parseCronExpression accepts well-formed 5-field cron", () => {
  const parsed = parseCronExpression("0 9 * * 1-5");
  assert.ok(parsed.minutes.has(0));
  assert.equal(parsed.minutes.size, 1);
  assert.ok(parsed.hours.has(9));
  assert.deepEqual([...parsed.dows].sort(), [1, 2, 3, 4, 5]);
  assert.equal(parsed.domStarred, true);
  assert.equal(parsed.dowStarred, false);
});

test("parseCronExpression accepts steps and lists", () => {
  const parsed = parseCronExpression("*/15 0,12 1,15 * *");
  assert.deepEqual([...parsed.minutes].sort((a, b) => a - b), [0, 15, 30, 45]);
  assert.deepEqual([...parsed.hours].sort((a, b) => a - b), [0, 12]);
  assert.deepEqual([...parsed.doms].sort((a, b) => a - b), [1, 15]);
});

test("parseCronExpression treats 7 as Sunday", () => {
  const parsed = parseCronExpression("0 0 * * 7");
  assert.ok(parsed.dows.has(0));
});

test("isCronExpressionValid returns false on garbage", () => {
  assert.equal(isCronExpressionValid("not a cron"), false);
  assert.equal(isCronExpressionValid("60 0 * * *"), false); // minute out of range
  assert.equal(isCronExpressionValid("0 0 0 * *"), false);  // day-of-month 0 invalid
  assert.equal(isCronExpressionValid("0 0 * 13 *"), false); // month 13 invalid
  assert.equal(isCronExpressionValid("0 0 * *"), false);    // 4 fields
});

test("isTimezoneValid accepts IANA names and rejects garbage", () => {
  assert.equal(isTimezoneValid("UTC"), true);
  assert.equal(isTimezoneValid("Europe/London"), true);
  assert.equal(isTimezoneValid("America/New_York"), true);
  assert.equal(isTimezoneValid("Not/A/Real/Zone"), false);
  assert.equal(isTimezoneValid(""), false);
  assert.equal(isTimezoneValid(null), false);
});

test("computeNextRun returns the next minute matching the expression in UTC", () => {
  // 2026-05-18T12:34:56Z → next 09:00 UTC fires next day at 09:00 UTC because
  // 12:34 is already past today's 09:00.
  const from = new Date("2026-05-18T12:34:56Z");
  const next = computeNextRun("0 9 * * *", "UTC", from);
  assert.equal(next.toISOString(), "2026-05-19T09:00:00.000Z");
});

test("computeNextRun honours the schedule timezone", () => {
  // 09:00 in Europe/London on 2026-05-18 is 08:00 UTC (BST in effect).
  const from = new Date("2026-05-18T05:00:00Z");
  const next = computeNextRun("0 9 * * *", "Europe/London", from);
  assert.equal(next.toISOString(), "2026-05-18T08:00:00.000Z");
});

test("computeNextRun handles weekday filter (Mon-Fri)", () => {
  // 2026-05-16 is a Saturday → next 09:00 Mon-Fri UTC is 2026-05-18 09:00.
  const from = new Date("2026-05-16T12:00:00Z");
  const next = computeNextRun("0 9 * * 1-5", "UTC", from);
  assert.equal(next.toISOString(), "2026-05-18T09:00:00.000Z");
});

test("computeNextRun throws when called on an impossible schedule", () => {
  assert.throws(() => computeNextRun("0 0 31 2 *", "UTC", new Date("2026-01-01T00:00:00Z")));
});
