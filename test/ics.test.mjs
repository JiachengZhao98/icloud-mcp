import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEvent,
  cancelOccurrence,
  describeObject,
  expandObject,
  normalizeRrule,
  parseObject,
  updateEvent,
} from "../dist/ics.js";
import { parseTimeInput } from "../dist/time.js";
import { FLOATING, MOVED_EARLIER, PARIS_NO_VTIMEZONE, STANDUP, TRIP } from "./fixtures.mjs";

const NY = "America/New_York";
const range = (start, end) => ({ start: new Date(start), end: new Date(end) });
const t = (value) => parseTimeInput(value, "test");
const ctx = { now: new Date("2026-11-18T17:00:00Z"), defaultTimeZone: NY };

test("a recurring series expands with exclusions, moved instances and cancellations applied", () => {
  const occurrences = expandObject(STANDUP, range("2026-11-01T00:00:00Z", "2027-01-01T00:00:00Z"), NY);
  assert.deepEqual(
    occurrences.map((o) => [o.start, o.end, o.title, o.occurrence]),
    [
      ["2026-11-02T09:00:00-05:00", "2026-11-02T09:30:00-05:00", "Standup", "2026-11-02T09:00:00-05:00"],
      // Nov 9 is an EXDATE; Nov 16 is moved; Nov 23 is cancelled.
      ["2026-11-16T14:00:00-05:00", "2026-11-16T14:30:00-05:00", "Standup (moved)", "2026-11-16T09:00:00-05:00"],
      ["2026-11-30T09:00:00-05:00", "2026-11-30T09:30:00-05:00", "Standup", "2026-11-30T09:00:00-05:00"],
      ["2026-12-07T09:00:00-05:00", "2026-12-07T09:30:00-05:00", "Standup", "2026-12-07T09:00:00-05:00"],
    ],
  );
  assert.ok(occurrences.every((o) => o.recurring && o.uid === "standup-1" && !o.all_day));
});

test("expansion is clipped to the range and uses the moved time, not the original slot", () => {
  const inRange = expandObject(STANDUP, range("2026-11-16T18:00:00Z", "2026-11-16T20:00:00Z"), NY);
  assert.deepEqual(inRange.map((o) => o.title), ["Standup (moved)"]);
  // 09:00 on Nov 16 was the original slot; nothing happens then any more.
  assert.deepEqual(expandObject(STANDUP, range("2026-11-16T14:00:00Z", "2026-11-16T15:00:00Z"), NY), []);
});

test("an instance moved earlier from a slot after the range still shows up in it", () => {
  const found = expandObject(MOVED_EARLIER, range("2026-11-25T05:00:00Z", "2026-11-26T05:00:00Z"), NY);
  assert.deepEqual(found.map((o) => [o.title, o.start, o.occurrence]), [
    ["Book club (early)", "2026-11-25T19:00:00-05:00", "2026-12-10T19:00:00-05:00"],
  ]);
});

test("all-day events report dates with an inclusive last day, and overlap by whole days", () => {
  const [trip] = expandObject(TRIP, range("2026-12-26T05:00:00Z", "2026-12-27T05:00:00Z"), NY);
  assert.equal(trip.start, "2026-12-24");
  assert.equal(trip.end, "2026-12-26");
  assert.equal(trip.all_day, true);
  assert.equal(trip.notes, "Flights booked, hotel TBD");
  assert.deepEqual(expandObject(TRIP, range("2026-12-27T05:00:00Z", "2026-12-28T05:00:00Z"), NY), []);
});

test("floating times are read in the viewer's zone; a TZID without VTIMEZONE resolves from the bundled rules", () => {
  const [ny] = expandObject(FLOATING, range("2026-11-19T00:00:00Z", "2026-11-22T00:00:00Z"), NY);
  assert.equal(ny.start, "2026-11-20T10:00:00-05:00");
  const [tokyo] = expandObject(FLOATING, range("2026-11-19T00:00:00Z", "2026-11-22T00:00:00Z"), "Asia/Tokyo");
  assert.equal(tokyo.start, "2026-11-20T10:00:00+09:00");
  const [paris] = expandObject(PARIS_NO_VTIMEZONE, range("2026-11-19T00:00:00Z", "2026-11-22T00:00:00Z"), NY);
  assert.equal(paris.start, "2026-11-20T04:00:00-05:00"); // 10:00 CET
  assert.equal(paris.organizer, "ana@example.com");
  assert.equal(paris.attendee_count, 2);
});

