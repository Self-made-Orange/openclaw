// CLAW-FORK: lightweight localhost-only static HTTP server for vault `output/`
// artifacts. Used so Slack action buttons can open uploaded HTML directly in
// Chrome (click → http://127.0.0.1:<port>/<file> → browser renders inline).
//
// Why a separate server:
//   - The gateway HTTP server (canvas mount) requires Bearer auth, which a Slack
//     button URL can't carry. Adding a no-auth route to the gateway is invasive
//     and risks loosening the auth model.
//   - This server binds 127.0.0.1 only, so even on a multi-NIC WSL host nothing
//     remote can reach it. WSL2 localhost forwarding still lets Chrome on
//     Windows host open the URL transparently.
//   - Single-purpose (read-only static file serve from one directory). Simpler
//     to reason about than reusing canvas infra.
//
// Lifecycle: the server is a process-lifetime singleton spun up lazily on first
// successful file upload. There's no graceful shutdown hook because gateway
// process exit terminates it via OS process teardown.

import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

// CLAW-FORK: file written by openclaw-tunnel-runner.sh holding the active
// cloudflared quick-tunnel URL (https://*.trycloudflare.com). Read on demand
// because the URL is ephemeral and may change across tunnel restarts.
const TUNNEL_URL_FILE = "/tmp/openclaw-tunnel-url";

export function readTunnelUrl(): string | undefined {
  try {
    const raw = readFileSync(TUNNEL_URL_FILE, "utf8").trim();
    if (raw && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(raw)) {
      return raw;
    }
  } catch {
    // file missing → tunnel not running, caller falls back.
  }
  return undefined;
}

export function buildTunnelUrl(filePath: string, rootDir: string): string | undefined {
  const tunnel = readTunnelUrl();
  if (!tunnel) return undefined;
  const rel = path.relative(rootDir, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return undefined;
  }
  const encoded = rel
    .split(path.sep)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `${tunnel.replace(/\/$/, "")}/${encoded}`;
}

const DEFAULT_PORT = Number(process.env.CLAW_OUTPUT_STATIC_PORT ?? "18790");
const DEFAULT_HOST = "127.0.0.1";

type StaticServerState = {
  server: Server;
  port: number;
  host: string;
  rootDir: string;
};

let state: StaticServerState | undefined;

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function resolveMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function ensureWithinRoot(rootDir: string, requested: string): string | null {
  // Reject path traversal attempts. requested already includes leading slash.
  const cleaned = requested.replace(/^\/+/, "");
  if (!cleaned) return null;
  const candidate = path.resolve(rootDir, cleaned);
  const rootResolved = path.resolve(rootDir);
  if (!candidate.startsWith(rootResolved + path.sep) && candidate !== rootResolved) {
    return null;
  }
  return candidate;
}

export function ensureOutputStaticServer(rootDir: string): StaticServerState {
  if (state) return state;
  const server = createServer((req, res) => {
    if (!req.url || req.method !== "GET") {
      res.statusCode = 405;
      res.end();
      return;
    }
    // Strip query string
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    const filePath = ensureWithinRoot(rootDir, urlPath);
    if (!filePath) {
      res.statusCode = 400;
      res.end("invalid path");
      return;
    }
    let stats;
    try {
      stats = statSync(filePath);
    } catch {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    if (!stats.isFile()) {
      res.statusCode = 404;
      res.end("not a file");
      return;
    }
    res.setHeader("Content-Type", resolveMimeType(filePath));
    res.setHeader("Content-Length", String(stats.size));
    res.setHeader("Cache-Control", "no-store");
    // CSP/safety: no need to set anything aggressive here since this is a
    // localhost-only viewer for the user's own artifacts. Browsers will render
    // inline for HTML, otherwise prompt to download.
    createReadStream(filePath).pipe(res);
  });
  server.on("error", () => {
    // If the bind fails (port in use), state.server stays as-is and subsequent
    // ensureOutputStaticServer calls will retry. We don't crash the gateway.
    state = undefined;
  });
  server.listen(DEFAULT_PORT, DEFAULT_HOST);
  state = {
    server,
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    rootDir,
  };
  return state;
}

export function buildOutputStaticUrl(filePath: string, rootDir: string): string | undefined {
  const s = ensureOutputStaticServer(rootDir);
  const rel = path.relative(s.rootDir, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return undefined;
  }
  // Encode each path segment so spaces/non-ascii are safe in URL.
  const encoded = rel
    .split(path.sep)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `http://${s.host}:${s.port}/${encoded}`;
}
