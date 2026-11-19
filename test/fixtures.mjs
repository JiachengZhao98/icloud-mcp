// iCalendar objects shaped like the ones iCloud stores, line by line.

const crlf = (lines) => `${lines.join("\r\n")}\r\n`;

export const NY_VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0500",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "DTSTART:20070311T020000",
  "TZNAME:EDT",
  "TZOFFSETTO:-0400",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0400",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "DTSTART:20071104T020000",
  "TZNAME:EST",
  "TZOFFSETTO:-0500",
  "END:STANDARD",
  "END:VTIMEZONE",
];

const HEAD = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Apple Inc.//macOS 26.1//EN", "CALSCALE:GREGORIAN"];

/**
 * Mondays at 09:00 New York, six times from 2026-11-02: Nov 9 excluded,
 * Nov 16 moved to 14:00, Nov 23 cancelled through an override.
 */
export const STANDUP = crlf([
  ...HEAD,
  ...NY_VTIMEZONE,
  "BEGIN:VEVENT",
  "UID:standup-1",
  "DTSTAMP:20261001T120000Z",
  "DTSTART;TZID=America/New_York:20261102T090000",
  "DTEND;TZID=America/New_York:20261102T093000",
  "SUMMARY:Standup",
  "LOCATION:Zoom",
  "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6",
  "EXDATE;TZID=America/New_York:20261109T090000",
  "SEQUENCE:0",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "DESCRIPTION:Reminder",
  "TRIGGER:-PT10M",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:standup-1",
  "DTSTAMP:20261001T120000Z",
  "RECURRENCE-ID;TZID=America/New_York:20261116T090000",
  "DTSTART;TZID=America/New_York:20261116T140000",
  "DTEND;TZID=America/New_York:20261116T143000",
  "SUMMARY:Standup (moved)",
  "SEQUENCE:1",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:standup-1",
  "DTSTAMP:20261001T120000Z",
  "RECURRENCE-ID;TZID=America/New_York:20261123T090000",
  "DTSTART;TZID=America/New_York:20261123T090000",
  "DTEND;TZID=America/New_York:20261123T093000",
  "SUMMARY:Standup",
  "STATUS:CANCELLED",
  "END:VEVENT",
  "END:VCALENDAR",
]);

/** Three all-day days, Dec 24 through Dec 26 (DTEND is exclusive). */
export const TRIP = crlf([
  ...HEAD,
  "BEGIN:VEVENT",
  "UID:trip-1",
  "DTSTAMP:20261001T120000Z",
  "DTSTART;VALUE=DATE:20261224",
  "DTEND;VALUE=DATE:20261227",
  "SUMMARY:Family trip",
  "DESCRIPTION:Flights booked\\, hotel TBD",
  "END:VEVENT",
  "END:VCALENDAR",
]);

/** Floating time: 10:00 wherever the reader is. */
export const FLOATING = crlf([
  ...HEAD,
  "BEGIN:VEVENT",
  "UID:float-1",
  "DTSTAMP:20261001T120000Z",
  "DTSTART:20261120T100000",
  "DTEND:20261120T110000",
  "SUMMARY:Floating",
  "END:VEVENT",
  "END:VCALENDAR",
]);

/** A TZID with no VTIMEZONE in the object, which some clients write. */
export const PARIS_NO_VTIMEZONE = crlf([
  ...HEAD,
  "BEGIN:VEVENT",
  "UID:paris-1",
  "DTSTAMP:20261001T120000Z",
  "DTSTART;TZID=Europe/Paris:20261120T100000",
  "DTEND;TZID=Europe/Paris:20261120T113000",
  "SUMMARY:Paris call",
  "ORGANIZER;CN=Ana:mailto:ana@example.com",
  "ATTENDEE;CN=Ana;PARTSTAT=ACCEPTED:mailto:ana@example.com",
  "ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION:mailto:me@icloud.com",
  "END:VEVENT",
  "END:VCALENDAR",
]);

/** Weekly on Thursdays; the Dec 10 instance moved two weeks earlier, to Nov 25. */
export const MOVED_EARLIER = crlf([
  ...HEAD,
  ...NY_VTIMEZONE,
  "BEGIN:VEVENT",
  "UID:book-club",
  "DTSTAMP:20261001T120000Z",
  "DTSTART;TZID=America/New_York:20261105T190000",
  "DTEND;TZID=America/New_York:20261105T200000",
  "SUMMARY:Book club",
  "RRULE:FREQ=WEEKLY;BYDAY=TH",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:book-club",
  "DTSTAMP:20261001T120000Z",
  "RECURRENCE-ID;TZID=America/New_York:20261210T190000",
  "DTSTART;TZID=America/New_York:20261125T190000",
  "DTEND;TZID=America/New_York:20261125T200000",
  "SUMMARY:Book club (early)",
  "END:VEVENT",
  "END:VCALENDAR",
]);
