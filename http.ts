/**
 * Minimal HTTP plumbing: routing, CORS, auth, JSON responses.
 *
 * Deliberately dependency-free — a router this small is less code than wiring a
 * framework, and it keeps the Deno Deploy cold start negligible.
 */

import type { Config } from "./config.ts";

export type Handler = (ctx: RequestContext) => Promise<Response> | Response;

export interface RequestContext {
  request: Request;
  url: URL;
  /** Path parameters captured from the route pattern. */
  params: Record<string, string>;
  cfg: Config;
  /** The caller's Filedgr JWT, when they relayed one. */
  callerJwt: string | null;
}

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  /** Public routes skip the session-secret check (SME upload pages, health). */
  publicRoute: boolean;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly detail?: unknown) {
    super(message);
    this.name = "HttpError";
  }
}

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export class Router {
  private readonly routes: Route[] = [];

  private add(method: string, pattern: string, handler: Handler, publicRoute: boolean): this {
    this.routes.push({
      method,
      segments: pattern.split("/").filter(Boolean),
      handler,
      publicRoute,
    });
    return this;
  }

  get = (p: string, h: Handler) => this.add("GET", p, h, false);
  post = (p: string, h: Handler) => this.add("POST", p, h, false);
  put = (p: string, h: Handler) => this.add("PUT", p, h, false);
  delete = (p: string, h: Handler) => this.add("DELETE", p, h, false);

  /** Reachable without the session secret — SME links and health checks. */
  publicGet = (p: string, h: Handler) => this.add("GET", p, h, true);
  publicPost = (p: string, h: Handler) => this.add("POST", p, h, true);

  private match(
    method: string,
    path: string,
  ): { route: Route; params: Record<string, string> } | null {
    const parts = path.split("/").filter(Boolean);

    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;

      const params: Record<string, string> = {};
      let matched = true;

      for (let i = 0; i < route.segments.length; i++) {
        const segment = route.segments[i]!;
        const part = parts[i]!;
        if (segment.startsWith(":")) {
          params[segment.slice(1)] = decodeURIComponent(part);
        } else if (segment !== part) {
          matched = false;
          break;
        }
      }

      if (matched) return { route, params };
    }
    return null;
  }

  async handle(request: Request, cfg: Config): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin, cfg);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const hit = this.match(request.method, url.pathname);
    if (!hit) {
      return withHeaders(json({ error: "Not found", path: url.pathname }, 404), cors);
    }

    try {
      if (!hit.route.publicRoute) {
        assertSession(request, cfg);
      }

      const response = await hit.route.handler({
        request,
        url,
        params: hit.params,
        cfg,
        callerJwt: readBearer(request),
      });
      return withHeaders(response, cors);
    } catch (error) {
      return withHeaders(toErrorResponse(error), cors);
    }
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * The SPA presents a shared secret so this server is not an open relay to the
 * Filedgr bot credential. It is not user authentication — the caller's identity
 * comes from the relayed Filedgr JWT, which the platform verifies.
 */
function assertSession(request: Request, cfg: Config): void {
  const presented = request.headers.get("x-ws-session");
  if (!presented || !timingSafeEqual(presented, cfg.sessionSecret)) {
    throw new HttpError(401, "Missing or invalid x-ws-session header");
  }
}

function readBearer(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

/** Constant-time compare, so the secret cannot be recovered by timing. */
function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  // Compare lengths without short-circuiting on content.
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/** Require a relayed caller JWT — used by routes that act as the auditor. */
export function requireCallerJwt(ctx: RequestContext): string {
  if (!ctx.callerJwt) {
    throw new HttpError(401, "This action requires the auditor's Filedgr token");
  }
  return ctx.callerJwt;
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

function corsHeaders(origin: string | null, cfg: Config): Record<string, string> {
  // Echo only allow-listed origins. Reflecting an arbitrary Origin would let any
  // site drive this server with a user's session header.
  const allowed = origin && cfg.allowedOrigins.includes(origin) ? origin : cfg.allowedOrigins[0];
  return {
    "Access-Control-Allow-Origin": allowed ?? "",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, x-ws-session",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) merged.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function toErrorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ error: error.message, detail: error.detail }, error.status);
  }

  // Never reflect an internal message to the browser — upstream Filedgr errors
  // can carry request context. Log it, return something generic.
  console.error("Unhandled server error:", error);
  return json({ error: "Internal server error" }, 500);
}
