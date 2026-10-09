import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { rows } from "../support/db";
import { OTHER_USER } from "../support/fakes";
import { setUpOwner, World } from "../support/world";

async function timezone(): Promise<string | undefined> {
  const [user] = await rows<{ timezone: string }>(
    env.DB,
    "SELECT timezone FROM users WHERE setup_step = 'done'",
  );
  return user?.timezone;
}

async function changeTimezone(world: World) {
  await world.send("/settings");
  await world.press("Timezone");
  await world.press("Change timezone");
}

describe("choosing a timezone (C7)", () => {
  it("offers common zones as buttons, then the previous zone first", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await changeTimezone(world);
    expect(world.lastText()).toBe(
      "Choose a timezone, or type a city or Region/City, for example London or Europe/London.",
    );
    expect(() => world.findButton("Singapore")).toThrow(); // the current zone
    await world.press("Tokyo");
    expect(world.lastText()).toBe(
      "Timezone set to Asia/Tokyo. Existing events keep their times; new dates and reminders use Asia/Tokyo.",
    );
    await changeTimezone(world);
    const call = world.telegram.calls.at(-1);
    const keyboard = call && "reply_markup" in call.params ? call.params.reply_markup : undefined;
    expect(keyboard?.inline_keyboard[0]?.[0]?.text).toBe("Singapore");
  });

  it("accepts a typed city, and asks when the name is only a start", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await changeTimezone(world);
    await world.send("london");
    expect(await timezone()).toBe("Europe/London");
    await changeTimezone(world);
    await world.send("Kuala");
    expect(world.lastText()).toBe("Which one?");
    await world.press("Asia/Kuala Lumpur");
    expect(await timezone()).toBe("Asia/Kuala_Lumpur");
    await changeTimezone(world);
    await world.send("Gotham");
    expect(world.lastText()).toContain("I don't recognize that timezone.");
    expect(await timezone()).toBe("Asia/Kuala_Lumpur");
  });

  it("refuses another user's timezone button", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await changeTimezone(world);
    await world.press("Tokyo", OTHER_USER);
    expect(world.answers().at(-1)).toBe("This button is no longer valid.");
    expect(await timezone()).toBe("Asia/Singapore");
  });
});
