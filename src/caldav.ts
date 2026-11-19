/**
 * A small CalDAV (RFC 4791) client for iCloud: account discovery, calendar
 * listing, time-range queries, and single-object GET/PUT/DELETE.
 *
 * Redirects are followed by hand. iCloud answers on caldav.icloud.com and then
 * points at a per-account partition host (p123-caldav.icloud.com); fetch drops
 * the Authorization header on a cross-origin redirect, which would turn every
 * such hop into a 401.
 */

import { XMLParser } from "fast-xml-parser";
import { formatUtcBasic } from "./time.js";

export const ICLOUD_CALDAV_URL = "https://caldav.icloud.com/";

export interface CalDavOptions {
  username: string;
  password: string;
  rootUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

export interface CalendarCollection {
  /** Last path segment of the collection URL: stable, and what event ids are built from. */
  id: string;
  url: string;
  name: string;
  color?: string;
  description?: string;
  /** Component types the calendar accepts, e.g. ["VEVENT"]. */
  components: string[];
  writable: boolean;
  order?: number;
}

export interface CalendarObject {
  url: string;
  etag?: string;
  data: string;
}

export interface Discovery {
  principalUrl: string;
  homeUrl: string;
  /** The account's calendar addresses (mailto: stripped), used as ORGANIZER. */
  addresses: string[];
}

export class CalDavError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CalDavError";
  }
}

const NS =
  'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ical="http://apple.com/ns/ical/"';

// Namespace prefixes are dropped (d:href and href are the same to us), values
// stay strings (a calendar named "2026" must not turn into a number), and
// htmlEntities decodes the &#13; iCloud puts at the end of every line of
// calendar-data, which plain entity processing leaves in place.
const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  htmlEntities: true,
  isArray: (name) => ["response", "propstat", "href", "comp", "privilege"].includes(name),
});

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (isNode(value) && typeof value["#text"] === "string") return value["#text"].trim();
  return "";
}

function hrefsOf(value: unknown): string[] {
  if (!isNode(value)) return [];
  const hrefs = value.href;
  return (Array.isArray(hrefs) ? hrefs : []).map(textOf).filter(Boolean);
}

interface DavResponse {
  href: string;
  props: Node;
}

export function parseMultistatus(xml: string): DavResponse[] {
  let doc: Node;
  try {
    doc = parser.parse(xml) as Node;
  } catch (err) {
    throw new CalDavError(`iCloud sent malformed XML: ${err instanceof Error ? err.message : String(err)}`, 502);
  }
  if (!("multistatus" in doc)) throw new CalDavError("iCloud sent a reply that is not a WebDAV multistatus", 502);
  // An empty <multistatus/> (no events in range) parses as "", not an object.
  const multistatus = doc.multistatus;
  const responses = isNode(multistatus) && Array.isArray(multistatus.response) ? multistatus.response : [];
  return responses.filter(isNode).map((r) => {
    const props: Node = {};
    const propstats = Array.isArray(r.propstat) ? r.propstat : [];
    for (const ps of propstats) {
      // Only properties the server actually returned; 404 propstats list the ones it doesn't have.
      if (!isNode(ps) || !isNode(ps.prop)) continue;
      const status = textOf(ps.status);
      if (!status || /\s2\d\d(\s|$)/.test(` ${status}`)) Object.assign(props, ps.prop);
    }
    const hrefs = Array.isArray(r.href) ? r.href : [];
    return { href: textOf(hrefs[0]), props };
  });
}

function lastSegment(url: string): string {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1] ?? "");
}

function withSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** Apple stores colors as #RRGGBBAA; the alpha is always FF and only adds noise. */
function normalizeColor(raw: string): string | undefined {
  const m = /^#([0-9a-f]{6})/i.exec(raw);
  return m ? `#${m[1].toUpperCase()}` : undefined;
}

function canWrite(privilegeSet: unknown): boolean {
  // Not reported at all: assume writable and let a PUT say otherwise.
  if (!isNode(privilegeSet)) return true;
  const privileges = Array.isArray(privilegeSet.privilege) ? privilegeSet.privilege : [];
  return privileges.some((p) => isNode(p) && ("write" in p || "write-content" in p || "all" in p));
}

