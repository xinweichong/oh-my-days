import { createCallbackHandler } from "./application/callbacks";
import { eventOperationHandlers } from "./application/event-operations";
import { type RunnerDeps, runDueOperations } from "./application/operation-runner";
import { type HandlerRegistry, registry } from "./application/operation-types";
import type { CalendarPortFactory } from "./calendar/port";
import { type AppConfig, type Env, readConfig } from "./env";
import type { HttpDeps } from "./http/router";
import { type DeliveryDeps, deliverDue } from "./jobs/delivery";
import { type InboxDeps, processUserInbox } from "./jobs/inbox";
import type { TickDeps } from "./jobs/tick";
import { type Clock, systemClock } from "./shared/clock";
import { type IdGenerator, randomIds } from "./shared/ids";
import { findUserByTelegramId } from "./storage/users";
import { createTelegramClient, type TelegramClient } from "./telegram/client";
import { createUpdateHandler, type UpdateHandler } from "./telegram/router";

/** Everything the application needs from the platform. Tests substitute fakes. */
export interface Services {
  config: AppConfig;
  db: D1Database;
  clock: Clock;
  ids: IdGenerator;
  random: () => number;
  telegram: TelegramClient;
  handlers: HandlerRegistry;
  calendarFor: CalendarPortFactory;
  /** Built from the other services unless overridden. */
  handler?: UpdateHandler;
}

/** Bounds for the processing started right after a webhook is acknowledged. */
export const AFTER_ACCEPT_LIMITS = { updates: 3, operations: 2, deliveries: 5 } as const;

export function createServices(env: Env): Services {
  const config = readConfig(env);
  return {
    config,
    db: env.DB,
    clock: systemClock,
    ids: randomIds,
    random: Math.random,
    telegram: createTelegramClient(config.telegramBotToken),
    handlers: registry(...eventOperationHandlers),
    // No Google connection exists until backend stage 3; operations that need
    // Calendar report that reconnection is required instead of guessing.
    calendarFor: async () => null,
  };
}

export function updateHandler(s: Services): UpdateHandler {
  return (
    s.handler ??
    createUpdateHandler({
      onCallback: createCallbackHandler({
        db: s.db,
        clock: s.clock,
        ids: s.ids,
        handlers: s.handlers,
      }),
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
    calendarFor: s.calendarFor,
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
          const user = await findUserByTelegramId(s.db, telegramUserId);
          if (!user) return;
          await processUserInbox(inboxDeps(s), user.id, AFTER_ACCEPT_LIMITS.updates);
          await runDueOperations(runnerDeps(s), AFTER_ACCEPT_LIMITS.operations, user.id);
          await deliverDue(deliveryDeps(s), AFTER_ACCEPT_LIMITS.deliveries, user.id);
        },
      };
    },
  };
}
