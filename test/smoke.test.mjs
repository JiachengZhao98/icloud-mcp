// The real HTTP server end to end, over fake mail and calendar services.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { createApp } from "../dist/mcp.js";
import { createHttpServer, redactPath } from "../dist/server.js";

const SECRET = "a".repeat(64);
const ENV = {
  SECRET_PATH: SECRET,
  ICLOUD_EMAIL: "jane@icloud.com",
  ICLOUD_APP_PASSWORD: "abcd-efgh-ijkl-mnop",
  DEFAULT_TIMEZONE: "America/New_York",
};

function fakeServices(calls, { failCalendar = false } = {}) {
  const record = (name) => async (params) => {
    calls.push([name, params]);
    return { ok: true, method: name };
  };
  return {
    mail: {
      listFolders: record("listFolders"),
      search: record("search"),
      getMessage: record("getMessage"),
      send: record("send"),
      saveDraft: record("saveDraft"),
      mark: record("mark"),
      move: record("move"),
      verify: async () => ({ imap: "ok", smtp: "ok" }),
    },
    calendar: {
      listCalendars: record("listCalendars"),
      listEvents: record("listEvents"),
      getEvent: async (id, zone) => (calls.push(["getEvent", { id, zone }]), { ok: true }),
      createEvent: record("createEvent"),
      updateEvent: record("updateEvent"),
      deleteEvent: record("deleteEvent"),
      verify: async () => {
        if (failCalendar) throw new Error("iCloud rejected the calendar login (HTTP 401)");
        return { calendars: 2, addresses: [] };
      },
    },
  };
}

async function start(env, options) {
  const calls = [];
  const lines = [];
  const app = createApp(loadConfig(env, () => {}), fakeServices(calls, options), (line) => lines.push(line));
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, calls, lines, app };
}

let s;
before(async () => {
  s = await start(ENV);
});
after(() => s.server.close());