function describeStatus(status: number, action: string): string {
  switch (status) {
    case 401:
      return `iCloud rejected the calendar login (HTTP 401) while trying to ${action}. CalDAV signs in with your Apple ID (ICLOUD_APPLE_ID, or ICLOUD_EMAIL when that is unset) and an app-specific password.`;
    case 403:
      return `iCloud refused to ${action} (HTTP 403): the calendar is probably read-only, such as a subscribed calendar or one shared with you without edit rights.`;
    case 404:
      return `Not found while trying to ${action} (HTTP 404): the event or calendar may have been deleted or moved. List again to get a current id.`;
    case 412:
      return `The event changed on iCloud while this request was in flight (HTTP 412), so nothing was written. Read it again and retry.`;
    case 415:
    case 400:
      return `iCloud rejected the calendar data while trying to ${action} (HTTP ${status}).`;
    default:
      return `iCloud CalDAV answered HTTP ${status} while trying to ${action}.`;
  }
}

export class CalDavClient {
  private readonly auth: string;
  private readonly rootUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private discovery?: Promise<Discovery>;

  constructor(options: CalDavOptions) {
    this.auth = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
    this.rootUrl = options.rootUrl ?? ICLOUD_CALDAV_URL;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.userAgent = options.userAgent ?? "icloud-mcp";
  }

  private async send(
    method: string,
    url: string,
    action: string,
    init: { headers?: Record<string, string>; body?: string; ok: number[] },
  ): Promise<{ response: Response; url: string }> {
    let target = url;
    for (let hop = 0; hop < 5; hop++) {
      const response = await this.fetchImpl(target, {
        method,
        redirect: "manual",
        headers: { Authorization: this.auth, "User-Agent": this.userAgent, ...init.headers },
        body: init.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        target = new URL(location, target).toString();
        continue;
      }
      if (!init.ok.includes(response.status)) {
        await response.body?.cancel();
        throw new CalDavError(describeStatus(response.status, action), response.status);
      }
      return { response, url: target };
    }
    throw new CalDavError(`Too many redirects while trying to ${action}`, 508);
  }

  private async multistatus(
    method: "PROPFIND" | "REPORT",
    url: string,
    depth: 0 | 1,
    body: string,
    action: string,
  ): Promise<{ responses: DavResponse[]; url: string }> {
    const { response, url: finalUrl } = await this.send(method, url, action, {
      headers: { Depth: String(depth), "Content-Type": 'application/xml; charset="utf-8"' },
      body: `<?xml version="1.0" encoding="utf-8"?>${body}`,
      ok: [207],
    });
    return { responses: parseMultistatus(await response.text()), url: finalUrl };
  }

  /** Principal, calendar home and calendar addresses. Cached; a failure is not. */
  discover(): Promise<Discovery> {
    if (!this.discovery) {
      this.discovery = this.runDiscovery();
      this.discovery.catch(() => {
        this.discovery = undefined;
      });
    }
    return this.discovery;
  }

  private async runDiscovery(): Promise<Discovery> {
    const first = await this.multistatus(
      "PROPFIND",
      this.rootUrl,
      0,
      `<d:propfind ${NS}><d:prop><d:current-user-principal/></d:prop></d:propfind>`,
      "find your calendar account",
    );
    const principalHref = first.responses.flatMap((r) => hrefsOf(r.props["current-user-principal"]))[0];
    if (!principalHref) throw new CalDavError("iCloud did not say where your calendar account lives", 502);
    const principalUrl = new URL(principalHref, first.url).toString();

    const second = await this.multistatus(
      "PROPFIND",
      principalUrl,
      0,
      `<d:propfind ${NS}><d:prop><c:calendar-home-set/><c:calendar-user-address-set/></d:prop></d:propfind>`,
      "find your calendars",
    );
    const props = second.responses[0]?.props ?? {};
    const homeHref = hrefsOf(props["calendar-home-set"])[0];
    if (!homeHref) throw new CalDavError("iCloud did not say where your calendars live", 502);
    const addresses = hrefsOf(props["calendar-user-address-set"])
      .filter((h) => /^mailto:/i.test(h))
      .map((h) => h.replace(/^mailto:/i, ""));
    return { principalUrl, homeUrl: withSlash(new URL(homeHref, second.url).toString()), addresses };
  }

  async listCalendars(): Promise<CalendarCollection[]> {
    const { homeUrl } = await this.discover();
    const { responses, url } = await this.multistatus(
      "PROPFIND",
      homeUrl,
      1,
      `<d:propfind ${NS}><d:prop><d:resourcetype/><d:displayname/><c:calendar-description/><c:supported-calendar-component-set/><ical:calendar-color/><ical:calendar-order/><d:current-user-privilege-set/></d:prop></d:propfind>`,
      "list your calendars",
    );
    const calendars: CalendarCollection[] = [];
    for (const r of responses) {
      // The home itself, the scheduling inbox/outbox and the notification
      // collection come back too; only real calendars carry the calendar type.
      const type = r.props.resourcetype;
      if (!isNode(type) || !("calendar" in type)) continue;
      const collectionUrl = withSlash(new URL(r.href, url).toString());
      const componentSet = r.props["supported-calendar-component-set"];
      const comps = isNode(componentSet) && Array.isArray(componentSet.comp) ? componentSet.comp : [];
      const components = comps
        .map((c) => (isNode(c) ? String(c["@_name"] ?? "").toUpperCase() : ""))
        .filter(Boolean);
      const id = lastSegment(collectionUrl);
      const order = Number(textOf(r.props["calendar-order"]));
      calendars.push({
        id,
        url: collectionUrl,
        name: textOf(r.props.displayname) || id,
        color: normalizeColor(textOf(r.props["calendar-color"])),
        description: textOf(r.props["calendar-description"]) || undefined,
        components: components.length ? components : ["VEVENT", "VTODO"],
        writable: canWrite(r.props["current-user-privilege-set"]),
        order: Number.isFinite(order) && textOf(r.props["calendar-order"]) ? order : undefined,
      });
    }
    return calendars.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.name.localeCompare(b.name));
  }

