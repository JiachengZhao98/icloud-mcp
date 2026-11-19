/**
 * iCloud Calendar behind the calendar tools: CalDAV for transport, ics.ts for
 * the iCalendar work, and ids the model can hand back.
 *
 * An event_id is "<calendar id>/<object file name>", e.g. "home/1F2E….ics":
 * enough to rebuild the object's URL without a search, and stable for the
 * life of the event. Writes carry the ETag they read, and a 412 (the event
 * changed on a phone in between) is re-read and re-applied once.
 */

import { randomUUID } from "node:crypto";
import { CalDavError, type CalDavClient, type CalendarCollection } from "./caldav.js";
import {
  buildEvent,
  cancelOccurrence,
  describeObject,
  expandObject,
  summarizeObject,
  updateEvent,
  type Attendee,
  type EventFields,
  type OccurrenceRecord,
} from "./ics.js";
import { addDays, formatInstant, startOfDay, toInstant, type TimeInput } from "./time.js";

const CALENDAR_CACHE_MS = 60_000;
const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 7;
const LIST_NOTES_CHARS = 300;

export interface ListEventsParams {
  start?: TimeInput;
  end?: TimeInput;
  calendars?: string[];
  query?: string;
  timeZone?: string;
  limit?: number;
}

export interface CreateEventParams extends EventFields {
  calendar?: string;
  title: string;
  start: TimeInput;
}

export interface UpdateEventParams {
  eventId: string;
  occurrence?: TimeInput;
  fields: EventFields;
}

export interface DeleteEventParams {
  eventId: string;
  occurrence?: TimeInput;
}

/** What the tools need from a calendar backend; tests substitute a fake. */
export interface CalendarApi {
  listCalendars(): Promise<unknown>;
  listEvents(params: ListEventsParams): Promise<unknown>;
  getEvent(eventId: string, timeZone?: string): Promise<unknown>;
  createEvent(params: CreateEventParams): Promise<unknown>;
  updateEvent(params: UpdateEventParams): Promise<unknown>;
  deleteEvent(params: DeleteEventParams): Promise<unknown>;
  verify(): Promise<unknown>;
}

export interface CalendarOptions {
  dav: CalDavClient;
  defaultTimeZone: string;
  /** The account holder, written as ORGANIZER when an event gets attendees. */
  owner: Attendee;
  now?: () => Date;
}

function fileNameOf(url: string): string {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1] ?? "");
}

function findCalendar(calendars: CalendarCollection[], ref: string): CalendarCollection | undefined {
  const wanted = ref.trim();
  const lower = wanted.toLowerCase();
  return (
    calendars.find((c) => c.id === wanted) ??
    calendars.find((c) => c.name.toLowerCase() === lower) ??
    calendars.find((c) => c.id.toLowerCase() === lower)
  );
}

export class ICloudCalendar implements CalendarApi {
  private cache?: { at: number; calendars: CalendarCollection[] };

