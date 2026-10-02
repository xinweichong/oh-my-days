import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { httpDeps, type Services, tickDeps } from "../../src/app";
import { createCalendarHandler } from "../../src/application/calendar-operations";
import { eventOperationHandlers } from "../../src/application/event-operations";
import { registry } from "../../src/application/operation-types";
import { route } from "../../src/http/router";
import { runTick } from "../../src/jobs/tick";
import { createTokenCipher } from "../../src/security/token-cipher";
import type { InlineKeyboardButton, TelegramCall } from "../../src/telegram/api";
import { FakeGoogle } from "./fake-google";
import { FakeClock, FakeTelegram, OWNER, SequentialIds, testConfig, testServices } from "./fakes";
import { callbackUpdate, textUpdate, webhookRequest } from "./telegram";

/**
 * The whole Worker with fake Telegram and Google: messages go through the real
 * webhook, buttons through real callbacks, and pages through real routes.
 */
export class World {
  readonly clock = new FakeClock();
  readonly ids = new SequentialIds("w");
  readonly telegram = new FakeTelegram();
  readonly google = new FakeGoogle();
  readonly services: Services;

  constructor(readonly db: D1Database) {
    this.services = testServices(db, {
      clock: this.clock,
      ids: this.ids,
      telegram: this.telegram,
      handlers: registry(...eventOperationHandlers, createCalendarHandler(testConfig)),
      google: {
        oauth: this.google.oauth,
        cipher: () => createTokenCipher(testConfig.tokenEncryptionKey),
        calendarApi: this.google.calendarApi,
      },
    });
    // Use the real connection-backed Calendar access.
    delete this.services.calendarFor;
    delete this.services.directoryFor;
  }

  async request(path: string, init?: RequestInit): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await route(
      new Request(`${testConfig.publicBaseUrl}${path}`, init),
      httpDeps(() => this.services),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  }

  async send(text: string, from = OWNER): Promise<void> {
    await this.webhook(textUpdate(from, text));
  }

  async webhook(update: Record<string, unknown>): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await route(
      webhookRequest(update),
      httpDeps(() => this.services),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  }

  /** Presses the most recent button with this label; returns the URL for link buttons. */
  async press(label: string | RegExp, from = OWNER): Promise<string | null> {
    const button = this.findButton(label);
    if ("url" in button) return button.url;
    await this.webhook(callbackUpdate(from, button.callback_data));
    return null;
  }

  findButton(label: string | RegExp): InlineKeyboardButton {
    for (const call of [...this.telegram.calls].reverse()) {
      const rows =
        "reply_markup" in call.params ? call.params.reply_markup?.inline_keyboard : undefined;
      const button = rows
        ?.flat()
        .find((b) => (typeof label === "string" ? b.text === label : label.test(b.text)));
      if (button) return button;
    }
    throw new Error(`No button labelled ${String(label)}`);
  }

  /** Opens a connect link, starts authorization, consents at Google, and returns the result page. */
  async authorize(
    connectUrl: string,
    consent: { subject: string; email: string; deny?: boolean; scopes?: string[] },
  ): Promise<{ page: string; callbackPath: string }> {
    const path = new URL(connectUrl).pathname + new URL(connectUrl).search;
    const landing = await this.request(path);
    const html = await landing.text();
    const token = /name="t" value="([^"]+)"/.exec(html)?.[1];
    if (!token) throw new Error(`Connect page did not offer authorization:\n${html}`);
    const started = await this.request("/oauth/start", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ t: token }).toString(),
    });
    const location = started.headers.get("location");
    if (started.status !== 303 || !location) throw new Error("Authorization did not start");
    const callbackPath = await this.google.consent(location, consent);
    const page = await (await this.request(callbackPath)).text();
    return { page, callbackPath };
  }

  /** Runs one scheduled tick. */
  async tick(): Promise<void> {
    await runTick(tickDeps(this.services));
  }

  texts(): string[] {
    return this.telegram.calls.flatMap((c: TelegramCall) =>
      "text" in c.params && c.params.text && c.method !== "answerCallbackQuery"
        ? [c.params.text]
        : [],
    );
  }

  lastText(): string | undefined {
    return this.texts().at(-1);
  }

  answers(): string[] {
    return this.telegram.calls.flatMap((c) =>
      c.method === "answerCallbackQuery" && c.params.text ? [c.params.text] : [],
    );
  }
}

export const OWNER_ACCOUNT = { subject: "google-sub-owner", email: "owner@example.com" };
