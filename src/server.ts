/**
 * Node HTTP adapter for Cloud Run.
 *
 * Cloud Run gives us a Node process and a $PORT; the handler in mcp.ts speaks
 * the Web Request/Response API. This file is the only glue between them, plus
 * the wiring of real iCloud services to the configuration.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { CalDavClient } from "./caldav.js";
import { ICloudCalendar } from "./calendar.js";
import { loadConfig, type Config } from "./config.js";
import { ICloudMail } from "./mail.js";
import { createApp, handleRequest, secretMatches, SERVER_INFO, type App } from "./mcp.js";
import type { Services } from "./tools.js";

/** Far above any JSON-RPC request this server expects; anything bigger is not for us. */
const MAX_BODY_BYTES = 1024 * 1024;

export function buildServices(config: Config): Services {
  const ownerName = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(config.ICLOUD_FROM)?.[1]?.trim() || undefined;
  const dav = new CalDavClient({
    username: config.ICLOUD_APPLE_ID,
    password: config.ICLOUD_APP_PASSWORD,
    userAgent: `${SERVER_INFO.name}/${SERVER_INFO.version}`,
  });
  return {
    mail: new ICloudMail({
      user: config.ICLOUD_EMAIL,
      password: config.ICLOUD_APP_PASSWORD,
      from: config.ICLOUD_FROM,
      timeZone: config.DEFAULT_TIMEZONE,
    }),
    calendar: new ICloudCalendar({
      dav,
      defaultTimeZone: config.DEFAULT_TIMEZONE,
      owner: { email: config.ICLOUD_EMAIL, name: ownerName },
    }),
  };
}

/**
 * Log the shape of traffic, never its contents. The first segment of a gated
 * route is the URL secret, so it never reaches the log: the marker says only
 * whether it matched, which is what separates a wrong-secret 404 from a
 * wrong-route one.
 */
export function redactPath(path: string, secret: string): string {
  const segments = path.split("/");
  const first = segments[1];
  if (first && first !== "status" && first !== "healthz") segments[1] = secretMatches(first, secret) ? ":secret" : ":bad-secret";
  return segments.join("/");
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Rebuild the externally visible URL: Cloud Run terminates TLS in front of us. */
function externalUrl(req: IncomingMessage): string {
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() || "http";
  return `${proto}://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
}

function toRequest(req: IncomingMessage, body: Buffer): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD" && body.length > 0;
  return new Request(externalUrl(req), { method, headers, body: hasBody ? new Uint8Array(body) : undefined });
}

export function createHttpServer(app: App): Server {
  return createServer(async (req, res) => {
    const started = Date.now();
    const path = redactPath((req.url ?? "/").split("?")[0], app.config.SECRET_PATH);
    try {
      const response = await handleRequest(toRequest(req, await readBody(req)), app);
      const body = Buffer.from(await response.arrayBuffer());
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      if (body.length > 0) headers["content-length"] = String(body.length);
      res.writeHead(response.status, headers);
      res.end(body.length > 0 ? body : undefined);
      app.log(`${req.method} ${path} -> ${response.status} (${Date.now() - started}ms)`);
    } catch (err) {
      if (err instanceof BodyTooLarge) {
        if (!res.headersSent) res.writeHead(413).end();
        app.log(`${req.method} ${path} -> 413 (body over ${MAX_BODY_BYTES} bytes)`);
        return;
      }
      console.error(`Unhandled error on ${req.method} ${path}:`, err instanceof Error ? (err.stack ?? err.message) : err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      } else {
        res.end();
      }
    }
  });
}

function main(): void {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const app = createApp(config, buildServices(config));
  const port = Number(process.env.PORT ?? 8080);
  const server = createHttpServer(app);
  // The secret itself stays out of the logs; its length is enough to confirm
  // the deploy picked up the version you think it did.
  server.listen(port, () =>
    console.log(
      `${SERVER_INFO.name} ${SERVER_INFO.version} listening on :${port} (secret path segment: ${config.SECRET_PATH.length} chars, ${app.tools.length} tools${config.READ_ONLY ? ", read-only" : ""}, times in ${config.DEFAULT_TIMEZONE})`,
    ),
  );

  // A stray rejection from a dropped iCloud connection should cost one request, not the instance.
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason instanceof Error ? (reason.stack ?? reason.message) : reason);
  });

  // Cloud Run sends SIGTERM before reclaiming an idle instance.
  process.on("SIGTERM", () => {
    console.log("SIGTERM received, closing");
    server.close(() => process.exit(0));
  });
}

// Only start a listener when run directly, so tests can import createHttpServer.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
