import assert from "node:assert/strict";
import { test } from "node:test";
import { simpleParser } from "mailparser";
import {
  buildCriteria,
  buildMime,
  cleanBody,
  deriveReply,
  listAttachments,
  matchFolder,
  parseRecipients,
  quoteOriginal,
} from "../dist/mail.js";

// iCloud's folder list as imapflow reports it (special use detected from the names).
const FOLDERS = [
  { path: "INBOX", name: "INBOX" },
  { path: "Drafts", name: "Drafts", specialUse: "\\Drafts" },
  { path: "Sent Messages", name: "Sent Messages", specialUse: "\\Sent" },
  { path: "Deleted Messages", name: "Deleted Messages", specialUse: "\\Trash" },
  { path: "Junk", name: "Junk", specialUse: "\\Junk" },
  { path: "Archive", name: "Archive", specialUse: "\\Archive" },
  { path: "Receipts", name: "Receipts" },
  { path: "Projects/2026", name: "2026" },
];

const ME = new Set(["me@icloud.com"]);
const addr = (address, name) => ({ address, name });

test("folder arguments resolve by role, exact path, or case-insensitive path and name", () => {
  const path = (wanted) => matchFolder(FOLDERS, wanted)?.path;
  assert.equal(path("sent"), "Sent Messages");
  assert.equal(path("trash"), "Deleted Messages");
  assert.equal(path("Deleted"), "Deleted Messages");
  assert.equal(path("spam"), "Junk");
  assert.equal(path("inbox"), "INBOX");
  assert.equal(path("Sent Messages"), "Sent Messages");
  assert.equal(path("receipts"), "Receipts");
  assert.equal(path("projects/2026"), "Projects/2026");
  assert.equal(path("2026"), "Projects/2026");
  assert.equal(path("Nope"), undefined);
});

test("search criteria: AND of the given fields, dates at UTC midnight, never deleted mail", () => {
  assert.deepEqual(buildCriteria({}), { deleted: false });
  assert.deepEqual(
    buildCriteria({ query: " invoice ", from: "acme", since: { year: 2026, month: 11, day: 1 }, before: { year: 2026, month: 12, day: 1 }, unreadOnly: true, flaggedOnly: true }),
    {
      deleted: false,
      text: "invoice",
      from: "acme",
      since: new Date("2026-11-01T00:00:00Z"),
      before: new Date("2026-12-01T00:00:00Z"),
      seen: false,
      flagged: true,
    },
  );
});

test("attachments come from BODYSTRUCTURE, leaving out images embedded in the HTML body", () => {
  const structure = {
    type: "multipart/mixed",
    childNodes: [
      {
        type: "multipart/alternative",
        childNodes: [
          { part: "1.1", type: "text/plain", parameters: { charset: "utf-8" }, size: 120 },
          {
            type: "multipart/related",
            childNodes: [
              { part: "1.2.1", type: "text/html", size: 900 },
              { part: "1.2.2", type: "image/png", id: "<logo@x>", disposition: "inline", dispositionParameters: { filename: "logo.png" }, encoding: "base64", size: 400 },
            ],
          },
        ],
      },
      { part: "2", type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "Invoice 1042.pdf" }, encoding: "base64", size: 4000 },
      { part: "3", type: "image/jpeg", id: "<photo@x>", disposition: "inline", dispositionParameters: { filename: "IMG_0042.jpeg" }, encoding: "base64", size: 8000 },
      { part: "4", type: "message/rfc822", envelope: { subject: "Fwd: plans" }, size: 3000, childNodes: [{ type: "text/plain" }] },
    ],
  };
  assert.deepEqual(listAttachments(structure), [
    { filename: "Invoice 1042.pdf", content_type: "application/pdf", size_bytes: 3000 },
    { filename: "IMG_0042.jpeg", content_type: "image/jpeg", size_bytes: 6000 },
    { filename: "Fwd: plans.eml", content_type: "message/rfc822", size_bytes: 3000 },
  ]);
  assert.deepEqual(listAttachments({ type: "text/plain", size: 10 }), []);
});

const original = {
  messageId: "<m3@example.com>",
  references: ["<m1@example.com>", "<m2@example.com>"],
  from: [addr("alice@example.com", "Alice")],
  replyTo: [],
  to: [addr("me@icloud.com", "Me"), addr("bob@example.com", "Bob")],
  cc: [addr("carol@example.com"), addr("ME@icloud.com")],
  subject: "Dinner plans",
  date: new Date("2026-11-18T16:43:00Z"),
  text: "Friday works?\n> earlier quote",
};

