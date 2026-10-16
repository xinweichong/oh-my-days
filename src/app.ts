import { createCalendarHandler } from "./application/calendar-operations";
import { createConversation } from "./application/conversation";
import { eventOperationHandlers } from "./application/event-operations";
import { type ConnectionDeps, connectedCalendar } from "./application/google-connection";
import { type RunnerDeps, runDueOperations } from "./application/operation-runner";
import { type HandlerRegistry, registry } from "./application/operation-types";
import { setupPrompt } from "./application/setup";
import { projectTaskHandler } from "./application/task-projection";
import { reconcileTaskMarkers } from "./application/task-sync";
import type { CalendarDirectoryFactory, CalendarPortFactory } from "./calendar/port";
import { type AppConfig, type Env, readConfig } from "./env";
import {
  type AccessTokenSource,
  createGoogleCalendar,
  type GoogleCalendarApi,
} from "./google/calendar-api";
import { createGoogleOAuth, type GoogleOAuth } from "./google/oauth";
import type { HttpDeps } from "./http/router";
import { type SyncDeps, syncDueCalendars } from "./jobs/calendar-sync";
import { type DeliveryDeps, deliverDue } from "./jobs/delivery";
import { type InboxDeps, processUserInbox } from "./jobs/inbox";
import type { TickDeps } from "./jobs/tick";
import { appUrl } from "./miniapp/entry";
import { createTokenCipher, type TokenCipher } from "./security/token-cipher";
import { type Clock, systemClock } from "./shared/clock";
import { type IdGenerator, randomIds } from "./shared/ids";
import { meteredDb } from "./storage/query-meter";
import { findUserByTelegramId } from "./storage/users";
import { createTelegramClient, type TelegramClient } from "./telegram/client";
import type { UpdateHandler } from "./telegram/router";

/** Everything the application needs from the platform. Tests substitute fakes. */
export interface Services {
  config: AppConfig;
  db: D1Database;
  clock: Clock;
  ids: IdGenerator;
  random: () => number;
  telegram: TelegramClient;
  handlers: HandlerRegistry;
  google: GoogleServices;
  /** Default to the user's Google connection; overridden in tests. */
  calendarFor?: CalendarPortFactory;
  directoryFor?: CalendarDirectoryFactory;
  /** Built from the other services unless overridden. */
  handler?: UpdateHandler;
}

export interface GoogleServices {
  oauth: GoogleOAuth;
  cipher: () => Promise<TokenCipher>;
  calendarApi: (tokens: AccessTokenSource) => GoogleCalendarApi;
}

/**
 * Bounds for the processing started right after a webhook is acknowledged.
 * It runs in the webhook's own invocation, which Workers Free limits to 50 D1
 * queries: one update (its own webhook handles each, and ticks catch any
 * left), then calendar work only while the update was light, then replies.
 */
export const AFTER_ACCEPT_LIMITS = {
  updates: 1,
  operations: 2,
  calendars: 2,
  deliveries: 5,
  /** Above this many queries, calendar work waits for the next tick (about a minute). */
  lightUpdateQueries: 24,
} as const;

export function createServices(env: Env): Services {
  const config = readConfig(env);
  return {
    config,
    db: env.DB,
    clock: systemClock,
    ids: randomIds,
    random: Math.random,
    telegram: createTelegramClient(config.telegramBotToken),
    handlers: registry(
      ...eventOperationHandlers,
      createCalendarHandler(config),
      projectTaskHandler,
    ),
    google: {
      oauth: createGoogleOAuth({
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        redirectUri: `${config.publicBaseUrl}/oauth/callback`,
      }),
      cipher: memoize(() => createTokenCipher(config.tokenEncryptionKey)),
      calendarApi: (tokens) => createGoogleCalendar(tokens),
    },
  };
}

function memoize<T>(make: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | null = null;
  return () => {
    value ??= make();
    return value;
  };
}

export function connectionDeps(s: Services): ConnectionDeps {
  return {
    db: s.db,
    clock: s.clock,
    ids: s.ids,
    config: s.config,
    oauth: s.google.oauth,
    cipher: s.google.cipher,
    calendarApi: s.google.calendarApi,
  };
}

