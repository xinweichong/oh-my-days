import type { WebhookDeps } from "./telegram-webhook";
import { handleTelegramWebhook } from "./telegram-webhook";

export interface HttpDeps {
  webhook: () => WebhookDeps;
}

/** Routes are matched exactly; unknown paths reveal nothing about the application. */
export async function route(
  request: Request,
  deps: HttpDeps,
  ctx: ExecutionContext,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  switch (pathname) {
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
