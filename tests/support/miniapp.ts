import { signInitData } from "../../src/miniapp/init-data";
import { OWNER, testConfig } from "./fakes";
import type { World } from "./world";

/** Signed initData for a Telegram user, as Telegram would send it (synthetic). */
export async function initDataFor(
  world: World,
  telegramUserId = OWNER,
  options: { ageSeconds?: number; token?: string } = {},
): Promise<string> {
  const authDate = Math.floor(world.clock.now() / 1000) - (options.ageSeconds ?? 30);
  return signInitData(
    {
      auth_date: String(authDate),
      query_id: "AAH-synthetic",
      user: JSON.stringify({ id: telegramUserId, first_name: "Test" }),
      // Current Telegram clients also send an Ed25519 signature (synthetic here).
      signature: "c3ludGhldGljLXNpZ25hdHVyZQ",
    },
    options.token ?? testConfig.telegramBotToken,
  );
}

/** Calls the Mini App API as a signed-in Telegram user. */
export async function appApi(
  world: World,
  path: string,
  options: { method?: string; body?: unknown; as?: number; initData?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const initData = options.initData ?? (await initDataFor(world, options.as ?? OWNER));
  const response = await world.request(`/app/api/${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `tma ${initData}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
