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
  handler: UpdateHandler;
}

/** Bounds for the processing started right after a webhook is acknowledged. */
export const AFTER_ACCEPT_LIMITS = { updates: 3, deliveries: 5 } as const;

export function createServices(env: Env): Services {
  const config = readConfig(env);
  return {
    config,
    db: env.DB,
    clock: systemClock,
    ids: randomIds,
    random: Math.random,
    telegram: createTelegramClient(config.telegramBotToken),
    handler: createUpdateHandler(),
  };
}

export function inboxDeps(s: Services): InboxDeps {
  return { db: s.db, clock: s.clock, ids: s.ids, handler: s.handler };
}

export function deliveryDeps(s: Services): DeliveryDeps {
  return { db: s.db, clock: s.clock, ids: s.ids, telegram: s.telegram, random: s.random };
}

export function tickDeps(s: Services): TickDeps {
  return { db: s.db, clock: s.clock, inbox: inboxDeps(s), delivery: deliveryDeps(s) };
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
          await deliverDue(deliveryDeps(s), AFTER_ACCEPT_LIMITS.deliveries, user.id);
        },
      };
    },
  };
}