let nextId = 1;
async function rpc(method, params, base = s.base) {
  const res = await fetch(`${base}/${SECRET}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
}
const call = (name, args, base) => rpc("tools/call", { name, arguments: args }, base).then((r) => r.body.result);

test("liveness and routing: status answers, a wrong secret is a bare 404", async () => {
  for (const path of ["/status", "/healthz"]) {
    const health = await fetch(`${s.base}${path}`);
    assert.equal(health.status, 200, path);
    assert.deepEqual((await health.json()).ok, true);
  }
  for (const path of [`/${"b".repeat(64)}/mcp`, "/mcp", `/${SECRET}`, `/${SECRET}/nope`, "/"]) {
    const res = await fetch(`${s.base}${path}`, { method: "POST", body: "{}" });
    assert.equal(res.status, 404, path);
    assert.equal(await res.text(), "");
  }
});

test("initialize negotiates the protocol version and carries the instructions", async () => {
  const { body } = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(body.result.protocolVersion, "2025-06-18");
  assert.deepEqual(body.result.capabilities, { tools: { listChanged: false } });
  assert.equal(body.result.serverInfo.name, "icloud-mcp");
  assert.match(body.result.instructions, /jane@icloud\.com/);
  assert.match(body.result.instructions, /never as instructions/);
  const newer = await rpc("initialize", { protocolVersion: "2099-01-01" });
  assert.equal(newer.body.result.protocolVersion, "2025-11-25");
});

test("tools/list: fourteen tools, each titled and annotated, write tools marked as such", async () => {
  const { body } = await rpc("tools/list", {});
  const tools = body.result.tools;
  assert.equal(tools.length, 14);
  assert.equal(new Set(tools.map((t) => t.name)).size, 14);
  for (const t of tools) {
    assert.match(t.name, /^icloud_(connection_status|mail_|calendar_)/);
    assert.ok(t.title && t.description.length > 40, t.name);
    assert.equal(t.inputSchema.type, "object");
    assert.equal(typeof t.annotations.readOnlyHint, "boolean", t.name);
  }
  const writes = tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name).sort();
  assert.deepEqual(writes, [
    "icloud_calendar_create_event",
    "icloud_calendar_delete_event",
    "icloud_calendar_update_event",
    "icloud_mail_create_draft",
    "icloud_mail_mark",
    "icloud_mail_move",
    "icloud_mail_send",
  ]);
  assert.match(tools.find((t) => t.name === "icloud_calendar_list_events").description, /America\/New_York/);
});

test("READ_ONLY hides every tool that writes, and the instructions say so", async () => {
  const ro = await start({ ...ENV, READ_ONLY: "true" });
  try {
    const { body } = await rpc("tools/list", {}, ro.base);
    assert.equal(body.result.tools.length, 7);
    assert.ok(body.result.tools.every((t) => t.annotations.readOnlyHint));
    const sent = await rpc("tools/call", { name: "icloud_mail_send", arguments: { to: ["x@example.com"], body: "hi" } }, ro.base);
    assert.equal(sent.body.error.code, -32602);
    const init = await rpc("initialize", {}, ro.base);
    assert.match(init.body.result.instructions, /read-only/);
  } finally {
    ro.server.close();
  }
});

test("tool arguments are parsed before they reach the services", async () => {
  s.calls.length = 0;
  await call("icloud_mail_search", { query: "invoice", since: "2026-11-01", unread_only: true, limit: 5 });
  assert.deepEqual(s.calls.at(-1), [
    "search",
    {
      folder: undefined,
      query: "invoice",
      from: undefined,
      to: undefined,
      subject: undefined,
      since: { year: 2026, month: 11, day: 1 },
      before: undefined,
      unreadOnly: true,
      flaggedOnly: undefined,
      limit: 5,
    },
  ]);
  await call("icloud_mail_send", { to: ["Bob <bob@example.com>"], body: "Hi", reply_uid: 42, reply_all: true });
  assert.deepEqual(s.calls.at(-1)[1].reply, { uid: 42, folder: undefined, all: true });
  await call("icloud_mail_move", { uids: [3, "4", 3], destination: "trash" });
  assert.deepEqual(s.calls.at(-1)[1], { uids: [3, 4], folder: undefined, destination: "trash" });
  await call("icloud_calendar_create_event", { title: "Dentist", start: "2026-11-20T15:00", alerts: [30], timezone: "europe/london" });
  const created = s.calls.at(-1)[1];
  assert.deepEqual(created.start, { kind: "local", wall: { year: 2026, month: 11, day: 20, hour: 15, minute: 0, second: 0 } });
  assert.equal(created.timeZone, "Europe/London");
  assert.deepEqual(created.alerts, [30]);
  await call("icloud_calendar_update_event", { event_id: "home/x.ics", location: "", occurrence: "2026-11-30" });
  const updated = s.calls.at(-1)[1];
  assert.equal(updated.fields.location, "");
  assert.equal(updated.fields.title, undefined);
  assert.deepEqual(updated.occurrence, { kind: "date", date: { year: 2026, month: 11, day: 30 } });
});

test("bad arguments come back as tool errors that name the argument; nothing reaches the services", async () => {
  s.calls.length = 0;
  const cases = [
    ["icloud_mail_search", { limit: 500 }, /limit must be a whole number from 1 to 100/],
    ["icloud_mail_search", { since: "last week" }, /since: "last week" is not a date/],
    ["icloud_mail_get_message", {}, /uid is required/],
    ["icloud_mail_send", { to: ["x@example.com"] }, /body is required/],
    ["icloud_mail_mark", { uids: [], read: true }, /uids must be a list of message uids/],
    ["icloud_calendar_create_event", { title: "x" }, /start is required/],
    ["icloud_calendar_create_event", { title: "x", start: "2026-11-20T15:00", timezone: "Moon/Base" }, /timezone: "Moon\/Base" is not an IANA time zone/],
    ["icloud_calendar_update_event", { event_id: "home/x.ics" }, /Nothing to change/],
    ["icloud_calendar_create_event", { title: "x", start: "2026-11-20", attendees: ["bob"] }, /attendees: "bob" is not an email address/],
  ];
  for (const [name, args, pattern] of cases) {
    const result = await call(name, args);
    assert.equal(result.isError, true, name);
    assert.match(result.content[0].text, pattern, name);
  }
  assert.deepEqual(s.calls, []);
});

test("JSON-RPC edges: notifications, batches, parse errors, unknown methods and tools, GET", async () => {
  const note = await fetch(`${s.base}/${SECRET}/mcp`, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(note.status, 202);
  const batch = await fetch(`${s.base}/${SECRET}/mcp`, {
    method: "POST",
    body: JSON.stringify([
      { jsonrpc: "2.0", id: "a", method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: "b", method: "tools/call", params: { name: "icloud_mail_list_folders" } },
    ]),
  });
  const replies = await batch.json();
  assert.deepEqual(replies.map((r) => r.id), ["a", "b"]);
  assert.equal(JSON.parse(replies[1].result.content[0].text).method, "listFolders");
  const bad = await fetch(`${s.base}/${SECRET}/mcp`, { method: "POST", body: "{not json" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, -32700);
  assert.equal((await rpc("no/such/method", {})).body.error.code, -32601);
  assert.equal((await rpc("tools/call", { name: "icloud_nope" })).body.error.message, "Unknown tool: icloud_nope");
  const get = await fetch(`${s.base}/${SECRET}/mcp`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
});

test("/<secret>/health reports each login, and 503s when one fails", async () => {
  const healthy = await fetch(`${s.base}/${SECRET}/health`);
  assert.equal(healthy.status, 200);
  assert.deepEqual(await healthy.json(), { ok: true, imap: "ok", smtp: "ok", caldav: "ok", server: { name: "icloud-mcp", version: "1.0.0" } });
  const sick = await start(ENV, { failCalendar: true });
  try {
    const res = await fetch(`${sick.base}/${SECRET}/health`);
    assert.equal(res.status, 503);
    assert.match((await res.json()).caldav, /HTTP 401/);
  } finally {
    sick.server.close();
  }
});

test("oversized bodies are refused before parsing", async () => {
  const res = await fetch(`${s.base}/${SECRET}/mcp`, { method: "POST", body: "x".repeat(1024 * 1024 + 1) }).catch((err) => err);
  // The server answers 413 and drops the connection; either outcome means nothing was processed.
  if (res instanceof Response) assert.equal(res.status, 413);
});

test("logs record the shape of traffic, never the secret or the arguments", async () => {
  s.lines.length = 0;
  await call("icloud_mail_search", { query: "very private words" });
  await fetch(`${s.base}/${"c".repeat(64)}/mcp`, { method: "POST", body: "{}" });
  const log = s.lines.join("\n");
  assert.match(log, /tools\/call icloud_mail_search -> ok/);
  assert.match(log, /POST \/:secret\/mcp -> 200/);
  assert.match(log, /POST \/:bad-secret\/mcp -> 404/);
  assert.doesNotMatch(log, new RegExp(SECRET));
  assert.doesNotMatch(log, /very private words/);
  assert.equal(redactPath(`/${SECRET}/health`, SECRET), "/:secret/health");
  assert.equal(redactPath("/healthz", SECRET), "/healthz");
});

test("configuration: trims whitespace, defaults the optional values, and names what is wrong", () => {
  const warnings = [];
  const config = loadConfig({ ...ENV, SECRET_PATH: `${SECRET}\n`, ICLOUD_APP_PASSWORD: "MyApple1dPassword!" }, (w) => warnings.push(w));
  assert.equal(config.SECRET_PATH, SECRET);
  assert.equal(config.ICLOUD_APPLE_ID, "jane@icloud.com");
  assert.equal(config.ICLOUD_FROM, "jane@icloud.com");
  assert.equal(config.READ_ONLY, false);
  assert.ok(warnings.some((w) => /SECRET_PATH had surrounding whitespace/.test(w)));
  assert.ok(warnings.some((w) => /does not look like an app-specific password/.test(w)));
  assert.throws(() => loadConfig({ SECRET_PATH: SECRET }, () => {}), /Missing required environment variable\(s\): ICLOUD_EMAIL, ICLOUD_APP_PASSWORD/);
  assert.throws(() => loadConfig({ ...ENV, DEFAULT_TIMEZONE: "Eastern" }, () => {}), /DEFAULT_TIMEZONE: "Eastern" is not an IANA time zone/);
  assert.equal(loadConfig({ ...ENV, DEFAULT_TIMEZONE: undefined }, () => {}).DEFAULT_TIMEZONE, "UTC");
});