  constructor(private readonly options: CalendarOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** Calendars that hold events; task-only lists (old-style Reminders) are left out. */
  private async calendars(fresh = false): Promise<CalendarCollection[]> {
    if (!fresh && this.cache && Date.now() - this.cache.at < CALENDAR_CACHE_MS) return this.cache.calendars;
    const calendars = (await this.options.dav.listCalendars()).filter((c) => c.components.includes("VEVENT"));
    this.cache = { at: Date.now(), calendars };
    return calendars;
  }

  private defaultCalendar(calendars: CalendarCollection[]): CalendarCollection | undefined {
    const writable = calendars.filter((c) => c.writable);
    return (
      writable.find((c) => c.id.toLowerCase() === "home") ??
      writable.find((c) => /^(home|calendar)$/i.test(c.name)) ??
      writable[0]
    );
  }

  private async resolveCalendar(ref: string | undefined, forWrite: boolean): Promise<CalendarCollection> {
    let calendars = await this.calendars();
    if (!ref?.trim()) {
      const fallback = this.defaultCalendar(calendars);
      if (!fallback) throw new Error("This account has no calendar that can be written to");
      return fallback;
    }
    let match = findCalendar(calendars, ref);
    if (!match) {
      calendars = await this.calendars(true);
      match = findCalendar(calendars, ref);
    }
    if (!match) {
      throw new Error(`No calendar "${ref}". Calendars: ${calendars.map((c) => `${c.name} (id ${c.id})`).join(", ")}`);
    }
    if (forWrite && !match.writable) throw new Error(`Calendar "${match.name}" is read-only`);
    return match;
  }

  private async locate(eventId: string): Promise<{ calendar: CalendarCollection; url: string }> {
    const slash = eventId.indexOf("/");
    if (slash <= 0 || slash === eventId.length - 1) {
      throw new Error(`event_id "${eventId}" should look like "home/1F2E3D4C.ics": use an event_id from icloud_calendar_list_events`);
    }
    const calendar = await this.resolveCalendar(eventId.slice(0, slash), false);
    return { calendar, url: calendar.url + encodeURIComponent(eventId.slice(slash + 1)) };
  }

  private async organizer(): Promise<Attendee> {
    const owner = this.options.owner;
    const { addresses } = await this.options.dav.discover();
    const email = addresses.find((a) => a.toLowerCase() === owner.email.toLowerCase()) ?? addresses[0] ?? owner.email;
    return { email, name: owner.name };
  }

  private present(calendar: CalendarCollection, url: string, r: OccurrenceRecord): Record<string, unknown> {
    const { startMs: _startMs, endMs: _endMs, uid: _uid, notes, recurring, ...rest } = r;
    return {
      event_id: `${calendar.id}/${fileNameOf(url)}`,
      calendar: calendar.name,
      ...rest,
      recurring: recurring || undefined,
      notes: notes && notes.length > LIST_NOTES_CHARS ? `${notes.slice(0, LIST_NOTES_CHARS)}…` : notes,
    };
  }

  async listCalendars(): Promise<unknown> {
    const calendars = await this.calendars(true);
    return {
      default_calendar: this.defaultCalendar(calendars)?.name,
      calendars: calendars.map((c) => ({
        id: c.id,
        name: c.name,
        color: c.color,
        description: c.description,
        writable: c.writable,
      })),
    };
  }

  async listEvents(params: ListEventsParams): Promise<unknown> {
    const zone = params.timeZone ?? this.options.defaultTimeZone;
    const start = params.start ? toInstant(params.start, zone) : this.now();
    // A bare end date covers that whole day.
    const end = params.end
      ? params.end.kind === "date"
        ? startOfDay(addDays(params.end.date, 1), zone)
        : toInstant(params.end, zone)
      : new Date(start.getTime() + DEFAULT_RANGE_DAYS * DAY_MS);
    if (end <= start) {
      throw new Error(`end (${formatInstant(end, zone)}) must be after start (${formatInstant(start, zone)})`);
    }
    if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY_MS) {
      throw new Error(`The range spans more than ${MAX_RANGE_DAYS} days; ask for a shorter one`);
    }

    const targets = params.calendars?.length
      ? [...new Map((await Promise.all(params.calendars.map((ref) => this.resolveCalendar(ref, false)))).map((c) => [c.id, c])).values()]
      : await this.calendars();

    const unreadable: string[] = [];
    const found = (
      await Promise.all(
        targets.map(async (calendar) => {
          const objects = await this.options.dav.queryEvents(calendar.url, start, end);
          const rows: Array<{ calendar: CalendarCollection; url: string; record: OccurrenceRecord }> = [];
          for (const object of objects) {
            try {
              for (const record of expandObject(object.data, { start, end }, zone)) rows.push({ calendar, url: object.url, record });
            } catch (err) {
              unreadable.push(`${calendar.name}/${fileNameOf(object.url)}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          return rows;
        }),
      )
    ).flat();

    const needle = params.query?.trim().toLowerCase();
    const matching = needle
      ? found.filter(({ record }) =>
          [record.title, record.location, record.notes].some((field) => field?.toLowerCase().includes(needle)),
        )
      : found;
    matching.sort((a, b) => a.record.startMs - b.record.startMs || a.record.endMs - b.record.endMs);
    const limit = params.limit ?? 200;
    const shown = matching.slice(0, limit);
    return {
      time_zone: zone,
      range: { start: formatInstant(start, zone), end: formatInstant(end, zone) },
      count: matching.length,
      truncated: matching.length > shown.length ? `showing the first ${shown.length}: narrow the range or raise limit` : undefined,
      events: shown.map(({ calendar, url, record }) => this.present(calendar, url, record)),
      unreadable: unreadable.length ? unreadable : undefined,
    };
  }

  async getEvent(eventId: string, timeZone?: string): Promise<unknown> {
    const zone = timeZone ?? this.options.defaultTimeZone;
    const { calendar, url } = await this.locate(eventId);
    const object = await this.options.dav.getObject(url);
    return { event_id: eventId, calendar: calendar.name, time_zone: zone, ...describeObject(object.data, zone) };
  }

  async createEvent(params: CreateEventParams): Promise<unknown> {
    const zone = params.timeZone ?? this.options.defaultTimeZone;
    const calendar = await this.resolveCalendar(params.calendar, true);
    const uid = randomUUID().toUpperCase();
    const organizer = params.attendees?.length ? await this.organizer() : undefined;
    const ics = buildEvent(params, { uid, now: this.now(), defaultTimeZone: this.options.defaultTimeZone, organizer });
    const fileName = `${uid}.ics`;
    await this.options.dav.putObject(calendar.url + encodeURIComponent(fileName), ics, { create: true });
    return {
      created: true,
      event_id: `${calendar.id}/${fileName}`,
      calendar: calendar.name,
      ...describeObject(ics, zone),
      invitations: params.attendees?.length ? "iCloud emails each attendee an invitation from this account" : undefined,
    };
  }

  async updateEvent(params: UpdateEventParams): Promise<unknown> {
    const zone = params.fields.timeZone ?? this.options.defaultTimeZone;
    const { calendar, url } = await this.locate(params.eventId);
    const organizer = params.fields.attendees?.length ? await this.organizer() : undefined;
    for (let attempt = 1; ; attempt++) {
      const object = await this.options.dav.getObject(url);
      const result = updateEvent(object.data, params.fields, {
        now: this.now(),
        defaultTimeZone: zone,
        organizer,
        occurrence: params.occurrence,
      });
      try {
        await this.options.dav.putObject(url, result.ics, { etag: object.etag });
        return { updated: result.scope, event_id: params.eventId, calendar: calendar.name, ...result.changed };
      } catch (err) {
        if (err instanceof CalDavError && err.status === 412 && attempt < 2) continue;
        throw err;
      }
    }
  }

  async deleteEvent(params: DeleteEventParams): Promise<unknown> {
    const zone = this.options.defaultTimeZone;
    const { calendar, url } = await this.locate(params.eventId);
    for (let attempt = 1; ; attempt++) {
      const object = await this.options.dav.getObject(url);
      try {
        if (!params.occurrence) {
          const summary = summarizeObject(object.data);
          await this.options.dav.deleteObject(url, object.etag);
          return {
            deleted: summary.recurring ? "series" : "event",
            event_id: params.eventId,
            calendar: calendar.name,
            title: summary.title,
          };
        }
        const result = cancelOccurrence(object.data, params.occurrence, { now: this.now(), defaultTimeZone: zone });
        await this.options.dav.putObject(url, result.ics, { etag: object.etag });
        return {
          deleted: "occurrence",
          event_id: params.eventId,
          calendar: calendar.name,
          title: result.title,
          occurrence: result.occurrence,
        };
      } catch (err) {
        if (err instanceof CalDavError && err.status === 412 && attempt < 2) continue;
        throw err;
      }
    }
  }

  async verify(): Promise<unknown> {
    const { addresses } = await this.options.dav.discover();
    const calendars = await this.calendars(true);
    return { calendars: calendars.length, addresses };
  }
}