function setupDeps(s: Services) {
  return { db: s.db, clock: s.clock, ids: s.ids, config: s.config };
}

export function updateHandler(s: Services): UpdateHandler {
  return (
    s.handler ??
    createConversation({
      ...setupDeps(s),
      handlers: s.handlers,
      sourceFor: (userId) => connectedCalendar(connectionDeps(s), userId),
    })
  );
}

export function inboxDeps(s: Services): InboxDeps {
  return { db: s.db, clock: s.clock, ids: s.ids, handler: updateHandler(s) };
}

export function runnerDeps(s: Services): RunnerDeps {
  return {
    db: s.db,
    clock: s.clock,
    ids: s.ids,
    random: s.random,
    handlers: s.handlers,
    calendarFor: s.calendarFor ?? ((userId) => connectedCalendar(connectionDeps(s), userId)),
    directoryFor: s.directoryFor ?? ((userId) => connectedCalendar(connectionDeps(s), userId)),
  };
}

export function syncDeps(s: Services): SyncDeps {
  return {
    db: s.db,
    clock: s.clock,
    ids: s.ids,
    random: s.random,
    sourceFor: (userId) => connectedCalendar(connectionDeps(s), userId),
    reconcile: (userId, calendarId, items, now, guard) =>
      reconcileTaskMarkers({ db: s.db, ids: s.ids }, userId, calendarId, items, now, guard),
  };
}

export function deliveryDeps(s: Services): DeliveryDeps {
  return { db: s.db, clock: s.clock, ids: s.ids, telegram: s.telegram, random: s.random };
}

export function tickDeps(s: Services): TickDeps {
  return {
    db: s.db,
    clock: s.clock,
    inbox: inboxDeps(s),
    runner: runnerDeps(s),
    delivery: deliveryDeps(s),
    sync: syncDeps(s),
    reminders: {
      db: s.db,
      clock: s.clock,
      ids: s.ids,
      sourceFor: (userId) => connectedCalendar(connectionDeps(s), userId),
      appUrl: appUrl(s.config),
    },
    expiry: { db: s.db, clock: s.clock, ids: s.ids, ttlDays: s.config.testingTokenTtlDays },
  };
}

export function httpDeps(services: () => Services): HttpDeps {
  return {
    webhook: () => {
      const s = services();
      return {
        config: s.config,
        db: s.db,
        clock: s.clock,
        ids: s.ids,
        afterAccept: async (telegramUserId) => {
          const meter = meteredDb(s.db);
          const m: Services = { ...s, db: meter.db };
          const user = await findUserByTelegramId(m.db, telegramUserId);
          if (!user) return;
          await processUserInbox(inboxDeps(m), user.id, AFTER_ACCEPT_LIMITS.updates);
          if (meter.used() <= AFTER_ACCEPT_LIMITS.lightUpdateQueries) {
            await runDueOperations(runnerDeps(m), AFTER_ACCEPT_LIMITS.operations, user.id);
            // Runs only calendars already due, e.g. after Force poll.
            await syncDueCalendars(syncDeps(m), AFTER_ACCEPT_LIMITS.calendars, user.id);
          }
          // Replies always go now, so a heavy update still answers at once.
          await deliverDue(deliveryDeps(m), AFTER_ACCEPT_LIMITS.deliveries, user.id);
        },
      };
    },
    connect: () => {
      const s = services();
      return {
        connection: connectionDeps(s),
        setupPrompt: (user) => setupPrompt(setupDeps(s), user),
        afterCallback: async () => {
          await deliverDue(deliveryDeps(s), AFTER_ACCEPT_LIMITS.deliveries);
        },
      };
    },
    contactEmail: () => services().config.contactEmail,
    liveness: () => {
      const s = services();
      return { db: s.db, clock: s.clock };
    },
    miniApp: () => {
      const s = services();
      return {
        config: s.config,
        db: s.db,
        clock: s.clock,
        ids: s.ids,
        handlers: s.handlers,
        sourceFor: (userId) => connectedCalendar(connectionDeps(s), userId),
      };
    },
  };
}
