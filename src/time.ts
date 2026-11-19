/**
 * Time zone arithmetic on Intl, which carries the full tz database.
 *
 * Every instant this server prints goes through formatInstant, so the model
 * always sees ISO 8601 with an explicit offset (2026-11-20T15:00:00-05:00) and
 * never has to guess which zone a bare wall time meant. Arguments travel the
 * other way: parseTimeInput, then toInstant or toWallTime in a named zone.
 */

export interface CivilDate {
  year: number;
  month: number; // 1-12
  day: number;
}

export interface WallTime extends CivilDate {
  hour: number;
  minute: number;
  second: number;
}

/** A parsed time argument: a calendar date, a wall time with no offset, or an absolute instant. */
export type TimeInput =
  | { kind: "date"; date: CivilDate }
  | { kind: "local"; wall: WallTime }
  | { kind: "instant"; instant: Date };

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Validate a zone name and return it in canonical case (Intl accepts "america/new_york"). */
export function checkTimeZone(timeZone: string, field = "timezone"): string {
  if (!isValidTimeZone(timeZone)) {
    throw new Error(`${field}: "${timeZone}" is not an IANA time zone name (e.g. America/New_York, Europe/London, Asia/Shanghai)`);
  }
  return formatter(timeZone).resolvedOptions().timeZone;
}

export function wallTimeAt(instant: Date, timeZone: string): WallTime {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of the zone from UTC at an instant, in minutes: New York in winter is -300. */
export function offsetMinutes(instant: Date, timeZone: string): number {
  const w = wallTimeAt(instant, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const wholeSeconds = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((asUtc - wholeSeconds) / 60_000);
}

function sameWall(a: WallTime, b: WallTime): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

/**
 * The instant a wall-clock time denotes in a zone.
 *
 * Offsets are sampled a day either side, which finds both readings of a time
 * repeated when clocks fall back (the earlier one wins, as in Apple Calendar)
 * and both sides of a time skipped when they spring forward (that resolves to
 * the same clock reading after the jump: 02:30 becomes 03:30).
 */
export function wallTimeToInstant(wall: WallTime, timeZone: string): Date {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const offsets = new Set<number>();
  for (const probe of [guess - DAY_MS, guess, guess + DAY_MS]) offsets.add(offsetMinutes(new Date(probe), timeZone));
  const candidates = [...offsets].map((offset) => guess - offset * 60_000).sort((a, b) => a - b);
  const exact = candidates.find((c) => sameWall(wallTimeAt(new Date(c), timeZone), wall));
  return new Date(exact ?? candidates[candidates.length - 1]);
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

export function formatCivil(d: CivilDate): string {
  return `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`;
}

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** ISO 8601 with the zone's offset at that instant: 2026-11-20T15:00:00-05:00. */
export function formatInstant(instant: Date, timeZone: string): string {
  const w = wallTimeAt(instant, timeZone);
  const time = `${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
  return `${formatCivil(w)}T${time}${formatOffset(offsetMinutes(instant, timeZone))}`;
}

/** Basic-format UTC date-time as CalDAV and iCalendar want it: 20261120T200000Z. */
export function formatUtcBasic(instant: Date): string {
  return instant.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function civilDateAt(instant: Date, timeZone: string): CivilDate {
  const { year, month, day } = wallTimeAt(instant, timeZone);
  return { year, month, day };
}

export function addDays(d: CivilDate, days: number): CivilDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

export function compareCivil(a: CivilDate, b: CivilDate): number {
  return Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day);
}

export function startOfDay(d: CivilDate, timeZone: string): Date {
  return wallTimeToInstant({ ...d, hour: 0, minute: 0, second: 0 }, timeZone);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

function checkCivil(d: CivilDate, field: string, raw: string): void {
  const daysInMonth = new Date(Date.UTC(d.year, d.month, 0)).getUTCDate();
  if (d.month < 1 || d.month > 12 || d.day < 1 || d.day > daysInMonth) {
    throw new Error(`${field}: "${raw}" is not a real calendar date`);
  }
}

/**
 * Parse a date or date-time argument. Accepts YYYY-MM-DD, a wall time
 * YYYY-MM-DDTHH:MM[:SS] (read later in a named zone), or either of those with
 * Z or a ±HH:MM offset (an absolute instant).
 */
export function parseTimeInput(raw: unknown, field: string): TimeInput {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`${field} must be a date (YYYY-MM-DD) or date-time (YYYY-MM-DDTHH:MM)`);
  }
  const value = raw.trim();
  const dateMatch = DATE_RE.exec(value);
  if (dateMatch) {
    const date = { year: Number(dateMatch[1]), month: Number(dateMatch[2]), day: Number(dateMatch[3]) };
    checkCivil(date, field, value);
    return { kind: "date", date };
  }
  const m = DATE_TIME_RE.exec(value);
  if (!m) {
    throw new Error(
      `${field}: "${value}" is not a date (YYYY-MM-DD) or date-time (YYYY-MM-DDTHH:MM, optionally with seconds and a UTC offset)`,
    );
  }
  const wall: WallTime = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: m[6] ? Number(m[6]) : 0,
  };
  checkCivil(wall, field, value);
  if (wall.hour > 23 || wall.minute > 59 || wall.second > 59) {
    throw new Error(`${field}: "${value}" has an out-of-range time of day`);
  }
  const zone = m[7];
  if (!zone) return { kind: "local", wall };
  let offset = 0;
  if (zone.toUpperCase() !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    const hours = Number(digits.slice(0, 2));
    const minutes = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
    if (hours > 23 || minutes > 59) throw new Error(`${field}: "${value}" has an invalid UTC offset`);
    offset = (zone[0] === "-" ? -1 : 1) * (hours * 60 + minutes);
  }
  const utc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - offset * 60_000;
  return { kind: "instant", instant: new Date(utc) };
}

/** The instant a time argument denotes; a bare date means the start of that day. */
export function toInstant(input: TimeInput, timeZone: string): Date {
  switch (input.kind) {
    case "instant":
      return input.instant;
    case "local":
      return wallTimeToInstant(input.wall, timeZone);
    case "date":
      return startOfDay(input.date, timeZone);
  }
}

/** The wall time a time argument denotes in a zone; a bare date means midnight. */
export function toWallTime(input: TimeInput, timeZone: string): WallTime {
  switch (input.kind) {
    case "instant":
      return wallTimeAt(input.instant, timeZone);
    case "local":
      return input.wall;
    case "date":
      return { ...input.date, hour: 0, minute: 0, second: 0 };
  }
}

/** The calendar date a time argument falls on in a zone. */
export function toCivilDate(input: TimeInput, timeZone: string): CivilDate {
  const { year, month, day } = toWallTime(input, timeZone);
  return { year, month, day };
}
