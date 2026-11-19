import assert from "node:assert/strict";
import { test } from "node:test";
import { CalDavClient, CalDavError, parseMultistatus } from "../dist/caldav.js";
import { ICloudCalendar } from "../dist/calendar.js";
import { parseTimeInput } from "../dist/time.js";
import { STANDUP, TRIP } from "./fixtures.mjs";

const NY = "America/New_York";
const ROOT = "https://caldav.icloud.com/";
// iCloud writes the partition with an explicit :443; URLs normalize it away.
const PARTITION = "https://p42-caldav.icloud.com:443";
const PARTITION_URL = "https://p42-caldav.icloud.com";
const HOME = "https://p42-caldav.icloud.com/1234567/calendars/";

const ms = (...responses) =>
  `<?xml version="1.0" encoding="UTF-8"?><multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">${responses.join("")}</multistatus>`;
const ok = (href, props) => `<response><href>${href}</href><propstat><prop>${props}</prop><status>HTTP/1.1 200 OK</status></propstat></response>`;
const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\r/g, "&#13;");

/** A fetch stand-in: routes by "METHOD url", records every call. */
function stubFetch(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const call = { url: String(url), method: init.method, headers: init.headers, body: init.body, redirect: init.redirect };
    calls.push(call);
    const route = routes[`${init.method} ${url}`];
    if (!route) return new Response("no route", { status: 404 });
    const r = typeof route === "function" ? route(call, calls) : route;
    return new Response(r.body ?? null, { status: r.status ?? 207, headers: r.headers ?? {} });
  };
  return { fetch, calls };
}

const discoveryRoutes = {
  [`PROPFIND ${ROOT}`]: { body: ms(ok("/", "<current-user-principal><href>/1234567/principal/</href></current-user-principal>")) },
  // iCloud answers the principal on the shared host by pointing at the account's partition.
  [`PROPFIND ${ROOT}1234567/principal/`]: { status: 301, headers: { Location: `${PARTITION}/1234567/principal/` } },
  [`PROPFIND ${PARTITION_URL}/1234567/principal/`]: {
    body: ms(
      ok(
        "/1234567/principal/",
        `<C:calendar-home-set><href>${PARTITION}/1234567/calendars/</href></C:calendar-home-set>` +
          `<C:calendar-user-address-set><href>mailto:jane@icloud.com</href><href>/1234567/principal/</href><href>urn:uuid:abc</href></C:calendar-user-address-set>`,
      ),
    ),
  },
};

const calendarsXml = ms(
  ok("/1234567/calendars/", "<resourcetype><collection/></resourcetype>"),
  ok(
    "/1234567/calendars/home/",
    `<resourcetype><collection/><C:calendar/></resourcetype><displayname>Home</displayname><A:calendar-color symbolic-color="blue">#1BADF8FF</A:calendar-color><A:calendar-order>2</A:calendar-order>` +
      `<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>` +
      `<current-user-privilege-set><privilege><read/></privilege><privilege><write/></privilege></current-user-privilege-set>`,
  ),
  ok(
    "/1234567/calendars/7F3A-WORK/",
    `<resourcetype><collection/><C:calendar/></resourcetype><displayname>Work</displayname><A:calendar-order>1</A:calendar-order>` +
      `<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>` +
      `<current-user-privilege-set><privilege><read/></privilege></current-user-privilege-set>`,
  ),
  ok(
    "/1234567/calendars/tasks/",
    `<resourcetype><collection/><C:calendar/></resourcetype><displayname>Reminders</displayname>` +
      `<C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>`,
  ),
  ok("/1234567/calendars/inbox/", "<resourcetype><collection/><C:schedule-inbox/></resourcetype>"),
  ok("/1234567/calendars/notification/", "<resourcetype><collection/></resourcetype><displayname>notification</displayname>"),
);

const listRoutes = { ...discoveryRoutes, [`PROPFIND ${HOME}`]: { body: calendarsXml } };

test("discovery follows the partition redirect and keeps the credentials across hosts", async () => {
  const { fetch, calls } = stubFetch(discoveryRoutes);
  const dav = new CalDavClient({ username: "jane@icloud.com", password: "abcd-efgh-ijkl-mnop", fetch });
  const found = await dav.discover();
  assert.equal(found.principalUrl, `${ROOT}1234567/principal/`);
  assert.equal(found.homeUrl, HOME);
  assert.deepEqual(found.addresses, ["jane@icloud.com"]);
  const partitionCall = calls.find((c) => c.url.startsWith(PARTITION_URL));
  assert.equal(partitionCall.headers.Authorization, `Basic ${Buffer.from("jane@icloud.com:abcd-efgh-ijkl-mnop").toString("base64")}`);
  assert.ok(calls.every((c) => c.redirect === "manual"));
  // Cached after the first success.
  await dav.discover();
  assert.equal(calls.length, 3);
});

