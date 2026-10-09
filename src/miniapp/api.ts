import type { SourceFor } from "../application/calendar-view";
import type { HandlerRegistry } from "../application/operation-types";
import { isValidLocalDate } from "../domain/time";
import type { AppConfig } from "../env";
import type { Clock } from "../shared/clock";
import type { IdGenerator } from "../shared/ids";
import { logEvent } from "../shared/log";
import { findUserByTelegramId, type UserRecord } from "../storage/users";
import { verifyInitData } from "./init-data";
import { homeView, recentView, taskDetail, taskSetView, todayView, weekView } from "./views";
import { handleWrite } from "./writes";

/**
 * The Mini App JSON API (ADR 0005). Every request is authenticated from signed
 * Telegram `initData`; every query is scoped to that user. Errors carry a
 * short code only, never user data.
 */

export interface MiniAppDeps {
  config: AppConfig;
  db: D1Database;
  clock: Clock;
  ids: IdGenerator;
  sourceFor: SourceFor;
  handlers: HandlerRegistry;
}

const PREFIX = "/app/api/";

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

export function apiError(code: string, status: number): Response {
  return json({ error: code }, status);
}

/** The signed-in user, or the response to send instead. */
export async function authenticate(
  request: Request,
  deps: Pick<MiniAppDeps, "config" | "db" | "clock">,
): Promise<{ user: UserRecord } | { response: Response }> {
  const header = request.headers.get("authorization") ?? "";
  const raw = header.startsWith("tma ") ? header.slice(4) : null;
  const check = await verifyInitData(raw, deps.config.telegramBotToken, deps.clock.now());
  if (!check.ok) {
    logEvent("miniapp.auth_refused", { reason: check.reason });
    return { response: apiError(check.reason === "stale" ? "expired" : "unauthorized", 401) };
  }
  if (!deps.config.allowedTelegramUserIds.has(check.telegramUserId)) {
    return { response: apiError("unauthorized", 401) };
  }
  const user = await findUserByTelegramId(deps.db, check.telegramUserId);
  if (user?.status !== "active") return { response: apiError("unauthorized", 401) };
  if (user.setupStep !== "done") return { response: apiError("setup_incomplete", 409) };
  return { user };
}

export async function handleAppApi(request: Request, deps: MiniAppDeps): Promise<Response> {
  const auth = await authenticate(request, deps);
  if ("response" in auth) return auth.response;
  const { user } = auth;
  const url = new URL(request.url);
  const path = url.pathname.slice(PREFIX.length);
  const now = deps.clock.now();

  if (request.method === "POST") return handleWrite(request, path, user, deps);
  if (request.method !== "GET") return apiError("method_not_allowed", 405);

  switch (path) {
    case "home":
      return json(await homeView(deps, user, now));
    case "today":
      return json(await todayView(deps, user, now));
    case "week": {
      const start = url.searchParams.get("start");
      if (start !== null && !isValidLocalDate(start)) return apiError("bad_request", 400);
      return json(await weekView(deps, user, now, start));
    }
    case "recent":
      return json(await recentView(deps, user, now));
    case "tasks": {
      const view = url.searchParams.get("view");
      const listId = url.searchParams.get("list") ?? "";
      const set =
        view === "overdue"
          ? ({ view } as const)
          : view === "no_deadline"
            ? ({ view } as const)
            : view === "list" && listId
              ? ({ view, listId } as const)
              : null;
      if (!set) return apiError("bad_request", 400);
      const result = await taskSetView(deps, user, now, set);
      return result ? json(result) : apiError("not_found", 404);
    }
    default: {
      const m = /^tasks\/([A-Za-z0-9_-]{1,64})$/.exec(path);
      if (m?.[1]) {
        const detail = await taskDetail(deps, user, now, m[1]);
        return detail ? json(detail) : apiError("not_found", 404);
      }
      return apiError("not_found", 404);
    }
  }
}
