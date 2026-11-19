/**
 * iCalendar (RFC 5545) on ical.js: expanding stored events into dated
 * occurrences, describing one event in full, and writing new or changed
 * events back.
 *
 * Two ical.js behaviours shape this file:
 *
 *  - A zoned ICAL.Time does not write its TZID by itself; set as a property
 *    value it serializes as floating time, which every device then shows in
 *    its own zone. Every DTSTART, DTEND, RECURRENCE-ID and EXDATE therefore
 *    goes through setTime/addTime, which add the parameter, and
 *    helpers.updateTimezones then adds the matching VTIMEZONE.
 *  - A TZID resolves against the object's own VTIMEZONE first and the global
 *    TimezoneService second. IANA zones are registered there from
 *    timezones-ical-library, so objects that omit their VTIMEZONE still
 *    resolve, and new events get a complete definition to embed.
 */

import ICAL from "ical.js";
import { tzlib_get_ical_block } from "timezones-ical-library";
import {
  addDays,
  civilDateAt,
  compareCivil,
  formatCivil,
  formatInstant,
  formatUtcBasic,
  isValidTimeZone,
  startOfDay,
  toCivilDate,
  toInstant,
  wallTimeToInstant,
  type CivilDate,
  type TimeInput,
} from "./time.js";

type Component = InstanceType<typeof ICAL.Component>;
type Property = InstanceType<typeof ICAL.Property>;
type Time = InstanceType<typeof ICAL.Time>;
type Timezone = InstanceType<typeof ICAL.Timezone>;
type Duration = InstanceType<typeof ICAL.Duration>;

const PRODID = "-//icloud-mcp//EN";
/** Recurrence steps walked per event. A daily series that began in 1990 is ~13,000. */
const MAX_RECURRENCE_STEPS = 50_000;
const MAX_OCCURRENCES_PER_EVENT = 1_000;
const DEFAULT_DURATION_SECONDS = 3600;

export interface Attendee {
  email: string;
  name?: string;
}

/** Fields a caller may set. undefined leaves a field alone; null or "" clears it. */
export interface EventFields {
  title?: string;
  start?: TimeInput;
  /** For all-day events, the last day (inclusive). */
  end?: TimeInput;
  allDay?: boolean;
  /** IANA zone that wall-clock start/end values are read in, and the event is stored in. */
  timeZone?: string;
  location?: string | null;
  notes?: string | null;
  url?: string | null;
  /** Minutes before the start; [] removes every alert. */
  alerts?: number[];
  /** An RRULE value; null or "" makes the event single. */
  recurrence?: string | null;
  attendees?: Attendee[];
}

export interface WriteContext {
  now: Date;
  /** Zone for wall times when neither the call nor the event names one. */
  defaultTimeZone: string;
  /** Written as ORGANIZER when attendees are added to an event that has none. */
  organizer?: Attendee;
}