test("reply goes to the sender; reply-all adds everyone else but never yourself", () => {
  const reply = deriveReply(original, ME, false);
  assert.deepEqual(reply.to, [addr("alice@example.com", "Alice")]);
  assert.deepEqual(reply.cc, []);
  assert.equal(reply.subject, "Re: Dinner plans");
  assert.equal(reply.inReplyTo, "<m3@example.com>");
  assert.deepEqual(reply.references, ["<m1@example.com>", "<m2@example.com>", "<m3@example.com>"]);
  const all = deriveReply(original, ME, true);
  assert.deepEqual(all.cc.map((a) => a.address), ["bob@example.com", "carol@example.com"]);
});

test("reply honors Reply-To, keeps an existing Re:, and answers your own message to its recipients", () => {
  const list = deriveReply({ ...original, replyTo: [addr("team@lists.example.com")], subject: "RE: Dinner" }, ME, false);
  assert.deepEqual(list.to, [addr("team@lists.example.com")]);
  assert.equal(list.subject, "RE: Dinner");
  const mine = { ...original, from: [addr("me@icloud.com")], to: [addr("dave@example.com")], cc: [addr("erin@example.com")] };
  assert.deepEqual(deriveReply(mine, ME, false).to, [addr("dave@example.com")]);
  assert.deepEqual(deriveReply(mine, ME, true).cc, [addr("erin@example.com")]);
  // A note to self still has somewhere to go.
  const note = { ...original, from: [addr("me@icloud.com")], to: [addr("me@icloud.com")], cc: [] };
  assert.deepEqual(deriveReply(note, ME, false).to, [addr("me@icloud.com")]);
});

test("the quoted original has Apple Mail's attribution line in the user's zone", () => {
  assert.equal(
    quoteOriginal(original, "America/New_York"),
    "On Nov 18, 2026, at 11:43 AM, Alice <alice@example.com> wrote:\n\n> Friday works?\n>> earlier quote",
  );
});

test("recipient arguments accept names and comma lists, and reject non-addresses", () => {
  assert.deepEqual(parseRecipients(["Bob Smith <bob@example.com>, carol@example.org", '"Doe, Jane" <jane@example.com>'], "to"), [
    addr("bob@example.com", "Bob Smith"),
    addr("carol@example.org", undefined),
    addr("jane@example.com", "Doe, Jane"),
  ]);
  assert.throws(() => parseRecipients(["bob"], "cc"), /cc: "bob" is not an email address/);
});

test("cleanBody normalizes line endings and collapses runs of blank lines", () => {
  assert.equal(cleanBody("Hi  \r\n\r\n\r\n\r\nthere\r\n\n"), "Hi\n\nthere");
});

test("the MIME message carries threading headers, and Bcc only in the filed copy", async () => {
  const message = {
    from: addr("me@icloud.com", "Me"),
    to: [addr("alice@example.com", "Alice")],
    cc: [],
    bcc: [addr("secret@example.com")],
    subject: "Re: Dinner plans",
    text: "Friday it is.\n\nOn Nov 18 … wrote:",
    inReplyTo: "<m3@example.com>",
    references: ["<m1@example.com>", "<m3@example.com>"],
    messageId: "<ABC@icloud.com>",
    date: new Date("2026-11-18T17:00:00Z"),
    headers: { "X-Uniform-Type-Identifier": "com.apple.mail-draft" },
  };
  const wire = await simpleParser(await buildMime(message, false));
  assert.equal(wire.messageId, "<ABC@icloud.com>");
  assert.equal(wire.inReplyTo, "<m3@example.com>");
  assert.deepEqual(wire.references, ["<m1@example.com>", "<m3@example.com>"]);
  assert.equal(wire.bcc, undefined);
  assert.deepEqual(wire.from.value, [{ address: "me@icloud.com", name: "Me" }]);
  assert.equal(wire.headers.get("x-uniform-type-identifier"), "com.apple.mail-draft");
  assert.equal(wire.text.trim(), "Friday it is.\n\nOn Nov 18 … wrote:");
  const filed = await simpleParser(await buildMime(message, true));
  assert.equal(filed.bcc.text, "secret@example.com");
});
