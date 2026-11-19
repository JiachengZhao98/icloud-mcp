/**
 * iCloud Mail behind the mail tools: IMAP (imapflow) to read, file and save
 * drafts, SMTP (nodemailer) to send.
 *
 * Every call opens its own IMAP connection and logs out when done. Cloud Run
 * throttles an instance's CPU between requests, which leaves a pooled
 * connection to time out half-open; a fresh login costs well under a second.
 *
 * Reading never marks mail as read: imapflow fetches with BODY.PEEK, and
 * mailboxes opened only to read are opened read-only (EXAMINE) on top of that.
 */

import { randomUUID } from "node:crypto";
import {
  AuthenticationFailure,
  ImapFlow,
  type FetchMessageObject,
  type ListResponse,
  type MessageAddressObject,
  type MessageStructureObject,
  type SearchObject,
} from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import nodemailer from "nodemailer";
import addressparser from "nodemailer/lib/addressparser";
import MailComposer from "nodemailer/lib/mail-composer";
import { formatInstant, type CivilDate } from "./time.js";
import { SERVER_VERSION } from "./version.js";

const IMAP_HOST = "imap.mail.me.com";
const SMTP_HOST = "smtp.mail.me.com";
/** Enough of each message for a snippet: headers plus the start of the first text part. */
const SNIPPET_SOURCE_BYTES = 32 * 1024;
/** MIME puts the body before the attachments, so this reads the text of all but freak messages. */
const MESSAGE_SOURCE_BYTES = 8 * 1024 * 1024;
const SNIPPET_CHARS = 200;
const QUOTE_CHARS = 20_000;
const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_BODY_CHARS = 20_000;

/** Parsing for display only: no link rewriting, no generated HTML. */
const PARSE_OPTIONS = { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true } as const;

export interface MailOptions {
  /** iCloud Mail address: the IMAP and SMTP login. */
  user: string;
  password: string;
  /** From header for outgoing mail: an address, or "Name <address>". */
  from: string;
  /** Zone dates are shown in. */
  timeZone: string;
}

export interface SearchParams {
  folder?: string;
  query?: string;
  from?: string;
  to?: string;
  subject?: string;
  since?: CivilDate;
  before?: CivilDate;
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
  limit?: number;
}

export interface ComposeParams {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body: string;
  reply?: { folder?: string; uid: number; all?: boolean };
}

/** What the tools need from a mail backend; tests substitute a fake. */
export interface MailApi {
  listFolders(): Promise<unknown>;
  search(params: SearchParams): Promise<unknown>;
  getMessage(params: { folder?: string; uid: number; maxChars?: number }): Promise<unknown>;
  send(params: ComposeParams): Promise<unknown>;
  saveDraft(params: ComposeParams): Promise<unknown>;
  mark(params: { folder?: string; uids: number[]; read?: boolean; flagged?: boolean }): Promise<unknown>;
  move(params: { folder?: string; uids: number[]; destination: string }): Promise<unknown>;
  verify(): Promise<{ imap: string; smtp: string }>;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export interface Addr {
  name?: string;
  address: string;
}

export function formatAddr(a: Addr): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

function addrKey(a: Addr): string {
  return a.address.toLowerCase();
}

/** Drop repeated addresses (case-insensitive) and any in `exclude`. */
export function dedupe(list: Addr[], exclude: Iterable<string> = []): Addr[] {
  const seen = new Set([...exclude].map((s) => s.toLowerCase()));
  const out: Addr[] = [];
  for (const a of list) {
    if (seen.has(addrKey(a))) continue;
    seen.add(addrKey(a));
    out.push(a);
  }
  return out;
}

/** Parse recipient arguments: each entry may hold several comma-separated addresses, with or without names. */
export function parseRecipients(values: string[] | undefined, field: string): Addr[] {
  const out: Addr[] = [];
  for (const value of values ?? []) {
    for (const parsed of addressparser(value, { flatten: true })) {
      const address = parsed.address?.trim() ?? "";
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) {
        throw new Error(`${field}: "${value}" is not an email address`);
      }
      out.push({ name: parsed.name?.trim() || undefined, address });
    }
  }
  return out;
}

