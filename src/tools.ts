/**
 * The tool catalog: the names, descriptions and schemas the model sees,
 * argument checking, and the mapping onto the mail and calendar services.
 *
 * Descriptions carry every rule needed to use a tool correctly (UIDs belong to
 * a folder, all-day ends are inclusive, occurrence targets one instance)
 * because they are the only documentation the model reads.
 */

import type { CalendarApi } from "./calendar.js";
import type { Config } from "./config.js";
import type { Attendee, EventFields } from "./ics.js";
import { parseRecipients, type MailApi } from "./mail.js";
import { checkTimeZone, parseTimeInput, type CivilDate, type TimeInput } from "./time.js";

export interface Services {
  mail: MailApi;
  calendar: CalendarApi;
}

export interface ToolContext {
  config: Config;
  services: Services;
}

type Args = Record<string, unknown>;

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  handler: (ctx: ToolContext, args: Args) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Argument checking: a wrong argument comes back as a tool error naming it
// ---------------------------------------------------------------------------

function optString(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function reqString(args: Args, key: string): string {
  const value = optString(args, key);
  if (!value?.trim()) throw new Error(`${key} is required`);
  return value;
}

/** undefined leaves a field alone; null or "" clears it. */
function clearable(args: Args, key: string): string | null | undefined {
  if (!(key in args)) return undefined;
  const value = args[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function optBool(args: Args, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "false") return value === "true";
  throw new Error(`${key} must be true or false`);
}

function optInt(args: Args, key: string, min: number, max: number): number | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${key} must be a whole number from ${min} to ${max}`);
  return n;
}

function reqInt(args: Args, key: string, min: number, max: number): number {
  const value = optInt(args, key, min, max);
  if (value === undefined) throw new Error(`${key} is required`);
  return value;
}

function stringList(args: Args, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
  throw new Error(`${key} must be a list of strings`);
}

function uidList(args: Args, key: string): number[] {
  const value = args[key];
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : String(value).split(",");
  const uids = raw.map((v) => Number(typeof v === "string" ? v.trim() : v));
  if (uids.length === 0 || uids.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(`${key} must be a list of message uids (positive whole numbers)`);
  }
  if (uids.length > 500) throw new Error(`${key}: at most 500 messages at a time`);
  return [...new Set(uids)];
}

function optTime(args: Args, key: string): TimeInput | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  return parseTimeInput(value, key);
}

function optDate(args: Args, key: string): CivilDate | undefined {
  const value = optTime(args, key);
  if (!value) return undefined;
  if (value.kind !== "date") throw new Error(`${key} must be a date (YYYY-MM-DD)`);
  return value.date;
}

function optZone(args: Args, key: string): string | undefined {
  const value = optString(args, key)?.trim();
  return value ? checkTimeZone(value, key) : undefined;
}

function alertList(args: Args, key: string): number[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  const minutes = (Array.isArray(value) ? value : [value]).map(Number);
  if (minutes.some((m) => !Number.isInteger(m) || m < 0 || m > 40_320)) {
    throw new Error(`${key} must be a list of minutes before the start, from 0 to 40320 (four weeks)`);
  }
  return minutes;
}

function attendeeList(args: Args, key: string): Attendee[] | undefined {
  const list = stringList(args, key);
  if (list === undefined) return undefined;
  return parseRecipients(list, key).map((a) => ({ email: a.address, name: a.name }));
}

function eventFields(args: Args, update: boolean): EventFields {
  const text = (key: string) => (update ? clearable(args, key) : optString(args, key));
  return {
    title: optString(args, "title"),
    start: optTime(args, "start"),
    end: optTime(args, "end"),
    allDay: optBool(args, "all_day"),
    timeZone: optZone(args, "timezone"),
    location: text("location"),
    notes: text("notes"),
    url: text("url"),
    alerts: alertList(args, "alerts"),
    recurrence: text("recurrence"),
    attendees: attendeeList(args, "attendees"),
  };
}

function compose(args: Args) {
  const replyUid = optInt(args, "reply_uid", 1, Number.MAX_SAFE_INTEGER);
  return {
    to: stringList(args, "to"),
    cc: stringList(args, "cc"),
    bcc: stringList(args, "bcc"),
    subject: optString(args, "subject"),
    body: optString(args, "body") ?? "",
    reply: replyUid ? { uid: replyUid, folder: optString(args, "reply_folder"), all: optBool(args, "reply_all") } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const str = (description: string) => ({ type: "string", description });
const bool = (description: string) => ({ type: "boolean", description });
const int = (description: string, minimum: number, maximum?: number) => ({
  type: "integer",
  description,
  minimum,
  ...(maximum === undefined ? {} : { maximum }),
});
const strings = (description: string) => ({ type: "array", items: { type: "string" }, description });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

const folderProp = str("Folder path or role: inbox (default), sent, drafts, archive, junk, trash, or a path from icloud_mail_list_folders");

function composeProps(draft: boolean) {
  const optional = draft ? " Optional for a draft." : "";
  return {
    to: strings(`Recipients: addresses or "Name <address>".${draft ? " Optional for a draft." : " Filled in from the original when replying."}`),
    cc: strings("Cc recipients."),
    bcc: strings("Bcc recipients; they do not see each other."),
    subject: str(`Subject. When replying, defaults to "Re: <original subject>".${optional}`),
    body: str("Plain-text body. When replying, write only the new text: the original is quoted under it automatically."),
    reply_uid: int("uid of the message being answered, from icloud_mail_search. Fills in recipients, subject and threading headers.", 1),
    reply_folder: str("Folder of the message being answered (default inbox)."),
    reply_all: bool("With reply_uid: also copy everyone else who received the original (never yourself)."),
  };
}

function eventProps(zone: string, update: boolean) {
  const clear = update ? ' Set to "" to clear.' : "";
  return {
    title: str("Event title."),
    start: str(
      `Start: a wall-clock time like 2026-11-20T15:00 (read in timezone), or ISO 8601 with an offset. For all-day events a date: 2026-11-20.${update ? " Moving start keeps the duration unless end is given too." : ""}`,
    ),
    end: str(
      `End, in the same form as start. For all-day events the LAST day of the event, inclusive (a one-day event ends on its start date).${update ? "" : " Defaults to one hour after start, or the start date for all-day events."}`,
    ),
    all_day: bool(update ? "Switch between all-day (dates) and timed. Not possible for a recurring series." : "An all-day event: start and end are dates."),
    timezone: str(`IANA time zone for wall-clock start/end values, and the zone the event is stored in. Default: ${zone}.`),
    location: str(`Location text.${clear}`),
    notes: str(`Notes (the event description).${clear}`),
    url: str(`A link attached to the event.${clear}`),
    alerts: { type: "array", items: { type: "integer", minimum: 0 }, description: `Alerts as minutes before the start, e.g. [15] or [1440, 60]; 0 is at the start.${update ? " Replaces all alerts; [] removes them." : ""}` },
    recurrence: str(
      `Repeat rule (RFC 5545 RRULE), e.g. FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10, FREQ=MONTHLY;BYMONTHDAY=1, or FREQ=DAILY;UNTIL=20261231.${update ? ' Applies to the whole series; "" makes the event single.' : ""}`,
    ),
    attendees: strings(
      `People to invite: addresses or "Name <address>". iCloud emails each new attendee an invitation from this account.${update ? " Replaces the list; existing attendees keep their responses; [] removes everyone." : ""}`,
    ),
  };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export function buildTools(config: Config): Tool[] {
  const zone = config.DEFAULT_TIMEZONE;
  const tools: Tool[] = [
    {
      name: "icloud_connection_status",
      title: "Check iCloud connection",
      description:
        "Check that the iCloud Mail (IMAP and SMTP) and iCloud Calendar (CalDAV) logins work, and show the account, the default time zone and whether write tools are enabled. Call this first if other tools fail.",
      inputSchema: object({}),
      annotations: READ,
      handler: async (ctx) => {
        const [mail, calendar] = await Promise.all([
          ctx.services.mail.verify(),
          ctx.services.calendar.verify().then(
            (details) => ({ status: "ok", ...(details as object) }),
            (err: unknown) => ({ status: err instanceof Error ? err.message : String(err) }),
          ),
        ]);
        return {
          account: ctx.config.ICLOUD_EMAIL,
          calendar_login: ctx.config.ICLOUD_APPLE_ID !== ctx.config.ICLOUD_EMAIL ? ctx.config.ICLOUD_APPLE_ID : undefined,
          default_time_zone: ctx.config.DEFAULT_TIMEZONE,
          write_tools: ctx.config.READ_ONLY ? "disabled (READ_ONLY)" : "enabled",
          mail,
          calendar,
        };
      },
    },

    // ----- Mail -----
    {
      name: "icloud_mail_list_folders",
      title: "List mail folders",
      description:
        "List mail folders with their message and unread counts. role marks the special folders (inbox, sent, drafts, archive, junk, trash); a role or a path can be passed as the folder of other mail tools.",
      inputSchema: object({}),
      annotations: READ,
      handler: (ctx) => ctx.services.mail.listFolders(),
    },
    {
      name: "icloud_mail_search",
      title: "Search mail",
      description:
        "Search one mail folder; returns matching messages newest first with sender, recipients, subject, date, read state and a text snippet. Criteria combine with AND; with none, it lists the newest messages. Searches the inbox unless folder is given: sent mail is in folder sent, archived mail in archive. Pass a result's uid and folder to icloud_mail_get_message to read it. Reading never marks mail as read.",
      inputSchema: object({
        folder: folderProp,
        query: str("Words to find anywhere in the message, headers or body."),
        from: str("Sender address or name contains this."),
        to: str("A To recipient contains this."),
        subject: str("Subject contains this."),
        since: str("Received on or after this date (YYYY-MM-DD)."),
        before: str("Received before this date (YYYY-MM-DD), exclusive."),
        unread_only: bool("Only unread messages."),
        flagged_only: bool("Only flagged messages."),
        limit: int("How many messages to return (default 20).", 1, 100),
      }),
      annotations: READ,
      handler: (ctx, a) =>
        ctx.services.mail.search({
          folder: optString(a, "folder"),
          query: optString(a, "query"),
          from: optString(a, "from"),
          to: optString(a, "to"),
          subject: optString(a, "subject"),
          since: optDate(a, "since"),
          before: optDate(a, "before"),
          unreadOnly: optBool(a, "unread_only"),
          flaggedOnly: optBool(a, "flagged_only"),
          limit: optInt(a, "limit", 1, 100),
        }),
    },
    {
      name: "icloud_mail_get_message",
      title: "Read a message",
      description:
        "Read one message: headers, the plain-text body (HTML-only mail is converted to text) and the list of attachments. Does not mark it as read. A uid belongs to one folder, so pass the folder it came from.",
      inputSchema: object(
        {
          uid: int("Message uid from icloud_mail_search.", 1),
          folder: folderProp,
          max_chars: int("Longest body to return (default 20000).", 500, 200_000),
        },
        ["uid"],
      ),
      annotations: READ,
      handler: (ctx, a) =>
        ctx.services.mail.getMessage({
          uid: reqInt(a, "uid", 1, Number.MAX_SAFE_INTEGER),
          folder: optString(a, "folder"),
          maxChars: optInt(a, "max_chars", 500, 200_000),
        }),
    },
    {
      name: "icloud_mail_send",
      title: "Send email",
      description:
        `Send an email from ${config.ICLOUD_EMAIL} through iCloud and file a copy in Sent. This delivers real mail immediately: unless the user asked for the message to be sent and has seen its recipients and text, use icloud_mail_create_draft instead. To reply, pass reply_uid (and reply_folder if the original is not in the inbox): recipients, the Re: subject and threading come from the original, which is quoted under the body. Plain text only; no attachments.`,
      inputSchema: object(composeProps(false), ["body"]),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      handler: (ctx, a) => {
        reqString(a, "body");
        return ctx.services.mail.send(compose(a));
      },
    },
    {
      name: "icloud_mail_create_draft",
      title: "Save a draft",
      description:
        "Save an email to the iCloud Drafts folder without sending it; the user can review, edit and send it from Apple Mail on any device. Takes the same arguments as icloud_mail_send, including replies through reply_uid.",
      inputSchema: object(composeProps(true)),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler: (ctx, a) => ctx.services.mail.saveDraft(compose(a)),
    },
    {
      name: "icloud_mail_mark",
      title: "Mark messages",
      description: "Mark messages read or unread, and flag or unflag them. Pass their uids and the folder they are in.",
      inputSchema: object(
        {
          uids: { type: "array", items: { type: "integer", minimum: 1 }, description: "Message uids, all from the same folder." },
          folder: folderProp,
          read: bool("true marks read, false marks unread."),
          flagged: bool("true flags, false removes the flag."),
        },
        ["uids"],
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: (ctx, a) =>
        ctx.services.mail.mark({
          uids: uidList(a, "uids"),
          folder: optString(a, "folder"),
          read: optBool(a, "read"),
          flagged: optBool(a, "flagged"),
        }),
    },
    {
      name: "icloud_mail_move",
      title: "Move messages",
      description:
        "Move messages to another folder: archive, trash, junk, inbox, or any folder path. Moving to trash is how mail is deleted. Messages get new uids in the destination; the result maps old to new.",
      inputSchema: object(
        {
          uids: { type: "array", items: { type: "integer", minimum: 1 }, description: "Message uids, all from the same folder." },
          folder: folderProp,
          destination: str("Folder to move them to: archive, trash, junk, inbox, or a path from icloud_mail_list_folders."),
        },
        ["uids", "destination"],
      ),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      handler: (ctx, a) =>
        ctx.services.mail.move({ uids: uidList(a, "uids"), folder: optString(a, "folder"), destination: reqString(a, "destination") }),
    },

    // ----- Calendar -----
    {
      name: "icloud_calendar_list_calendars",
      title: "List calendars",
      description:
        "List the iCloud calendars that hold events, with each one's id, name, color and whether it can be changed, plus the calendar new events go to by default. Pass a calendar's id or name as the calendar argument of other calendar tools.",
      inputSchema: object({}),
      annotations: READ,
      handler: (ctx) => ctx.services.calendar.listCalendars(),
    },
    {
      name: "icloud_calendar_list_events",
      title: "List events",
      description:
        `List events in a time range across all calendars (or the ones named), sorted by start, with recurring events expanded into their individual occurrences. Times come back as ISO 8601 with an offset, in ${zone} unless timezone says otherwise; all-day events have dates, and their end is the last day, inclusive. Each item has an event_id; occurrences of a recurring event also have an occurrence value: pass both to update or delete just that one. Without start and end it covers the next 7 days.`,
      inputSchema: object({
        start: str("Range start: a date (YYYY-MM-DD, from its midnight), a wall-clock time, or ISO 8601 with an offset. Default: now."),
        end: str("Range end. A date includes that whole day. Default: 7 days after start. At most 366 days."),
        calendars: strings("Only these calendars (ids or names). Default: all."),
        query: str("Only events whose title, location or notes contain this text."),
        timezone: str(`IANA time zone to show times in and read wall-clock arguments in. Default: ${zone}.`),
        limit: int("Most occurrences to return (default 200).", 1, 1000),
      }),
      annotations: READ,
      handler: (ctx, a) =>
        ctx.services.calendar.listEvents({
          start: optTime(a, "start"),
          end: optTime(a, "end"),
          calendars: stringList(a, "calendars"),
          query: optString(a, "query"),
          timeZone: optZone(a, "timezone"),
          limit: optInt(a, "limit", 1, 1000),
        }),
    },
    {
      name: "icloud_calendar_get_event",
      title: "Read an event",
      description:
        "Read one event in full: notes, repeat rule, excluded and modified occurrences, alerts, organizer, and attendees with their responses.",
      inputSchema: object(
        {
          event_id: str("event_id from icloud_calendar_list_events."),
          timezone: str(`IANA time zone to show times in. Default: ${zone}.`),
        },
        ["event_id"],
      ),
      annotations: READ,
      handler: (ctx, a) => ctx.services.calendar.getEvent(reqString(a, "event_id"), optZone(a, "timezone")),
    },
    {
      name: "icloud_calendar_create_event",
      title: "Create an event",
      description:
        `Create a calendar event; it syncs to all of the user's devices. start/end are wall-clock times in ${zone} (or in timezone), or ISO 8601 with an offset. For an all-day event pass dates and all_day: true. Goes to the default calendar unless calendar is given. Adding attendees makes iCloud email each of them an invitation.`,
      inputSchema: object(
        {
          ...eventProps(zone, false),
          calendar: str("Calendar id or name (default: see icloud_calendar_list_calendars)."),
        },
        ["title", "start"],
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      handler: (ctx, a) => {
        const fields = eventFields(a, false);
        if (!fields.start) throw new Error("start is required");
        return ctx.services.calendar.createEvent({
          ...fields,
          title: reqString(a, "title"),
          start: fields.start,
          calendar: optString(a, "calendar"),
        });
      },
    },
    {
      name: "icloud_calendar_update_event",
      title: "Change an event",
      description:
        "Change an event: pass event_id and only the fields to change. Without occurrence the change applies to the whole event, every instance of a recurring series included; with occurrence (from icloud_calendar_list_events) it applies to that one instance only. Changes sync to all devices, and attendees are sent an update.",
      inputSchema: object(
        {
          event_id: str("event_id from icloud_calendar_list_events."),
          occurrence: str("Change only this instance of a recurring event: its occurrence value from icloud_calendar_list_events."),
          ...eventProps(zone, true),
        },
        ["event_id"],
      ),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      handler: (ctx, a) => {
        const fields = eventFields(a, true);
        if (Object.values(fields).every((v) => v === undefined)) throw new Error("Nothing to change: pass at least one field");
        return ctx.services.calendar.updateEvent({
          eventId: reqString(a, "event_id"),
          occurrence: optTime(a, "occurrence"),
          fields,
        });
      },
    },
    {
      name: "icloud_calendar_delete_event",
      title: "Delete an event",
      description:
        "Delete an event, with every instance if it repeats. Pass occurrence (from icloud_calendar_list_events) to remove only that instance of a recurring event. Attendees are notified, and a deleted event cannot be restored with these tools.",
      inputSchema: object(
        {
          event_id: str("event_id from icloud_calendar_list_events."),
          occurrence: str("Delete only this instance of a recurring event: its occurrence value from icloud_calendar_list_events."),
        },
        ["event_id"],
      ),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      handler: (ctx, a) =>
        ctx.services.calendar.deleteEvent({ eventId: reqString(a, "event_id"), occurrence: optTime(a, "occurrence") }),
    },
  ];
  return config.READ_ONLY ? tools.filter((t) => t.annotations.readOnlyHint) : tools;
}