  /** Objects with a VEVENT overlapping [start, end). The server applies recurrence when matching. */
  async queryEvents(calendarUrl: string, start: Date, end: Date): Promise<CalendarObject[]> {
    const body =
      `<c:calendar-query ${NS}><d:prop><d:getetag/><c:calendar-data/></d:prop>` +
      `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
      `<c:time-range start="${formatUtcBasic(start)}" end="${formatUtcBasic(end)}"/>` +
      `</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const { responses, url } = await this.multistatus("REPORT", calendarUrl, 1, body, "read events");
    return responses
      .filter((r) => textOf(r.props["calendar-data"]))
      .map((r) => ({
        url: new URL(r.href, url).toString(),
        etag: textOf(r.props.getetag) || undefined,
        data: textOf(r.props["calendar-data"]),
      }));
  }

  async getObject(url: string): Promise<CalendarObject> {
    const { response, url: finalUrl } = await this.send("GET", url, "read the event", { ok: [200] });
    return { url: finalUrl, etag: response.headers.get("etag") ?? undefined, data: await response.text() };
  }

  /**
   * Write an object. With create, If-None-Match: * refuses to overwrite; with
   * an etag, If-Match refuses to clobber a change made since it was read.
   */
  async putObject(url: string, data: string, options: { create?: boolean; etag?: string }): Promise<{ etag?: string }> {
    const headers: Record<string, string> = { "Content-Type": "text/calendar; charset=utf-8" };
    if (options.create) headers["If-None-Match"] = "*";
    else if (options.etag) headers["If-Match"] = options.etag;
    const { response } = await this.send("PUT", url, options.create ? "create the event" : "save the event", {
      headers,
      body: data,
      ok: [200, 201, 204],
    });
    await response.body?.cancel();
    return { etag: response.headers.get("etag") ?? undefined };
  }

  async deleteObject(url: string, etag?: string): Promise<void> {
    const { response } = await this.send("DELETE", url, "delete the event", {
      headers: etag ? { "If-Match": etag } : {},
      ok: [200, 204],
    });
    await response.body?.cancel();
  }
}