function fromEnvelope(list: MessageAddressObject[] | undefined): Addr[] {
  return (list ?? []).filter((a) => a.address).map((a) => ({ name: a.name || undefined, address: a.address as string }));
}

function fromParsed(field: AddressObject | AddressObject[] | undefined): Addr[] {
  const objects = Array.isArray(field) ? field : field ? [field] : [];
  const out: Addr[] = [];
  const visit = (entry: { address?: string; name?: string; group?: unknown[] }) => {
    if (entry.address) out.push({ name: entry.name || undefined, address: entry.address });
    for (const member of (entry.group ?? []) as Array<{ address?: string; name?: string }>) visit(member);
  };
  for (const o of objects) for (const v of o.value) visit(v);
  return out;
}

const ROLE_BY_FLAG: Record<string, string> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Drafts": "drafts",
  "\\Trash": "trash",
  "\\Junk": "junk",
  "\\Archive": "archive",
};

const ROLE_ALIASES: Record<string, string> = {
  inbox: "inbox",
  sent: "sent",
  drafts: "drafts",
  draft: "drafts",
  trash: "trash",
  deleted: "trash",
  bin: "trash",
  junk: "junk",
  spam: "junk",
  archive: "archive",
};

export interface FolderEntry {
  path: string;
  name: string;
  specialUse?: string;
}

export function roleOf(folder: FolderEntry): string | undefined {
  if (folder.path.toUpperCase() === "INBOX") return "inbox";
  return folder.specialUse ? ROLE_BY_FLAG[folder.specialUse] : undefined;
}

/** Resolve a folder argument: an exact path, a role (sent, trash, …), or a case-insensitive path or name. */
export function matchFolder(folders: FolderEntry[], wanted: string): FolderEntry | undefined {
  const value = wanted.trim();
  const lower = value.toLowerCase();
  if (lower === "inbox") return { path: "INBOX", name: "INBOX" };
  const exact = folders.find((f) => f.path === value);
  if (exact) return exact;
  const role = ROLE_ALIASES[lower];
  const byRole = role ? folders.find((f) => roleOf(f) === role) : undefined;
  if (byRole) return byRole;
  return folders.find((f) => f.path.toLowerCase() === lower) ?? folders.find((f) => f.name.toLowerCase() === lower);
}

export function buildCriteria(p: SearchParams): SearchObject {
  const criteria: SearchObject = { deleted: false };
  const set = (key: "text" | "from" | "to" | "subject", value: string | undefined) => {
    if (value?.trim()) criteria[key] = value.trim();
  };
  set("text", p.query);
  set("from", p.from);
  set("to", p.to);
  set("subject", p.subject);
  // imapflow formats search dates from their UTC calendar day, so build them at UTC midnight.
  if (p.since) criteria.since = new Date(Date.UTC(p.since.year, p.since.month - 1, p.since.day));
  if (p.before) criteria.before = new Date(Date.UTC(p.before.year, p.before.month - 1, p.before.day));
  if (p.unreadOnly) criteria.seen = false;
  if (p.flaggedOnly) criteria.flagged = true;
  return criteria;
}

export interface AttachmentInfo {
  filename: string;
  content_type: string;
  size_bytes?: number;
}

/**
 * Attachments from BODYSTRUCTURE, which the server sends without the content.
 * Images embedded in an HTML body (signature logos and the like) sit in a
 * multipart/related part with a Content-ID and are left out; a photo attached
 * in Apple Mail is inline too, but sits directly under multipart/mixed.
 */
