import { type ConnectRouteDeps, finishOAuth, showConnectPage, startOAuth } from "./connect-routes";
import { homePage, htmlResponse, privacyPage } from "./pages";
import type { WebhookDeps } from "./telegram-webhook";
import { handleTelegramWebhook } from "./telegram-webhook";

export interface HttpDeps {
  webhook: () => WebhookDeps;
  connect: () => ConnectRouteDeps;
  contactEmail: () => string | null;
}

/** Routes are matched exactly; unknown paths reveal nothing about the application. */
export async function route(
  request: Request,
  deps: HttpDeps,
  ctx: ExecutionContext,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  switch (pathname) {
    case "/":
      return request.method === "GET" ? htmlResponse(homePage()) : methodNotAllowed("GET");
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
      return request.method === "GET" ? text("ok") : methodNotAllowed("GET");
    case "/telegram/webhook":
      return request.method === "POST"
        ? handleTelegramWebhook(request, deps.webhook(), ctx)
        : methodNotAllowed("POST");
    default:
      return new Response("Not found", { status: 404 });
  }
}

function text(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function methodNotAllowed(allow: string): Response {
  return new Response(null, { status: 405, headers: { allow } });
}