test("listCalendars keeps only calendar collections, and reads names, colors, order and write access", async () => {
  const { fetch } = stubFetch(listRoutes);
  const calendars = await new CalDavClient({ username: "u@icloud.com", password: "p", fetch }).listCalendars();
  assert.deepEqual(
    calendars.map((c) => [c.id, c.name, c.color, c.components.join(), c.writable, c.url]),
    [
      ["7F3A-WORK", "Work", undefined, "VEVENT", false, `${HOME}7F3A-WORK/`],
      ["home", "Home", "#1BADF8", "VEVENT", true, `${HOME}home/`],
      ["tasks", "Reminders", undefined, "VTODO", true, `${HOME}tasks/`],
    ],
  );
});

test("queryEvents asks for a UTC time range and decodes the &#13; in calendar-data", async () => {
  let reportBody = "";
  const { fetch } = stubFetch({
    [`REPORT ${HOME}home/`]: (call) => {
      reportBody = call.body;
      return { body: ms(ok("/1234567/calendars/home/standup-1.ics", `<getetag>"e1"</getetag><C:calendar-data>${xmlEscape(STANDUP)}</C:calendar-data>`)) };
    },
  });
  const dav = new CalDavClient({ username: "u", password: "p", fetch });
  const objects = await dav.queryEvents(`${HOME}home/`, new Date("2026-11-01T04:00:00Z"), new Date("2026-11-08T05:00:00Z"));
  assert.match(reportBody, /<c:time-range start="20261101T040000Z" end="20261108T050000Z"\/>/);
  assert.equal(objects.length, 1);
  assert.equal(objects[0].url, `${HOME}home/standup-1.ics`);
  assert.equal(objects[0].etag, '"e1"');
  assert.equal(objects[0].data, STANDUP.trim());
});

test("writes send the right preconditions, and failures name the cause", async () => {
  const seen = [];
  const { fetch } = stubFetch({
    [`PUT ${HOME}home/new.ics`]: (call) => (seen.push(call.headers), { status: 201, headers: { ETag: '"n1"' } }),
    [`PUT ${HOME}home/old.ics`]: (call) => (seen.push(call.headers), { status: 412 }),
    [`DELETE ${HOME}home/gone.ics`]: { status: 401 },
  });
  const dav = new CalDavClient({ username: "u", password: "p", fetch });
  assert.deepEqual(await dav.putObject(`${HOME}home/new.ics`, "X", { create: true }), { etag: '"n1"' });
  assert.equal(seen[0]["If-None-Match"], "*");
  await assert.rejects(dav.putObject(`${HOME}home/old.ics`, "X", { etag: '"e7"' }), (err) => {
    assert.ok(err instanceof CalDavError);
    assert.equal(err.status, 412);
    assert.match(err.message, /changed on iCloud/);
    return true;
  });
  assert.equal(seen[1]["If-Match"], '"e7"');
  await assert.rejects(dav.deleteObject(`${HOME}home/gone.ics`), /app-specific password/);
});

test("parseMultistatus reads an empty multistatus as no results, and rejects other documents", () => {
  // iCloud's answer to a time-range query that matches nothing.
  const empty = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<multistatus xmlns="DAV:">\n    \n    \n</multistatus>';
  assert.deepEqual(parseMultistatus(empty), []);
  assert.throws(() => parseMultistatus("<html><body>Service Unavailable</body></html>"), /not a WebDAV multistatus/);
});

test("parseMultistatus ignores properties the server reported missing", () => {
  const [r] = parseMultistatus(
    ms(
      `<response><href>/a/</href><propstat><prop><displayname>2026</displayname></prop><status>HTTP/1.1 200 OK</status></propstat>` +
        `<propstat><prop><A:calendar-color/></prop><status>HTTP/1.1 404 Not Found</status></propstat></response>`,
    ),
  );
  assert.deepEqual(r, { href: "/a/", props: { displayname: "2026" } });
});

// ---------------------------------------------------------------------------
// The calendar service, over a fake CalDAV client
// ---------------------------------------------------------------------------

function fakeDav(objects) {
  const store = new Map(Object.entries(objects).map(([url, data]) => [url, { data, etag: '"1"' }]));
  const log = [];
  return {
    log,
    store,
    putFailures: 0,
    async discover() {
      return { principalUrl: "", homeUrl: HOME, addresses: ["jane@icloud.com"] };
    },
    async listCalendars() {
      return [
        { id: "home", url: `${HOME}home/`, name: "Home", components: ["VEVENT"], writable: true },
        { id: "7F3A-WORK", url: `${HOME}7F3A-WORK/`, name: "Work", components: ["VEVENT"], writable: false },
        { id: "tasks", url: `${HOME}tasks/`, name: "Reminders", components: ["VTODO"], writable: true },
      ];
    },
    async queryEvents(calendarUrl) {
      log.push(["REPORT", calendarUrl]);
      return [...store].filter(([url]) => url.startsWith(calendarUrl)).map(([url, o]) => ({ url, etag: o.etag, data: o.data }));
    },
    async getObject(url) {
      log.push(["GET", url]);
      const o = store.get(url);
      if (!o) throw new CalDavError("Not found", 404);
      return { url, etag: o.etag, data: o.data };
    },
    async putObject(url, data, options) {
      log.push(["PUT", url, options]);
      if (this.putFailures > 0) {
        this.putFailures--;
        throw new CalDavError("changed", 412);
      }
      store.set(url, { data, etag: `"${Number(store.get(url)?.etag?.replace(/"/g, "") ?? 0) + 1}"` });
      return {};
    },
    async deleteObject(url, etag) {
      log.push(["DELETE", url, etag]);
      store.delete(url);
    },
  };
}