export function listAttachments(root: MessageStructureObject | undefined): AttachmentInfo[] {
  const out: AttachmentInfo[] = [];
  const walk = (node: MessageStructureObject, parentType: string) => {
    const type = (node.type ?? "").toLowerCase();
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name;
    const size =
      node.size === undefined ? undefined : (node.encoding ?? "").toLowerCase() === "base64" ? Math.round((node.size * 3) / 4) : node.size;
    if (type === "message/rfc822") {
      out.push({ filename: filename ?? `${node.envelope?.subject || "message"}.eml`, content_type: type, size_bytes: size });
      return;
    }
    if (node.childNodes?.length) {
      for (const child of node.childNodes) walk(child, type);
      return;
    }
    const disposition = (node.disposition ?? "").toLowerCase();
    if (!filename && disposition !== "attachment") return;
    if (parentType === "multipart/related" && node.id && disposition !== "attachment") return;
    out.push({ filename: filename ?? "(unnamed)", content_type: type, size_bytes: size });
  };
  if (root) walk(root, "");
  return out;
}

export interface Original {
  messageId?: string;
  references: string[];
  from: Addr[];
  /** The Reply-To header itself; IMAP's ENVELOPE fills it in with From when absent. */
  replyTo: Addr[];
  to: Addr[];
  cc: Addr[];
  subject: string;
  date?: Date;
  text: string;
}

export interface ReplyHeaders {
  to: Addr[];
  cc: Addr[];
  subject: string;
  inReplyTo?: string;
  references: string[];
}

/**
 * Recipients and threading for a reply, as Apple Mail does it: to Reply-To or
 * From; replying to your own message goes to its recipients; reply-all adds
 * the other recipients, never yourself.
 */
export function deriveReply(original: Original, self: Set<string>, all: boolean): ReplyHeaders {
  const isSelf = (a: Addr) => self.has(addrKey(a));
  const fromSelf = original.from.some(isSelf);
  const primary = fromSelf ? original.to : original.replyTo.length ? original.replyTo : original.from;
  let to = dedupe(primary.filter((a) => !isSelf(a)));
  if (to.length === 0) to = dedupe(primary); // a note to self
  const cc = all
    ? dedupe(
        [...(fromSelf ? [] : original.to), ...original.cc].filter((a) => !isSelf(a)),
        to.map(addrKey),
      )
    : [];
  const subject = /^\s*re\s*:/i.test(original.subject) ? original.subject.trim() : `Re: ${original.subject}`.trim();
  const references = [...new Set([...original.references, ...(original.messageId ? [original.messageId] : [])])];
  return { to, cc, subject, inReplyTo: original.messageId, references };
}

/** The original message quoted under a reply, with Apple Mail's attribution line. */
export function quoteOriginal(original: Original, timeZone: string): string {
  const sender = original.from[0];
  const who = sender ? formatAddr(sender) : "The sender";
  let header = `${who} wrote:`;
  if (original.date && !Number.isNaN(original.date.getTime())) {
    const day = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(original.date);
    const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(original.date);
    // ICU puts a narrow no-break space before AM/PM; plain-text mail is better off with a space.
    header = `On ${day}, at ${time.replace(/ /g, " ")}, ${who} wrote:`;
  }
  const body = original.text.length > QUOTE_CHARS ? `${original.text.slice(0, QUOTE_CHARS)}\n[…]` : original.text;
  const quoted = body
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => (line.startsWith(">") ? `>${line}` : `> ${line}`))
    .join("\n");
  return `${header}\n\n${quoted}`;
}

