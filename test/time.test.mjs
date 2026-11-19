import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTimeZone, formatInstant, parseTimeInput, toInstant, wallTimeToInstant } from "../dist/time.js";

const NY = "America/New_York";
const wall = (year, month, day, hour, minute = 0) => ({ year, month, day, hour, minute, second: 0 });

test("formatInstant prints the zone's offset at that instant, DST included", () => {
  assert.equal(formatInstant(new Date("2026-07-01T13:00:00Z"), NY), "2026-07-01T09:00:00-04:00");
  assert.equal(formatInstant(new Date("2026-12-01T14:00:00Z"), NY), "2026-12-01T09:00:00-05:00");
  assert.equal(formatInstant(new Date("2026-12-01T14:00:00Z"), "Asia/Kolkata"), "2026-12-01T19:30:00+05:30");
  assert.equal(formatInstant(new Date("2026-12-01T14:00:00Z"), "UTC"), "2026-12-01T14:00:00+00:00");
});

test("wallTimeToInstant handles ordinary times, spring-forward gaps and fall-back overlaps", () => {
  assert.equal(wallTimeToInstant(wall(2026, 11, 20, 15), NY).toISOString(), "2026-11-20T20:00:00.000Z");
  // 02:30 does not exist in New York on 2026-03-08: it becomes 03:30 EDT.
  assert.equal(wallTimeToInstant(wall(2026, 3, 8, 2, 30), NY).toISOString(), "2026-03-08T07:30:00.000Z");
  // 01:30 happens twice on 2026-11-01: the first reading (EDT) wins.
  assert.equal(wallTimeToInstant(wall(2026, 11, 1, 1, 30), NY).toISOString(), "2026-11-01T05:30:00.000Z");
  // The same two rules east of UTC.
  assert.equal(wallTimeToInstant(wall(2026, 3, 29, 2, 30), "Europe/Berlin").toISOString(), "2026-03-29T01:30:00.000Z");
  assert.equal(wallTimeToInstant(wall(2026, 10, 25, 2, 30), "Europe/Berlin").toISOString(), "2026-10-25T00:30:00.000Z");
});

test("parseTimeInput tells dates, wall times and instants apart", () => {
  assert.deepEqual(parseTimeInput("2026-11-20", "start"), { kind: "date", date: { year: 2026, month: 11, day: 20 } });
  assert.deepEqual(parseTimeInput("2026-11-20T15:00", "start"), { kind: "local", wall: wall(2026, 11, 20, 15) });
  assert.equal(parseTimeInput("2026-11-20T15:00:00-05:00", "start").instant.toISOString(), "2026-11-20T20:00:00.000Z");
  assert.equal(parseTimeInput("2026-11-20T20:00:00.000Z", "start").instant.toISOString(), "2026-11-20T20:00:00.000Z");
  assert.equal(parseTimeInput("2026-11-20 15:00+0530", "start").instant.toISOString(), "2026-11-20T09:30:00.000Z");
});

test("parseTimeInput rejects impossible and unparseable values, naming the argument", () => {
  assert.throws(() => parseTimeInput("2026-02-30", "start"), /start: .*not a real calendar date/);
  assert.throws(() => parseTimeInput("tomorrow at noon", "end"), /end: .*is not a date/);
  assert.throws(() => parseTimeInput("2026-11-20T25:00", "start"), /out-of-range/);
  assert.throws(() => parseTimeInput(42, "start"), /start must be/);
});

test("toInstant reads wall times and bare dates in the zone it is given", () => {
  assert.equal(toInstant(parseTimeInput("2026-11-20T09:00", "x"), "Asia/Shanghai").toISOString(), "2026-11-20T01:00:00.000Z");
  assert.equal(toInstant(parseTimeInput("2026-11-20", "x"), "America/Los_Angeles").toISOString(), "2026-11-20T08:00:00.000Z");
  // An explicit offset wins over the zone.
  assert.equal(toInstant(parseTimeInput("2026-11-20T09:00Z", "x"), "Asia/Shanghai").toISOString(), "2026-11-20T09:00:00.000Z");
});

test("checkTimeZone canonicalizes case and rejects names that are not zones", () => {
  assert.equal(checkTimeZone("america/new_york"), NY);
  assert.throws(() => checkTimeZone("Mars/Olympus_Mons", "timezone"), /timezone: "Mars\/Olympus_Mons" is not an IANA time zone/);
});