const service = (dav) =>
  new ICloudCalendar({
    dav,
    defaultTimeZone: NY,
    owner: { email: "jane@icloud.com", name: "Jane" },
    now: () => new Date("2026-11-18T17:00:00Z"),
  });

test("listEvents merges calendars, expands series, sorts, filters, and leaves task lists out", async () => {
  const dav = fakeDav({ [`${HOME}home/standup-1.ics`]: STANDUP, [`${HOME}7F3A-WORK/trip-1.ics`]: TRIP });
  const out = await service(dav).listEvents({
    start: parseTimeInput("2026-11-30", "start"),
    end: parseTimeInput("2026-12-25", "end"),
  });
  assert.equal(out.time_zone, NY);
  assert.deepEqual(out.range, { start: "2026-11-30T00:00:00-05:00", end: "2026-12-26T00:00:00-05:00" });
  assert.deepEqual(
    out.events.map((e) => [e.event_id, e.calendar, e.title, e.start, e.occurrence]),
    [
      ["home/standup-1.ics", "Home", "Standup", "2026-11-30T09:00:00-05:00", "2026-11-30T09:00:00-05:00"],
      ["home/standup-1.ics", "Home", "Standup", "2026-12-07T09:00:00-05:00", "2026-12-07T09:00:00-05:00"],
      ["7F3A-WORK/trip-1.ics", "Work", "Family trip", "2026-12-24", undefined],
    ],
  );
  assert.ok(!dav.log.some(([, url]) => url.includes("/tasks/")));
  const filtered = await service(dav).listEvents({
    start: parseTimeInput("2026-11-01", "start"),
    end: parseTimeInput("2026-12-31", "end"),
    query: "hotel",
  });
  assert.deepEqual(filtered.events.map((e) => e.title), ["Family trip"]);
});

test("createEvent goes to the default calendar with If-None-Match, and refuses read-only calendars", async () => {
  const dav = fakeDav({});
  const created = await service(dav).createEvent({ title: "Dentist", start: parseTimeInput("2026-11-20T15:00", "start") });
  assert.equal(created.calendar, "Home");
  assert.match(created.event_id, /^home\/[0-9A-F-]{36}\.ics$/);
  assert.equal(created.start, "2026-11-20T15:00:00-05:00");
  const put = dav.log.find(([verb]) => verb === "PUT");
  assert.equal(put[1], `${HOME}home/${created.event_id.split("/")[1]}`);
  assert.deepEqual(put[2], { create: true });
  await assert.rejects(
    service(dav).createEvent({ title: "x", start: parseTimeInput("2026-11-20T15:00", "s"), calendar: "work" }),
    /Calendar "Work" is read-only/,
  );
  await assert.rejects(
    service(dav).createEvent({ title: "x", start: parseTimeInput("2026-11-20T15:00", "s"), calendar: "Nope" }),
    /No calendar "Nope"\. Calendars: Home \(id home\), Work \(id 7F3A-WORK\)/,
  );
});

test("an update that loses a race (412) is re-read and re-applied once", async () => {
  const dav = fakeDav({ [`${HOME}home/standup-1.ics`]: STANDUP });
  dav.putFailures = 1;
  const out = await service(dav).updateEvent({
    eventId: "home/standup-1.ics",
    occurrence: parseTimeInput("2026-12-07T09:00:00-05:00", "occurrence"),
    fields: { title: "Last standup of the year" },
  });
  assert.equal(out.updated, "occurrence");
  assert.equal(out.title, "Last standup of the year");
  assert.deepEqual(dav.log.map(([verb]) => verb), ["GET", "PUT", "GET", "PUT"]);
  assert.deepEqual(dav.log[1][2], { etag: '"1"' });
});

test("deleting a whole series, or one occurrence of it", async () => {
  const dav = fakeDav({ [`${HOME}home/standup-1.ics`]: STANDUP, [`${HOME}home/trip-1.ics`]: TRIP });
  const one = await service(dav).deleteEvent({ eventId: "home/standup-1.ics", occurrence: parseTimeInput("2026-11-30", "occurrence") });
  assert.deepEqual([one.deleted, one.title, one.occurrence], ["occurrence", "Standup", "2026-11-30T09:00:00-05:00"]);
  assert.match(dav.store.get(`${HOME}home/standup-1.ics`).data, /EXDATE;TZID=America\/New_York:20261130T090000/);
  const all = await service(dav).deleteEvent({ eventId: "home/standup-1.ics" });
  assert.deepEqual([all.deleted, all.title], ["series", "Standup"]);
  assert.equal(dav.store.has(`${HOME}home/standup-1.ics`), false);
  await assert.rejects(service(dav).getEvent("standup-1.ics"), /should look like "home\/1F2E3D4C\.ics"/);
});
