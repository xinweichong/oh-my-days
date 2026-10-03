import {
  beginAuthorization,
  type ConnectionDeps,
  completeAuthorization,
  inspectLink,
  telegramContinueUrl,
} from "../application/google-connection";
import type { Reaction } from "../application/reactions";
import type { UserRecord } from "../storage/users";
import { connectPage, htmlResponse, outcomePage } from "./pages";

export interface ConnectRouteDeps {
  connection: ConnectionDeps;
  setupPrompt: (user: UserRecord) => Promise<Reaction>;
  /** Delivers queued Telegram messages promptly after a connection completes. */
  afterCallback: () => Promise<void>;
}

const MAX_FORM_BYTES = 2048;

/** GET /connect?t=…: shows the page without consuming the link. */
export async function showConnectPage(request: Request, deps: ConnectRouteDeps): Promise<Response> {
  const token = new URL(request.url).searchParams.get("t");
  const purpose = await inspectLink(deps.connection, token);
  if (!purpose || !token) {
    return htmlResponse(outcomePage("invalid_link", telegramContinueUrl(deps.connection.config)));
  }
  return htmlResponse(connectPage(token));
}

/** POST /oauth/start: consumes the link and redirects to Google. */
export async function startOAuth(request: Request, deps: ConnectRouteDeps): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_FORM_BYTES) return new Response(null, { status: 413 });
  let token: string | null = null;
  try {
    const form = await request.formData();
    const value = form.get("t");
    token = typeof value === "string" ? value : null;
  } catch {
    token = null;
  }
  const url = await beginAuthorization(deps.connection, token);
  if (!url) {
    return htmlResponse(outcomePage("invalid_link", telegramContinueUrl(deps.connection.config)));
  }
  return new Response(null, {
    status: 303,
    headers: { location: url, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

/** GET /oauth/callback: records the outcome, then shows it. */
export async function finishOAuth(
  request: Request,
  deps: ConnectRouteDeps,
  ctx: ExecutionContext,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const outcome = await completeAuthorization(
    deps.connection,
    { state: params.get("state"), code: params.get("code"), error: params.get("error") },
    deps.setupPrompt,
  );
  ctx.waitUntil(deps.afterCallback().catch(() => undefined));
  return htmlResponse(outcomePage(outcome, telegramContinueUrl(deps.connection.config)));
}
