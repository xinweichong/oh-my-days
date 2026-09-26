import type { Services } from "../../src/app";
import type { AppConfig } from "../../src/env";
import type { Clock } from "../../src/shared/clock";
import type { IdGenerator } from "../../src/shared/ids";
import type { TelegramCall } from "../../src/telegram/api";
import type { TelegramClient, TelegramResult } from "../../src/telegram/client";
import { createUpdateHandler } from "../../src/telegram/router";

export const T0 = Date.UTC(2026, 8, 25, 1, 0, 0); // 2026-09-25 09:00 Asia/Singapore

export class FakeClock implements Clock {
  constructor(public current = T0) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export class SequentialIds implements IdGenerator {
  private n = 0;
  constructor(private readonly prefix = "id") {}
  next(): string {
    this.n++;
    return `${this.prefix}${String(this.n).padStart(6, "0")}`;
  }
}

/** Records calls; replies with scripted results, defaulting to success. */
export class FakeTelegram implements TelegramClient {
  readonly calls: TelegramCall[] = [];
  private readonly script: TelegramResult[] = [];
  private nextMessageId = 500;

  willReturn(...results: TelegramResult[]): this {
    this.script.push(...results);
    return this;
  }

  async call(call: TelegramCall): Promise<TelegramResult> {
    this.calls.push(call);
    return this.script.shift() ?? { kind: "ok", messageId: this.nextMessageId++ };
  }

  texts(): string[] {
    return this.calls.flatMap((c) => ("text" in c.params && c.params.text ? [c.params.text] : []));
  }
}

export const OWNER = 1001;
export const OTHER_USER = 1002;
export const STRANGER = 9999;

export const testConfig: AppConfig = {
  telegramBotToken: "test-bot-token",
  telegramWebhookSecret: "test-webhook-secret",
  allowedTelegramUserIds: new Set([OWNER, OTHER_USER]),
};

export function testServices(db: D1Database, overrides: Partial<Services> = {}): Services {
  return {
    config: testConfig,
    db,
    clock: new FakeClock(),
    ids: new SequentialIds(),
    random: () => 0.5,
    telegram: new FakeTelegram(),
    handler: createUpdateHandler(),
    ...overrides,
  };
}