export interface OccurrenceRecord {
  uid: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location?: string;
  notes?: string;
  status?: string;
  recurring: boolean;
  /** RECURRENCE-ID of this instance: what update/delete take to touch only it. */
  occurrence?: string;
  organizer?: string;
  attendee_count?: number;
  url?: string;
  /** Sort and filter keys, stripped before output. */
  startMs: number;
  endMs: number;
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

const zoneAvailability = new Map<string, boolean>();

/**
 * Make an IANA zone resolvable through ICAL.TimezoneService from the bundled
 * rules. False when neither Intl nor the library knows the name.
 */
export function ensureZone(tzid: string): boolean {
  const known = zoneAvailability.get(tzid);
  if (known !== undefined) return known;
  let ok = ICAL.TimezoneService.has(tzid);
  // Ask Intl first: the library writes to the console for names it does not know.
  if (!ok && isValidTimeZone(tzid)) {
    const out = tzlib_get_ical_block(tzid);
    const block = Array.isArray(out) ? out[0] : "";
    if (block && block.includes("BEGIN:VTIMEZONE")) {
      const wrapped = new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\n${block}\r\nEND:VCALENDAR`) as unknown[]);
      const vtimezone = wrapped.getFirstSubcomponent("vtimezone");
      if (vtimezone) {
        ICAL.TimezoneService.register(vtimezone);
        ok = true;
      }
    }
  }
  zoneAvailability.set(tzid, ok);
  return ok;
}

function zoneFor(tzid: string): Timezone | null {
  return ensureZone(tzid) ? ICAL.TimezoneService.get(tzid) : null;
}

function isFloating(t: Time): boolean {
  return !t.isDate && (!t.zone || t.zone === ICAL.Timezone.localTimezone || t.zone.tzid === "floating");
}

function isUtc(t: Time): boolean {
  return !t.isDate && t.zone === ICAL.Timezone.utcTimezone;
}

/** The TZID a stored time is written in, or "UTC"/"floating"; undefined for dates. */
function zoneLabel(t: Time): string | undefined {
  if (t.isDate) return undefined;
  if (isFloating(t)) return "floating";
  if (isUtc(t)) return "UTC";
  return t.zone.tzid;
}

function civilOf(t: Time): CivilDate {
  return { year: t.year, month: t.month, day: t.day };
}

/** The instant a stored time denotes. Dates and floating times are read as wall time in `zone`. */
export function instantOf(t: Time, zone: string): Date {
  if (t.isDate) return startOfDay(civilOf(t), zone);
  if (isFloating(t)) {
    return wallTimeToInstant(
      { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second },
      zone,
    );
  }
  return new Date(t.toUnixTime() * 1000);
}

function render(t: Time, zone: string): string {
  return t.isDate ? formatCivil(civilOf(t)) : formatInstant(instantOf(t, zone), zone);
}

function dateValue(d: CivilDate): Time {
  return ICAL.Time.fromDateString(formatCivil(d));
}

function utcValue(instant: Date): Time {
  return ICAL.Time.fromJSDate(instant, true);
}

/** Set a date/date-time property with its TZID parameter (see the file comment). */
function setTime(comp: Component, name: string, t: Time): void {
  comp.removeAllProperties(name);
  addTime(comp, name, t);
}

function addTime(comp: Component, name: string, t: Time): void {
  const prop = comp.addPropertyWithValue(name, t);
  if (!t.isDate && !isFloating(t) && !isUtc(t)) prop.setParameter("tzid", t.zone.tzid);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ParsedObject {
  vcal: Component;
  /** The VEVENT without RECURRENCE-ID; null when the object holds only instances. */
  master: Component | null;
  /** VEVENTs that override one instance of the master's recurrence. */
  overrides: Component[];
}

export function parseObject(ics: string): ParsedObject {
  // ical.js resolves a TZID when it first reads a value, so register zones up front.
  for (const match of ics.matchAll(/TZID=(?:"([^"]+)"|([^;:\r\n]+))/g)) ensureZone(match[1] ?? match[2]);
  let vcal: Component;
  try {
    let jcal = ICAL.parse(ics) as unknown[];
    if (Array.isArray(jcal[0])) jcal = jcal[0] as unknown[];
    vcal = new ICAL.Component(jcal);
  } catch (err) {
    throw new Error(`Unreadable iCalendar data: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (vcal.name !== "vcalendar") throw new Error("Not an iCalendar object (no VCALENDAR)");
  const events = vcal.getAllSubcomponents("vevent");
  const master = events.find((e) => !e.hasProperty("recurrence-id")) ?? null;
  const overrides = events.filter((e) => e.hasProperty("recurrence-id"));
  if (!master && overrides.length === 0) throw new Error("The calendar object holds no event");
  return { vcal, master, overrides };
}

function text(comp: Component, name: string): string | undefined {
  const value = comp.getFirstPropertyValue(name);
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  return s || undefined;
}

function timeValue(comp: Component, name: string): Time | null {
  const value = comp.getFirstPropertyValue(name);
  return value instanceof ICAL.Time ? value : null;
}

function isRecurring(vevent: Component): boolean {
  return vevent.hasProperty("rrule") || vevent.hasProperty("rdate");
}

interface Span {
  start: Time;
  end: Time;
}

/** DTSTART and the effective end: DTEND, else DTSTART + DURATION, else one day for dates and nothing for times (RFC 5545 3.6.1). */
function spanOf(vevent: Component): Span {
  const start = timeValue(vevent, "dtstart");
  if (!start) throw new Error("The event has no start time (DTSTART)");
  let end = timeValue(vevent, "dtend");
  if (!end) {
    end = start.clone();
    const duration = vevent.getFirstPropertyValue("duration");
    if (duration instanceof ICAL.Duration) end.addDuration(duration);
    else if (start.isDate) end.adjust(1, 0, 0, 0);
  }
  return { start, end };
}

function durationOf(span: Span): Duration {
  return span.start.isDate ? span.end.subtractDate(span.start) : span.end.subtractDateTz(span.start);
}

/** The last day an all-day event covers. DTEND is exclusive, so the day before it, but never before the start. */
function lastDay(start: Time, end: Time): CivilDate {
  const last = addDays(civilOf(end), -1);
  return compareCivil(last, civilOf(start)) < 0 ? civilOf(start) : last;
}

function sameSlot(a: Time | null, b: Time, zone: string): boolean {
  return !!a && instantOf(a, zone).getTime() === instantOf(b, zone).getTime();
}

function toRecord(
  item: Component,
  start: Time,
  end: Time,
  recurrenceId: Time | undefined,
  recurring: boolean,
  zone: string,
): OccurrenceRecord {
  const allDay = start.isDate;
  const startMs = instantOf(start, zone).getTime();
  const endMs = Math.max(startMs, instantOf(end, zone).getTime());
  const status = text(item, "status")?.toUpperCase();
  const attendees = item.getAllProperties("attendee").length;
  return {
    uid: text(item, "uid") ?? "",
    title: text(item, "summary") ?? "(no title)",
    start: render(start, zone),
    end: allDay ? formatCivil(lastDay(start, end)) : render(end, zone),
    all_day: allDay,
    location: text(item, "location"),
    notes: text(item, "description"),
    status: status && status !== "CONFIRMED" ? status.toLowerCase() : undefined,
    recurring,
    occurrence: recurring && recurrenceId ? render(recurrenceId, zone) : undefined,
    organizer: text(item, "organizer")?.replace(/^mailto:/i, ""),
    attendee_count: attendees || undefined,
    url: text(item, "url"),
    startMs,
    endMs,
  };
}

function overlaps(r: { startMs: number; endMs: number }, range: { start: Date; end: Date }): boolean {
  const from = range.start.getTime();
  const to = range.end.getTime();
  // A zero-length event belongs to the range it starts in.
  if (r.endMs === r.startMs) return r.startMs >= from && r.startMs < to;
  return r.startMs < to && r.endMs > from;
}

/**
 * Every occurrence of the object's event that overlaps the range, recurring
 * series expanded, moved instances at their new time, cancelled ones dropped.
 */
export function expandObject(ics: string, range: { start: Date; end: Date }, zone: string): OccurrenceRecord[] {
  const { master, overrides } = parseObject(ics);
  const out: OccurrenceRecord[] = [];
  const consider = (item: Component, start: Time, end: Time, recurrenceId: Time | undefined, recurring: boolean) => {
    if (text(item, "status")?.toUpperCase() === "CANCELLED") return;
    const record = toRecord(item, start, end, recurrenceId, recurring, zone);
    if (overlaps(record, range)) out.push(record);
  };

  if (!master) {
    // Invited to single instances of someone else's series: each stands alone.
    for (const o of overrides) {
      const { start, end } = spanOf(o);
      consider(o, start, end, undefined, false);
    }
    return out;
  }

  if (!isRecurring(master)) {
    const { start, end } = spanOf(master);
    consider(master, start, end, undefined, false);
    return out;
  }

  const event = new ICAL.Event(master, { exceptions: overrides });
  const iterator = event.iterator();
  const overridden = new Set(overrides.map((o) => timeValue(o, "recurrence-id")?.toString()).filter(Boolean));
  const visited = new Set<string>();
  const from = range.start.getTime();
  const to = range.end.getTime();
  const durationMs = durationOf(spanOf(master)).toSeconds() * 1000;
  for (let step = 0; step < MAX_RECURRENCE_STEPS && out.length < MAX_OCCURRENCES_PER_EVENT; step++) {
    const slot = iterator.next();
    if (!slot) break;
    const slotMs = instantOf(slot, zone).getTime();
    if (slotMs >= to) break;
    const key = slot.toString();
    // Walking a long series from its first instance is most of the cost: skip
    // instances that end before the range without building their details,
    // unless an override may have moved them into it.
    const endsBefore = durationMs === 0 ? slotMs < from : slotMs + durationMs <= from;
    if (endsBefore && !overridden.has(key)) continue;
    const details = event.getOccurrenceDetails(slot);
    visited.add(key);
    consider(details.item.component, details.startDate, details.endDate, details.recurrenceId, true);
  }
  // An override can move an instance from a slot after the range into it.
  for (const o of overrides) {
    const recurrenceId = timeValue(o, "recurrence-id");
    if (!recurrenceId || visited.has(recurrenceId.toString())) continue;
    if (instantOf(recurrenceId, zone) < range.end) continue;
    const { start, end } = spanOf(o);
    consider(o, start, end, recurrenceId, true);
  }
  return out;
}

function person(prop: Property | null): Record<string, string> | undefined {
  if (!prop) return undefined;
  const email = String(prop.getFirstValue() ?? "").replace(/^mailto:/i, "");
  const out: Record<string, string> = { email };
  const name = prop.getParameter("cn");
  if (name) out.name = String(name);
  const partstat = prop.getParameter("partstat");
  if (partstat) out.response = String(partstat).toLowerCase() === "needs-action" ? "no response yet" : String(partstat).toLowerCase();
  if (prop.getParameter("role") === "OPT-PARTICIPANT") out.role = "optional";
  return out;
}

function alerts(vevent: Component, zone: string): Array<Record<string, unknown>> {
  return vevent.getAllSubcomponents("valarm").map((alarm) => {
    const trigger = alarm.getFirstProperty("trigger");
    const value = trigger?.getFirstValue();
    const action = (text(alarm, "action") ?? "DISPLAY").toLowerCase();
    if (value instanceof ICAL.Duration) {
      const out: Record<string, unknown> = { minutes_before: Math.round(-value.toSeconds() / 60), action };
      if (trigger?.getParameter("related") === "END") out.relative_to = "end";
      return out;
    }
    if (value instanceof ICAL.Time) return { at: render(value, zone), action };
    return { action };
  });
}

function describeComponent(vevent: Component, zone: string): Record<string, unknown> {
  const { start, end } = spanOf(vevent);
  const allDay = start.isDate;
  const status = text(vevent, "status")?.toLowerCase();
  const attendees = vevent.getAllProperties("attendee").map(person);
  return {
    title: text(vevent, "summary") ?? "(no title)",
    start: render(start, zone),
    end: allDay ? formatCivil(lastDay(start, end)) : render(end, zone),
    all_day: allDay,
    stored_time_zone: zoneLabel(start),
    location: text(vevent, "location"),
    notes: text(vevent, "description"),
    url: text(vevent, "url"),
    status: status && status !== "confirmed" ? status : undefined,
    availability: text(vevent, "transp")?.toUpperCase() === "TRANSPARENT" ? "free" : "busy",
    alerts: alerts(vevent, zone),
    organizer: person(vevent.getFirstProperty("organizer")),
    attendees: attendees.length ? attendees : undefined,
  };
}

/** One event in full: the series (or single event) plus its exceptions. */
export function describeObject(ics: string, zone: string): Record<string, unknown> {
  const { master, overrides } = parseObject(ics);
  const main = master ?? overrides[0];
  const rrule = main.getFirstPropertyValue("rrule");
  const excluded = main
    .getAllProperties("exdate")
    .flatMap((p) => p.getValues())
    .filter((v): v is Time => v instanceof ICAL.Time)
    .map((t) => render(t, zone));
  const modified = master
    ? overrides.map((o) => {
        const recurrenceId = timeValue(o, "recurrence-id");
        return { occurrence: recurrenceId ? render(recurrenceId, zone) : undefined, ...describeComponent(o, zone) };
      })
    : [];
  const created = timeValue(main, "created");
  const lastModified = timeValue(main, "last-modified");
  return {
    uid: text(main, "uid"),
    ...describeComponent(main, zone),
    recurrence: rrule ? String(rrule) : undefined,
    excluded_occurrences: excluded.length ? excluded : undefined,
    modified_occurrences: modified.length ? modified : undefined,
    created: created ? render(created, zone) : undefined,
    last_modified: lastModified ? render(lastModified, zone) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const FREQ_RE = /(^|;)FREQ=(SECONDLY|MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)(;|$)/;

/**
 * Validate an RRULE and make UNTIL match DTSTART's type (RFC 5545 3.3.10): a
 * date for all-day events, a UTC date-time otherwise. A bare UNTIL date on a
 * timed event means through the end of that day in the event's zone.
 */
export function normalizeRrule(raw: string, allDay: boolean, zone: string): string {
  let rule = raw.trim().replace(/^RRULE:/i, "").toUpperCase();
  if (!FREQ_RE.test(rule)) {
    throw new Error(
      `recurrence "${raw}" needs FREQ, e.g. FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10 or FREQ=MONTHLY;UNTIL=20271231`,
    );
  }
  if (/(^|;)UNTIL=/.test(rule) && /(^|;)COUNT=/.test(rule)) {
    throw new Error(`recurrence "${raw}" has both COUNT and UNTIL; use one`);
  }
  rule = rule.replace(/(^|;)UNTIL=([^;]+)/, (_all, sep: string, until: string) => {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(until.replace(/[-:]/g, ""));
    if (!m) throw new Error(`recurrence "${raw}": UNTIL must be a date like 20271231`);
    const date = `${m[1]}${m[2]}${m[3]}`;
    if (allDay) return `${sep}UNTIL=${date}`;
    if (m[7]) return `${sep}UNTIL=${date}T${m[4]}${m[5]}${m[6] ?? "00"}Z`;
    const civil = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
    const wall = m[4]
      ? { ...civil, hour: Number(m[4]), minute: Number(m[5]), second: m[6] ? Number(m[6]) : 0 }
      : { ...civil, hour: 23, minute: 59, second: 59 };
    return `${sep}UNTIL=${formatUtcBasic(wallTimeToInstant(wall, zone))}`;
  });
  try {
    ICAL.Recur.fromString(rule);
  } catch (err) {
    throw new Error(`recurrence "${raw}": ${err instanceof Error ? err.message : String(err)}`);
  }
  return rule;
}

interface WriteZone {
  /** The zone values are written in; null when no VTIMEZONE is available, so values go out as UTC. */
  zone: Timezone | null;
  /** IANA name used to read wall times when `zone` is null, and for RRULE UNTIL. */
  name: string;
}

function writeZone(timeZone: string | undefined, current: Span | undefined, ctx: WriteContext): WriteZone {
  if (timeZone) return { zone: zoneFor(timeZone), name: timeZone };
  const s = current?.start;
  if (s && !s.isDate && !isFloating(s) && !isUtc(s)) {
    return { zone: s.zone, name: isValidTimeZone(s.zone.tzid) ? s.zone.tzid : ctx.defaultTimeZone };
  }
  return { zone: zoneFor(ctx.defaultTimeZone), name: ctx.defaultTimeZone };
}

function timedValue(input: TimeInput, target: WriteZone): Time {
  if (target.zone) {
    if (input.kind === "local") return ICAL.Time.fromData({ ...input.wall, isDate: false }, target.zone);
    return utcValue(toInstant(input, target.name)).convertToZone(target.zone);
  }
  return utcValue(toInstant(input, target.name));
}

function timedLabel(t: Time, zone: string): string {
  return formatInstant(instantOf(t, zone), zone);
}

/** New DTSTART and DTEND (exclusive, as stored) from the changed fields and the event's current span. */
function planSchedule(fields: EventFields, current: Span | undefined, ctx: WriteContext): Span {
  const wasAllDay = current?.start.isDate ?? false;
  const allDay = fields.allDay ?? (current ? wasAllDay : fields.start?.kind === "date");

  if (allDay) {
    const zone = fields.timeZone ?? ctx.defaultTimeZone;
    let first: CivilDate;
    if (fields.start) first = toCivilDate(fields.start, zone);
    else if (current) first = wasAllDay ? civilOf(current.start) : civilDateAt(instantOf(current.start, zone), zone);
    else throw new Error("start is required");
    let last: CivilDate;
    if (fields.end) {
      last = toCivilDate(fields.end, zone);
    } else if (current && wasAllDay) {
      // Keep the number of days when only the start moves.
      const days = Math.round(compareCivil(lastDay(current.start, current.end), civilOf(current.start)) / 86_400_000);
      last = addDays(first, days);
    } else {
      last = first;
    }
    if (compareCivil(last, first) < 0) {
      throw new Error(`end (${formatCivil(last)}) is before start (${formatCivil(first)})`);
    }
    return { start: dateValue(first), end: dateValue(addDays(last, 1)) };
  }

  if (fields.start?.kind === "date") {
    throw new Error(`start "${formatCivil(fields.start.date)}" has no time of day: give YYYY-MM-DDTHH:MM, or set all_day`);
  }
  if (fields.end?.kind === "date") {
    throw new Error(`end "${formatCivil(fields.end.date)}" has no time of day: give YYYY-MM-DDTHH:MM`);
  }
  const target = writeZone(fields.timeZone, current, ctx);
  let start: Time;
  if (fields.start) start = timedValue(fields.start, target);
  else if (current && !wasAllDay) start = timedValue({ kind: "instant", instant: instantOf(current.start, target.name) }, target);
  else if (current) throw new Error("Changing an all-day event to a timed one needs a start time");
  else throw new Error("start is required");

  let end: Time;
  if (fields.end) {
    end = timedValue(fields.end, target);
  } else {
    const seconds = current && !wasAllDay ? Math.max(0, durationOf(current).toSeconds()) : DEFAULT_DURATION_SECONDS;
    end = start.clone();
    end.addDuration(ICAL.Duration.fromSeconds(seconds));
  }
  if (instantOf(end, target.name) < instantOf(start, target.name)) {
    throw new Error(`end (${timedLabel(end, target.name)}) is before start (${timedLabel(start, target.name)})`);
  }
  return { start, end };
}

function setText(comp: Component, name: string, value: string | null | undefined): void {
  if (value === undefined) return;
  if (value === null || value.trim() === "") comp.removeAllProperties(name);
  else comp.updatePropertyWithValue(name, value);
}

function alarm(minutesBefore: number): Component {
  const valarm = new ICAL.Component("valarm");
  valarm.addPropertyWithValue("action", "DISPLAY");
  valarm.addPropertyWithValue("description", "Reminder");
  valarm.addPropertyWithValue("trigger", ICAL.Duration.fromSeconds(-Math.round(minutesBefore) * 60));
  return valarm;
}

function setAttendees(vevent: Component, attendees: Attendee[], ctx: WriteContext): void {
  const existing = new Map<string, Property>();
  for (const p of vevent.getAllProperties("attendee")) {
    existing.set(String(p.getFirstValue() ?? "").replace(/^mailto:/i, "").toLowerCase(), p);
  }
  vevent.removeAllProperties("attendee");
  if (attendees.length === 0) {
    vevent.removeAllProperties("organizer");
    return;
  }
  if (!vevent.hasProperty("organizer") && ctx.organizer) {
    const organizer = vevent.addPropertyWithValue("organizer", `mailto:${ctx.organizer.email}`);
    if (ctx.organizer.name) organizer.setParameter("cn", ctx.organizer.name);
  }
  for (const a of attendees) {
    const kept = existing.get(a.email.toLowerCase());
    if (kept) {
      // Keep the attendee's response.
      vevent.addProperty(kept);
      continue;
    }
    const p = vevent.addPropertyWithValue("attendee", `mailto:${a.email}`);
    if (a.name) p.setParameter("cn", a.name);
    p.setParameter("cutype", "INDIVIDUAL");
    p.setParameter("role", "REQ-PARTICIPANT");
    p.setParameter("partstat", "NEEDS-ACTION");
    p.setParameter("rsvp", "TRUE");
  }
}

function applyFields(vevent: Component, fields: EventFields, schedule: Span | null, ctx: WriteContext): void {
  if (fields.title !== undefined) {
    const title = fields.title.trim();
    if (!title) throw new Error("title cannot be empty");
    vevent.updatePropertyWithValue("summary", title);
  }
  if (schedule) {
    setTime(vevent, "dtstart", schedule.start);
    setTime(vevent, "dtend", schedule.end);
    vevent.removeAllProperties("duration");
  }
  if (fields.location !== undefined) {
    // Apple pins a map to the old place through this property; drop it with the text it described.
    vevent.removeAllProperties("x-apple-structured-location");
    setText(vevent, "location", fields.location);
  }
  setText(vevent, "description", fields.notes);
  setText(vevent, "url", fields.url);
  if (fields.alerts !== undefined) {
    for (const old of vevent.getAllSubcomponents("valarm")) vevent.removeSubcomponent(old);
    for (const minutes of fields.alerts) vevent.addSubcomponent(alarm(minutes));
  }
  if (fields.attendees !== undefined) setAttendees(vevent, fields.attendees, ctx);
}

function touch(vevent: Component, now: Date): void {
  const sequence = Number(vevent.getFirstPropertyValue("sequence") ?? 0);
  vevent.updatePropertyWithValue("sequence", Number.isFinite(sequence) ? sequence + 1 : 1);
  vevent.updatePropertyWithValue("dtstamp", utcValue(now));
  vevent.updatePropertyWithValue("last-modified", utcValue(now));
}

function serialize(vcal: Component): string {
  ICAL.helpers.updateTimezones(vcal);
  return `${vcal.toString()}\r\n`;
}

function ruleZone(schedule: Span, fields: EventFields, ctx: WriteContext): string {
  const label = zoneLabel(schedule.start);
  if (fields.timeZone) return fields.timeZone;
  return label && isValidTimeZone(label) ? label : ctx.defaultTimeZone;
}

/** A complete VCALENDAR for a new event. */
export function buildEvent(fields: EventFields, ctx: WriteContext & { uid: string }): string {
  if (!fields.title?.trim()) throw new Error("title is required");
  if (!fields.start) throw new Error("start is required");
  const vcal = new ICAL.Component(["vcalendar", [], []]);
  vcal.updatePropertyWithValue("prodid", PRODID);
  vcal.updatePropertyWithValue("version", "2.0");
  vcal.updatePropertyWithValue("calscale", "GREGORIAN");
  const vevent = new ICAL.Component("vevent");
  vcal.addSubcomponent(vevent);
  const stamp = utcValue(ctx.now);
  vevent.updatePropertyWithValue("uid", ctx.uid);
  vevent.updatePropertyWithValue("dtstamp", stamp);
  vevent.updatePropertyWithValue("created", stamp);
  vevent.updatePropertyWithValue("last-modified", stamp);
  vevent.updatePropertyWithValue("sequence", 0);
  const schedule = planSchedule(fields, undefined, ctx);
  applyFields(vevent, fields, schedule, ctx);
  if (fields.recurrence) {
    const rule = normalizeRrule(fields.recurrence, schedule.start.isDate, ruleZone(schedule, fields, ctx));
    vevent.updatePropertyWithValue("rrule", ICAL.Recur.fromString(rule));
  }
  return serialize(vcal);
}

/** Find the recurrence slot an occurrence argument names: its original start (RECURRENCE-ID). */
function findSlot(master: Component, occurrence: TimeInput, zone: string): Time {
  const iterator = new ICAL.Event(master).iterator();
  const wantDate = occurrence.kind === "date" ? occurrence.date : null;
  const wantMs = occurrence.kind === "date" ? NaN : toInstant(occurrence, zone).getTime();
  for (let step = 0; step < MAX_RECURRENCE_STEPS; step++) {
    const slot = iterator.next();
    if (!slot) break;
    if (wantDate || slot.isDate) {
      const want = wantDate ?? civilDateAt(new Date(wantMs), zone);
      const day = slot.isDate ? civilOf(slot) : civilDateAt(instantOf(slot, zone), zone);
      const cmp = compareCivil(day, want);
      if (cmp === 0) return slot;
      if (cmp > 0) break;
    } else {
      const ms = instantOf(slot, zone).getTime();
      if (Math.abs(ms - wantMs) < 1000) return slot;
      if (ms > wantMs) break;
    }
  }
  const label = wantDate ? formatCivil(wantDate) : formatInstant(new Date(wantMs), zone);
  throw new Error(
    `This event has no occurrence at ${label}. Pass the "occurrence" value exactly as icloud_calendar_list_events returned it; an instance that was already deleted cannot be changed.`,
  );
}

/** A new override for one instance: a copy of the master without its recurrence, at that instance's time. */
function createOverride(vcal: Component, master: Component, slot: Time): Component {
  const override = new ICAL.Component(structuredClone(master.toJSON()));
  for (const name of ["rrule", "rdate", "exdate", "recurrence-id", "duration"]) override.removeAllProperties(name);
  const end = slot.clone();
  end.addDuration(durationOf(spanOf(master)));
  setTime(override, "recurrence-id", slot);
  setTime(override, "dtstart", slot.clone());
  setTime(override, "dtend", end);
  vcal.addSubcomponent(override);
  return override;
}

export interface UpdateResult {
  ics: string;
  /** What changed, described the way get_event would. */
  changed: Record<string, unknown>;
  scope: "series" | "event" | "occurrence";
}

/**
 * Apply changes to the whole event, or with `occurrence` to one instance of a
 * recurring series, which becomes (or already is) an override.
 */
export function updateEvent(ics: string, fields: EventFields, ctx: WriteContext & { occurrence?: TimeInput }): UpdateResult {
  const { vcal, master, overrides } = parseObject(ics);
  const zone = ctx.defaultTimeZone;
  let target: Component;
  let scope: UpdateResult["scope"];

  if (ctx.occurrence) {
    if (!master || !isRecurring(master)) {
      throw new Error("occurrence was given, but this event does not repeat: leave occurrence out to change it");
    }
    if (fields.recurrence !== undefined) throw new Error("recurrence belongs to the whole series: leave occurrence out to change it");
    if (fields.allDay !== undefined && fields.allDay !== spanOf(master).start.isDate) {
      throw new Error("One occurrence cannot switch between all-day and timed");
    }
    const slot = findSlot(master, ctx.occurrence, zone);
    target = overrides.find((o) => sameSlot(timeValue(o, "recurrence-id"), slot, zone)) ?? createOverride(vcal, master, slot);
    scope = "occurrence";
  } else {
    if (master) target = master;
    else if (overrides.length === 1) target = overrides[0];
    else throw new Error("This object holds several unrelated instances; change them one by one in Apple Calendar");
    if (fields.allDay !== undefined && isRecurring(target) && fields.allDay !== spanOf(target).start.isDate) {
      throw new Error("A recurring event cannot switch between all-day and timed: delete it and create a new one");
    }
    scope = isRecurring(target) ? "series" : "event";
  }

  const timesChange =
    fields.start !== undefined || fields.end !== undefined || fields.allDay !== undefined || fields.timeZone !== undefined;
  const schedule = timesChange ? planSchedule(fields, spanOf(target), ctx) : null;
  applyFields(target, fields, schedule, ctx);

  if (fields.recurrence !== undefined) {
    if (fields.recurrence === null || fields.recurrence.trim() === "") {
      for (const name of ["rrule", "rdate", "exdate"]) target.removeAllProperties(name);
      for (const o of overrides) vcal.removeSubcomponent(o);
    } else {
      const span = spanOf(target);
      const rule = normalizeRrule(fields.recurrence, span.start.isDate, ruleZone(span, fields, ctx));
      target.updatePropertyWithValue("rrule", ICAL.Recur.fromString(rule));
    }
  }

  touch(target, ctx.now);
  const out = serialize(vcal);
  const changed = describeComponent(target, zone);
  if (scope === "occurrence") {
    const recurrenceId = timeValue(target, "recurrence-id");
    if (recurrenceId) changed.occurrence = render(recurrenceId, zone);
  } else {
    const rrule = target.getFirstPropertyValue("rrule");
    if (rrule) changed.recurrence = String(rrule);
  }
  return { ics: out, changed, scope };
}

/** Drop one instance of a recurring series: an EXDATE on the master, and no override for that slot. */
export function cancelOccurrence(ics: string, occurrence: TimeInput, ctx: WriteContext): { ics: string; title: string; occurrence: string } {
  const { vcal, master, overrides } = parseObject(ics);
  if (!master || !isRecurring(master)) {
    throw new Error("This event does not repeat: delete it without occurrence");
  }
  const zone = ctx.defaultTimeZone;
  const slot = findSlot(master, occurrence, zone);
  addTime(master, "exdate", slot);
  for (const o of overrides) {
    if (sameSlot(timeValue(o, "recurrence-id"), slot, zone)) vcal.removeSubcomponent(o);
  }
  touch(master, ctx.now);
  return { ics: serialize(vcal), title: text(master, "summary") ?? "(no title)", occurrence: render(slot, zone) };
}

/** Title and UID of an object, for confirmations. */
export function summarizeObject(ics: string): { uid?: string; title: string; recurring: boolean } {
  const { master, overrides } = parseObject(ics);
  const main = master ?? overrides[0];
  return { uid: text(main, "uid"), title: text(main, "summary") ?? "(no title)", recurring: !!master && isRecurring(master) };
}