test("describeObject lists the rule, exclusions, modified instances, alerts and attendees", () => {
  const detail = describeObject(STANDUP, NY);
  assert.equal(detail.uid, "standup-1");
  // ical.js prints the parts in its own order; the rule is the stored one.
  assert.equal(detail.recurrence, "FREQ=WEEKLY;COUNT=6;BYDAY=MO");
  assert.equal(detail.stored_time_zone, NY);
  assert.deepEqual(detail.excluded_occurrences, ["2026-11-09T09:00:00-05:00"]);
  assert.deepEqual(
    detail.modified_occurrences.map((m) => [m.occurrence, m.start, m.status]),
    [
      ["2026-11-16T09:00:00-05:00", "2026-11-16T14:00:00-05:00", undefined],
      ["2026-11-23T09:00:00-05:00", "2026-11-23T09:00:00-05:00", "cancelled"],
    ],
  );
  assert.deepEqual(detail.alerts, [{ minutes_before: 10, action: "display" }]);
  const paris = describeObject(PARIS_NO_VTIMEZONE, NY);
  assert.deepEqual(paris.attendees, [
    { email: "ana@example.com", name: "Ana", response: "accepted" },
    { email: "me@icloud.com", name: "Me", response: "no response yet" },
  ]);
});

test("buildEvent writes the TZID and its VTIMEZONE, so the time means the same on every device", () => {
  const ics = buildEvent(
    { title: "Dentist", start: t("2026-11-20T15:00"), alerts: [30], location: "12 Main St, Springfield", notes: "Bring forms" },
    { ...ctx, uid: "U-1" },
  );
  assert.match(ics, /\r\nDTSTART;TZID=America\/New_York:20261120T150000\r\n/);
  assert.match(ics, /\r\nDTEND;TZID=America\/New_York:20261120T160000\r\n/); // one hour by default
  assert.match(ics, /BEGIN:VTIMEZONE\r\nTZID:America\/New_York\r\n/);
  assert.match(ics, /\r\nTRIGGER:-PT30M\r\n/);
  assert.match(ics, /\r\nLOCATION:12 Main St\\, Springfield\r\n/);
  assert.match(ics, /\r\nUID:U-1\r\n/);
  assert.match(ics, /\r\nDTSTAMP:20261118T170000Z\r\n/);
  // Read back in a zone far away, the instant is unchanged.
  const [back] = expandObject(ics, range("2026-11-20T00:00:00Z", "2026-11-21T00:00:00Z"), "Asia/Tokyo");
  assert.equal(back.start, "2026-11-21T05:00:00+09:00");
});

test("buildEvent: all-day events take an inclusive last day; instants are stored in the requested zone", () => {
  const trip = buildEvent({ title: "Trip", start: t("2026-12-24"), end: t("2026-12-26") }, { ...ctx, uid: "U-2" });
  assert.match(trip, /DTSTART;VALUE=DATE:20261224\r\n/);
  assert.match(trip, /DTEND;VALUE=DATE:20261227\r\n/);
  assert.doesNotMatch(trip, /VTIMEZONE/);
  const london = buildEvent(
    { title: "Call", start: t("2026-11-20T20:00:00Z"), end: t("2026-11-20T20:45:00Z"), timeZone: "Europe/London" },
    { ...ctx, uid: "U-3" },
  );
  assert.match(london, /DTSTART;TZID=Europe\/London:20261120T200000/);
  assert.match(london, /DTEND;TZID=Europe\/London:20261120T204500/);
});

test("buildEvent rejects backwards ranges and timed events without a time", () => {
  assert.throws(
    () => buildEvent({ title: "x", start: t("2026-11-20T15:00"), end: t("2026-11-20T14:00") }, { ...ctx, uid: "u" }),
    /end .* is before start/,
  );
  assert.throws(
    () => buildEvent({ title: "x", start: t("2026-11-20"), allDay: false }, { ...ctx, uid: "u" }),
    /has no time of day/,
  );
  assert.throws(() => buildEvent({ title: " ", start: t("2026-11-20") }, { ...ctx, uid: "u" }), /title is required/);
});

test("buildEvent writes organizer and attendees for invitations", () => {
  const ics = buildEvent(
    { title: "Lunch", start: t("2026-11-21T12:00"), attendees: [{ email: "bob@example.com", name: "Bob" }] },
    { ...ctx, uid: "U-4", organizer: { email: "me@icloud.com", name: "Me" } },
  );
  const unfolded = ics.replace(/\r\n /g, "");
  assert.match(unfolded, /ORGANIZER;CN=Me:mailto:me@icloud.com/);
  assert.match(unfolded, /ATTENDEE;CN=Bob;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:bob@example.com/);
});

test("normalizeRrule validates, uppercases, and makes UNTIL match the event type", () => {
  assert.equal(normalizeRrule("RRULE:freq=weekly;byday=mo,we;count=10", false, NY), "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10");
  // A bare date on a timed event: through the end of that day in the event's zone, as UTC.
  assert.equal(normalizeRrule("FREQ=MONTHLY;UNTIL=20270630", false, NY), "FREQ=MONTHLY;UNTIL=20270701T035959Z");
  assert.equal(normalizeRrule("FREQ=DAILY;UNTIL=20261231T000000Z", true, NY), "FREQ=DAILY;UNTIL=20261231");
  assert.throws(() => normalizeRrule("BYDAY=MO", false, NY), /needs FREQ/);
  assert.throws(() => normalizeRrule("FREQ=DAILY;COUNT=3;UNTIL=20261231", false, NY), /both COUNT and UNTIL/);
});

