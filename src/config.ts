/**
 * Configuration from the environment, checked once at startup.
 *
 * Secret Manager stores bytes verbatim, so a secret created with `echo` or
 * pasted into the console carries a trailing newline. An untrimmed SECRET_PATH
 * never matches a path segment and an untrimmed password never logs in, so
 * every value is trimmed here, with a warning that says so.
 */

import { checkTimeZone } from "./time.js";

export interface Config {
  /** First path segment of every gated route: the connector's only credential. */
  SECRET_PATH: string;
  /** iCloud Mail address: IMAP and SMTP login, and the default From. */
  ICLOUD_EMAIL: string;
  /** App-specific password from account.apple.com. */
  ICLOUD_APP_PASSWORD: string;
  /** CalDAV login. Defaults to ICLOUD_EMAIL, which iCloud accepts in place of the Apple ID. */
  ICLOUD_APPLE_ID: string;
  /** From header for outgoing mail, e.g. "Jane Doe <jane@icloud.com>". Defaults to ICLOUD_EMAIL. */
  ICLOUD_FROM: string;
  /** IANA zone for showing times and reading wall-clock arguments. */
  DEFAULT_TIMEZONE: string;
  /** Hide every tool that sends mail or changes anything. */
  READ_ONLY: boolean;
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function loadConfig(source: NodeJS.ProcessEnv = process.env, warn: (message: string) => void = console.warn): Config {
  const read = (name: string): string => {
    const raw = source[name] ?? "";
    const value = raw.trim();
    if (value !== raw && value) warn(`${name} had surrounding whitespace; trimmed ${raw.length - value.length} character(s)`);
    return value;
  };

  const SECRET_PATH = read("SECRET_PATH");
  const ICLOUD_EMAIL = read("ICLOUD_EMAIL");
  const ICLOUD_APP_PASSWORD = read("ICLOUD_APP_PASSWORD");
  const missing = Object.entries({ SECRET_PATH, ICLOUD_EMAIL, ICLOUD_APP_PASSWORD })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);

  if (SECRET_PATH.length < 32) warn("SECRET_PATH is shorter than 32 characters; generate one with: openssl rand -hex 32");
  if (!EMAIL_RE.test(ICLOUD_EMAIL)) throw new Error("ICLOUD_EMAIL is not an email address");
  // App-specific passwords are four groups of four lowercase letters. Anything
  // else is most likely the Apple ID password, which iCloud refuses here.
  if (!/^[a-z]{4}-?[a-z]{4}-?[a-z]{4}-?[a-z]{4}$/.test(ICLOUD_APP_PASSWORD)) {
    warn(
      "ICLOUD_APP_PASSWORD does not look like an app-specific password (xxxx-xxxx-xxxx-xxxx); iCloud refuses the regular Apple ID password for IMAP, SMTP and CalDAV",
    );
  }

  const ICLOUD_APPLE_ID = read("ICLOUD_APPLE_ID") || ICLOUD_EMAIL;
  if (!EMAIL_RE.test(ICLOUD_APPLE_ID)) throw new Error("ICLOUD_APPLE_ID is not an email address");
  const ICLOUD_FROM = read("ICLOUD_FROM") || ICLOUD_EMAIL;
  const DEFAULT_TIMEZONE = checkTimeZone(read("DEFAULT_TIMEZONE") || "UTC", "DEFAULT_TIMEZONE");
  const READ_ONLY = /^(1|true|yes|on)$/i.test(read("READ_ONLY"));

  return { SECRET_PATH, ICLOUD_EMAIL, ICLOUD_APP_PASSWORD, ICLOUD_APPLE_ID, ICLOUD_FROM, DEFAULT_TIMEZONE, READ_ONLY };
}