export function cleanBody(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function snippetOf(text: string | undefined): string | undefined {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}…` : flat;
}

function toDate(value: Date | string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

const LOGIN_HELP =
  "IMAP and SMTP sign in with your iCloud Mail address (ICLOUD_EMAIL) and an app-specific password (ICLOUD_APP_PASSWORD) from account.apple.com. Your regular Apple ID password does not work, and a revoked app-specific password stops working at once.";

function explainImapError(err: unknown): Error {
  const e = err as { authenticationFailed?: boolean; code?: string; responseText?: string };
  const detail = `${e.responseText ?? ""} ${errorText(err)}`;
  if (err instanceof AuthenticationFailure || e.authenticationFailed || /AUTHENTICATIONFAILED|authentication failed/i.test(detail)) {
    return new Error(`iCloud rejected the mail login. ${LOGIN_HELP}`);
  }
  if (e.code && /TIMEOUT|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/.test(e.code)) {
    return new Error(`Could not reach ${IMAP_HOST} (${e.code}). iCloud may be briefly unavailable; try again.`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

function explainSmtpError(err: unknown): Error {
  const e = err as { code?: string; responseCode?: number; response?: string };
  const detail = e.response ?? errorText(err);
  if (e.code === "EAUTH" || e.responseCode === 535) return new Error(`iCloud rejected the SMTP login; nothing was sent. ${LOGIN_HELP}`);
  if (e.code === "EENVELOPE") return new Error(`iCloud refused the message; nothing was sent: ${detail}`);
  if (e.code && /ETIMEDOUT|ECONNECTION|ESOCKET|EDNS|ECONNRESET/.test(e.code)) {
    return new Error(`Could not reach ${SMTP_HOST} (${e.code}); nothing was sent. Try again.`);
  }
  return new Error(`Sending failed: ${detail}`);
}

async function withImap<T>(options: MailOptions, work: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: 993,
    secure: true,
    auth: { user: options.user, pass: options.password },
    logger: false,
    disableAutoIdle: true,
    clientInfo: { name: "icloud-mcp", version: SERVER_VERSION },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
  // After connect, socket failures arrive as 'error' events; unhandled, one would end the process.
  client.on("error", (err: unknown) => console.warn(`IMAP connection error: ${errorText(err)}`));
  try {
    await client.connect();
  } catch (err) {
    client.close();
    throw explainImapError(err);
  }
  try {
    return await work(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

function smtpTransport(options: MailOptions) {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: options.user, pass: options.password },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
}

async function resolveFolder(client: ImapFlow, wanted: string): Promise<string> {
  if (wanted.trim().toLowerCase() === "inbox") return "INBOX";
  const folders = await client.list();
  const match = matchFolder(folders, wanted);
  if (!match) {
    const names = folders.filter((f) => !f.flags.has("\\Noselect")).map((f) => f.path);
    throw new Error(`No folder "${wanted}". Folders: ${names.join(", ")}`);
  }
  return match.path;
}

interface Outgoing {
  from: Addr;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
  messageId: string;
  date: Date;
  headers?: Record<string, string>;
}

export async function buildMime(m: Outgoing, keepBcc: boolean): Promise<Buffer> {
  const mailbox = (a: Addr) => ({ name: a.name ?? "", address: a.address });
  const node = new MailComposer({
    from: mailbox(m.from),
    to: m.to.map(mailbox),
    cc: m.cc.map(mailbox),
    bcc: m.bcc.map(mailbox),
    subject: m.subject,
    text: m.text,
    inReplyTo: m.inReplyTo,
    references: m.references,
    messageId: m.messageId,
    date: m.date,
    headers: m.headers,
  }).compile();
  // The wire copy leaves Bcc out; the copy filed in Sent or Drafts keeps it.
  node.keepBcc = keepBcc;
  return node.build();
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class ICloudMail implements MailApi {
  private readonly fromAddr: Addr;

  constructor(private readonly options: MailOptions) {
    const parsed = addressparser(options.from, { flatten: true })[0];
    this.fromAddr = parsed?.address ? { name: parsed.name || undefined, address: parsed.address } : { address: options.user };
  }

  private self(): Set<string> {
    return new Set([this.options.user, this.fromAddr.address].map((a) => a.toLowerCase()));
  }

  private present(m: FetchMessageObject, folder: string, snippet?: string) {
    const env = m.envelope ?? {};
    const flags = m.flags ?? new Set<string>();
    const date = toDate(env.date) ?? toDate(m.internalDate);
    const list = (a: MessageAddressObject[] | undefined) => {
      const out = fromEnvelope(a).map(formatAddr);
      return out.length ? out : undefined;
    };
    const attachments = listAttachments(m.bodyStructure).length;
    return {
      uid: m.uid,
      folder,
      date: date ? formatInstant(date, this.options.timeZone) : undefined,
      from: list(env.from)?.join(", "),
      to: list(env.to),
      cc: list(env.cc),
      subject: env.subject || "(no subject)",
      unread: !flags.has("\\Seen"),
      flagged: flags.has("\\Flagged") || undefined,
      replied: flags.has("\\Answered") || undefined,
      attachments: attachments || undefined,
      snippet,
    };
  }

  async listFolders(): Promise<unknown> {
    return withImap(this.options, async (client) => {
      const folders: ListResponse[] = await client.list({ statusQuery: { messages: true, unseen: true } });
      const order = ["inbox", "drafts", "sent", "archive", "junk", "trash"];
      const rank = (role: string | undefined) => (role && order.includes(role) ? order.indexOf(role) : order.length);
      const rows = folders
        .filter((f) => !f.flags.has("\\Noselect") && !f.flags.has("\\NonExistent"))
        .map((f) => ({ path: f.path, role: roleOf(f), messages: f.status?.messages, unread: f.status?.unseen }))
        .sort((a, b) => rank(a.role) - rank(b.role) || a.path.localeCompare(b.path));
      return { folders: rows };
    });
  }

  async search(params: SearchParams): Promise<unknown> {
    return withImap(this.options, async (client) => {
      const folder = await resolveFolder(client, params.folder ?? "INBOX");
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const found = (await client.search(buildCriteria(params), { uid: true })) || [];
        const uids = [...found].sort((a, b) => a - b);
        // UIDs grow with arrival, so the highest are the newest.
        const page = uids.slice(-(params.limit ?? DEFAULT_SEARCH_LIMIT));
        const messages = page.length
          ? await client.fetchAll(
              page,
              {
                uid: true,
                envelope: true,
                flags: true,
                internalDate: true,
                bodyStructure: true,
                source: { maxLength: SNIPPET_SOURCE_BYTES },
              },
              { uid: true },
            )
          : [];
        const rows = await Promise.all(
          messages.map(async (m) => {
            let snippet: string | undefined;
            if (m.source) {
              try {
                snippet = snippetOf((await simpleParser(m.source, PARSE_OPTIONS)).text);
              } catch {
                // A message cut off mid-part just goes without a snippet.
              }
            }
            const received = toDate(m.internalDate)?.getTime() ?? 0;
            return { received, row: this.present(m, folder, snippet) };
          }),
        );
        rows.sort((a, b) => b.received - a.received || b.row.uid - a.row.uid);
        return { folder, total_matches: uids.length, showing: rows.length, messages: rows.map((r) => r.row) };
      } finally {
        lock.release();
      }
    });
  }

  async getMessage(params: { folder?: string; uid: number; maxChars?: number }): Promise<unknown> {
    return withImap(this.options, async (client) => {
      const folder = await resolveFolder(client, params.folder ?? "INBOX");
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const m = await client.fetchOne(
          String(params.uid),
          {
            uid: true,
            envelope: true,
            flags: true,
            internalDate: true,
            size: true,
            bodyStructure: true,
            source: { maxLength: MESSAGE_SOURCE_BYTES },
          },
          { uid: true },
        );
        if (!m) {
          throw new Error(`No message with uid ${params.uid} in ${folder}. UIDs belong to one folder and change when a message moves; search again.`);
        }
        const parsed = await simpleParser(m.source ?? Buffer.alloc(0), PARSE_OPTIONS);
        const body = cleanBody(parsed.text ?? "");
        const limit = params.maxChars ?? DEFAULT_BODY_CHARS;
        const replyTo = fromParsed(parsed.replyTo).map(formatAddr);
        const bcc = fromEnvelope(m.envelope?.bcc).map(formatAddr);
        return {
          ...this.present(m, folder),
          message_id: parsed.messageId,
          reply_to: replyTo.length ? replyTo : undefined,
          bcc: bcc.length ? bcc : undefined,
          attachments: listAttachments(m.bodyStructure),
          body: body.length > limit ? `${body.slice(0, limit)}\n[…]` : body,
          body_truncated: body.length > limit ? `${body.length} characters; showing the first ${limit} (raise max_chars for more)` : undefined,
          note: (m.size ?? 0) > MESSAGE_SOURCE_BYTES ? "Large message: the text was read from its first 8 MB" : undefined,
        };
      } finally {
        lock.release();
      }
    });
  }

  private async readOriginal(folderArg: string, uid: number): Promise<{ folder: string; original: Original }> {
    return withImap(this.options, async (client) => {
      const folder = await resolveFolder(client, folderArg);
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const m = await client.fetchOne(String(uid), { uid: true, envelope: true, source: { maxLength: 2 * 1024 * 1024 } }, { uid: true });
        if (!m) throw new Error(`No message with uid ${uid} in ${folder} to reply to. Search again: UIDs change when mail moves.`);
        const parsed = await simpleParser(m.source ?? Buffer.alloc(0), PARSE_OPTIONS);
        const env = m.envelope ?? {};
        const references = typeof parsed.references === "string" ? parsed.references.split(/\s+/) : (parsed.references ?? []);
        return {
          folder,
          original: {
            messageId: parsed.messageId ?? env.messageId,
            references: references.filter(Boolean),
            from: fromEnvelope(env.from),
            replyTo: fromParsed(parsed.replyTo),
            to: fromEnvelope(env.to),
            cc: fromEnvelope(env.cc),
            subject: env.subject ?? parsed.subject ?? "",
            date: parsed.date ?? toDate(env.date),
            text: cleanBody(parsed.text ?? ""),
          },
        };
      } finally {
        lock.release();
      }
    });
  }

  /** Recipients, subject, threading and body for a new message or a reply. */
  private async compose(params: ComposeParams, headers?: Record<string, string>) {
    let to = parseRecipients(params.to, "to");
    let cc = parseRecipients(params.cc, "cc");
    const bcc = dedupe(parseRecipients(params.bcc, "bcc"));
    let subject = params.subject?.trim() ?? "";
    let text = params.body;
    let inReplyTo: string | undefined;
    let references: string[] | undefined;
    let replied: { folder: string; uid: number } | undefined;
    if (params.reply) {
      const { folder, original } = await this.readOriginal(params.reply.folder ?? "INBOX", params.reply.uid);
      const derived = deriveReply(original, this.self(), params.reply.all ?? false);
      if (to.length === 0) to = derived.to;
      cc = [...derived.cc, ...cc];
      if (!subject) subject = derived.subject;
      inReplyTo = derived.inReplyTo;
      references = derived.references;
      text = `${text.replace(/\s+$/, "")}\n\n${quoteOriginal(original, this.options.timeZone)}\n`;
      replied = { folder, uid: params.reply.uid };
    }
    to = dedupe(to);
    cc = dedupe(cc, to.map(addrKey));
    const domain = this.options.user.split("@")[1] ?? "icloud.com";
    const message: Outgoing = {
      from: this.fromAddr,
      to,
      cc,
      bcc,
      subject,
      text,
      inReplyTo,
      references,
      messageId: `<${randomUUID().toUpperCase()}@${domain}>`,
      date: new Date(),
      headers,
    };
    return { message, replied };
  }

  private summary(m: Outgoing) {
    const list = (a: Addr[]) => (a.length ? a.map(formatAddr) : undefined);
    return { from: formatAddr(m.from), to: list(m.to), cc: list(m.cc), bcc: list(m.bcc), subject: m.subject || "(no subject)" };
  }

  async send(params: ComposeParams): Promise<unknown> {
    const { message, replied } = await this.compose(params);
    const recipients = [...message.to, ...message.cc, ...message.bcc].map((a) => a.address);
    if (recipients.length === 0) throw new Error("Add at least one recipient in to, cc or bcc");

    const transport = smtpTransport(this.options);
    let info: { accepted?: unknown[]; rejected?: unknown[] };
    try {
      info = await transport.sendMail({
        envelope: { from: message.from.address, to: recipients },
        raw: await buildMime(message, false),
      });
    } catch (err) {
      throw explainSmtpError(err);
    } finally {
      transport.close();
    }

    // iCloud's SMTP server does not file a copy in Sent Messages; clients do it themselves.
    const notes: string[] = [];
    try {
      await withImap(this.options, async (client) => {
        const sent = await resolveFolder(client, "sent");
        await client.append(sent, await buildMime(message, true), ["\\Seen"], message.date);
        if (replied) {
          const lock = await client.getMailboxLock(replied.folder);
          try {
            await client.messageFlagsAdd(String(replied.uid), ["\\Answered"], { uid: true });
          } finally {
            lock.release();
          }
        }
      });
    } catch (err) {
      notes.push(`The message was sent, but filing the copy in Sent failed: ${errorText(err)}`);
    }
    const rejected = (info.rejected ?? []).map(String);
    return {
      sent: true,
      message_id: message.messageId,
      ...this.summary(message),
      rejected: rejected.length ? rejected : undefined,
      notes: notes.length ? notes : undefined,
    };
  }

  async saveDraft(params: ComposeParams): Promise<unknown> {
    // Apple Mail only reopens a message from Drafts for editing when it carries this header.
    const { message } = await this.compose(params, { "X-Uniform-Type-Identifier": "com.apple.mail-draft" });
    return withImap(this.options, async (client) => {
      const drafts = await resolveFolder(client, "drafts");
      const saved = await client.append(drafts, await buildMime(message, true), ["\\Draft", "\\Seen"], message.date);
      return {
        saved: true,
        folder: drafts,
        uid: saved ? saved.uid : undefined,
        ...this.summary(message),
        note: "Saved to Drafts, not sent. It appears in Apple Mail's Drafts on every device.",
      };
    });
  }

  async mark(params: { folder?: string; uids: number[]; read?: boolean; flagged?: boolean }): Promise<unknown> {
    if (params.read === undefined && params.flagged === undefined) throw new Error("Set read, flagged, or both");
    return withImap(this.options, async (client) => {
      const folder = await resolveFolder(client, params.folder ?? "INBOX");
      const lock = await client.getMailboxLock(folder);
      try {
        const change = async (flag: string, on: boolean | undefined) => {
          if (on === undefined) return;
          if (on) await client.messageFlagsAdd(params.uids, [flag], { uid: true });
          else await client.messageFlagsRemove(params.uids, [flag], { uid: true });
        };
        await change("\\Seen", params.read);
        await change("\\Flagged", params.flagged);
        return { folder, uids: params.uids, read: params.read, flagged: params.flagged };
      } finally {
        lock.release();
      }
    });
  }

  async move(params: { folder?: string; uids: number[]; destination: string }): Promise<unknown> {
    return withImap(this.options, async (client) => {
      const from = await resolveFolder(client, params.folder ?? "INBOX");
      const to = await resolveFolder(client, params.destination);
      if (from === to) throw new Error(`The messages are already in ${to}`);
      const lock = await client.getMailboxLock(from);
      try {
        const result = await client.messageMove(params.uids, to, { uid: true });
        if (!result) throw new Error(`Nothing was moved: no message in ${from} has uid ${params.uids.join(", ")}`);
        const newUids = result.uidMap ? Object.fromEntries([...result.uidMap].map(([oldUid, newUid]) => [String(oldUid), newUid])) : undefined;
        return { moved: params.uids.length, from, to, new_uids: newUids };
      } finally {
        lock.release();
      }
    });
  }

  async verify(): Promise<{ imap: string; smtp: string }> {
    let imap = "ok";
    try {
      await withImap(this.options, async () => undefined);
    } catch (err) {
      imap = errorText(err);
    }
    let smtp = "ok";
    const transport = smtpTransport(this.options);
    try {
      await transport.verify();
    } catch (err) {
      smtp = explainSmtpError(err).message;
    } finally {
      transport.close();
    }
    return { imap, smtp };
  }
}