test("updating the series moves every instance and keeps the duration", () => {
  const { ics, scope, changed } = updateEvent(STANDUP, { start: t("2026-11-02T10:00") }, ctx);
  assert.equal(scope, "series");
  assert.equal(changed.start, "2026-11-02T10:00:00-05:00");
  assert.equal(changed.end, "2026-11-02T10:30:00-05:00");
  const { master } = parseObject(ics);
  assert.equal(master.getFirstPropertyValue("sequence"), 1);
  assert.match(ics, /DTSTART;TZID=America\/New_York:20261102T100000/);
});

test("updating one occurrence creates an override and leaves the rest of the series alone", () => {
  const { ics, scope, changed } = updateEvent(
    STANDUP,
    { title: "Standup with design", start: t("2026-11-30T11:00") },
    { ...ctx, occurrence: t("2026-11-30T09:00:00-05:00") },
  );
  assert.equal(scope, "occurrence");
  assert.equal(changed.occurrence, "2026-11-30T09:00:00-05:00");
  assert.match(ics, /RECURRENCE-ID;TZID=America\/New_York:20261130T090000/);
  const after = expandObject(ics, range("2026-11-29T00:00:00Z", "2026-12-08T00:00:00Z"), NY);
  assert.deepEqual(after.map((o) => [o.title, o.start, o.end]), [
    ["Standup with design", "2026-11-30T11:00:00-05:00", "2026-11-30T11:30:00-05:00"],
    ["Standup", "2026-12-07T09:00:00-05:00", "2026-12-07T09:30:00-05:00"],
  ]);
  // The copy keeps the series' alert, and the original master is unchanged.
  assert.equal(parseObject(ics).overrides.length, 3);
  assert.match(ics, /RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6/);
});

test("updating an already-moved occurrence edits its override in place; a date also names an occurrence", () => {
  const { ics } = updateEvent(STANDUP, { location: "Room 4" }, { ...ctx, occurrence: t("2026-11-16") });
  assert.equal(parseObject(ics).overrides.length, 2);
  const [moved] = expandObject(ics, range("2026-11-16T18:00:00Z", "2026-11-16T20:00:00Z"), NY);
  assert.equal(moved.location, "Room 4");
  assert.equal(moved.start, "2026-11-16T14:00:00-05:00");
});

test("occurrence arguments that match no instance are refused with a pointer to the right value", () => {
  assert.throws(
    () => updateEvent(STANDUP, { title: "x" }, { ...ctx, occurrence: t("2026-11-03T09:00:00-05:00") }),
    /no occurrence at 2026-11-03T09:00:00-05:00/,
  );
  // Nov 9 was excluded, so it cannot be edited either.
  assert.throws(() => updateEvent(STANDUP, { title: "x" }, { ...ctx, occurrence: t("2026-11-09") }), /no occurrence/);
  assert.throws(() => updateEvent(TRIP, { title: "x" }, { ...ctx, occurrence: t("2026-12-24") }), /does not repeat/);
});

test("clearing fields and recurrence", () => {
  const { ics } = updateEvent(STANDUP, { location: "", recurrence: "", alerts: [] }, ctx);
  const parsed = parseObject(ics);
  assert.equal(parsed.overrides.length, 0);
  assert.equal(parsed.master.hasProperty("location"), false);
  assert.equal(parsed.master.hasProperty("exdate"), false);
  assert.equal(parsed.master.getAllSubcomponents("valarm").length, 0);
  assert.equal(expandObject(ics, range("2026-11-01T00:00:00Z", "2027-01-01T00:00:00Z"), NY).length, 1);
});

test("cancelling one occurrence adds an EXDATE and drops any override for it", () => {
  const plain = cancelOccurrence(STANDUP, t("2026-12-07T09:00:00-05:00"), ctx);
  assert.equal(plain.occurrence, "2026-12-07T09:00:00-05:00");
  assert.match(plain.ics, /EXDATE;TZID=America\/New_York:20261207T090000/);
  const moved = cancelOccurrence(STANDUP, t("2026-11-16T09:00:00-05:00"), ctx);
  assert.equal(parseObject(moved.ics).overrides.length, 1);
  const left = expandObject(moved.ics, range("2026-11-01T00:00:00Z", "2027-01-01T00:00:00Z"), NY);
  assert.deepEqual(left.map((o) => o.start.slice(0, 10)), ["2026-11-02", "2026-11-30", "2026-12-07"]);
});

test("attendee updates keep existing responses", () => {
  const { ics } = updateEvent(
    PARIS_NO_VTIMEZONE,
    { attendees: [{ email: "ANA@example.com" }, { email: "carol@example.com", name: "Carol" }] },
    ctx,
  );
  const detail = describeObject(ics, NY);
  assert.deepEqual(
    detail.attendees.map((a) => [a.email, a.response]),
    [
      ["ana@example.com", "accepted"],
      ["carol@example.com", "no response yet"],
    ],
  );
});
