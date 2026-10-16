import { handleAppApi, type MiniAppDeps } from "../miniapp/api";
import { FIGTREE_PATH } from "../miniapp/generated/font";
import { appFont, appPage, appScript } from "../miniapp/page";
import type { Clock } from "../shared/clock";
import { lastTickAt, MAX_TICK_AGE_MS } from "../storage/app-state";
import { type ConnectRouteDeps, finishOAuth, showConnectPage, startOAuth } from "./connect-routes";
import { htmlResponse, privacyPage } from "./pages";
import type { WebhookDeps } from "./telegram-webhook";
import { handleTelegramWebhook } from "./telegram-webhook";

export interface HttpDeps {
  webhook: () => WebhookDeps;
  connect: () => ConnectRouteDeps;
  contactEmail: () => string | null;
  liveness: () => LivenessDeps;
  miniApp: () => MiniAppDeps;
}

export interface LivenessDeps {
  db: D1Database;
  clock: Clock;
}

/**
 * Routes are matched exactly; unknown paths reveal nothing about the application.
 * The landing page at / is a static asset served before the Worker runs (ADR 0006).
 */
export async function route(
  request: Request,
  deps: HttpDeps,
  ctx: ExecutionContext,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/app/api/")) return handleAppApi(request, deps.miniApp());
  switch (pathname) {
    case "/app":
      return request.method === "GET" ? appPage() : methodNotAllowed("GET");
    case "/app/app.js":
      return request.method === "GET" ? appScript() : methodNotAllowed("GET");
    case FIGTREE_PATH:
      return request.method === "GET" ? appFont() : methodNotAllowed("GET");
    case "/privacy":
      return request.method === "GET"
        ? htmlResponse(privacyPage(deps.contactEmail()))
        : methodNotAllowed("GET");
    case "/connect":
      return request.method === "GET"
        ? showConnectPage(request, deps.connect())
        : methodNotAllowed("GET");
    case "/oauth/start":
      return request.method === "POST"
        ? startOAuth(request, deps.connect())
        : methodNotAllowed("POST");
    case "/oauth/callback":
      return request.method === "GET"
        ? finishOAuth(request, deps.connect(), ctx)
        : methodNotAllowed("GET");
    case "/healthz":
      return request.method === "GET" ? liveness(deps.liveness()) : methodNotAllowed("GET");
    case "/telegram/webhook":
      return request.method === "POST"
        ? handleTelegramWebhook(request, deps.webhook(), ctx)
        : methodNotAllowed("POST");
    default:
      return new Response("Not found", { status: 404 });
  }
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Minimal liveness: the Worker answers, and the scheduler ran recently. Reports
 * only the age of the last tick; no user or provider details.
 */
async function liveness(deps: LivenessDeps): Promise<Response> {
  const last = await lastTickAt(deps.db);
  if (last === null) return text("stale tick_age_s=unknown", 503);
  const age = Math.max(0, deps.clock.now() - last);
  const body = `tick_age_s=${Math.floor(age / 1000)}`;
  return age > MAX_TICK_AGE_MS ? text(`stale ${body}`, 503) : text(`ok ${body}`);
}

function methodNotAllowed(allow: string): Response {
  return new Response(null, { status: 405, headers: { allow } });
}
