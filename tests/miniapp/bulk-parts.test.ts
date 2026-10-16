import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { bulkSummary, inParts } from "../../src/miniapp/client/bulk";
import { MAX_BULK_WRITE } from "../../src/miniapp/limits";
import { rows } from "../support/db";
import { appApi } from "../support/miniapp";
import { setUpOwner, World } from "../support/world";

// World time starts at Fri 25 Sep 2026, 09:00 in Singapore. Synthetic data only.
let keys = 0;
const key = () => `parts-key-${String(++keys).padStart(4, "0")}`;

describe("Mini App bulk changes in parts", () => {
  it("sends parts of the server's size one after another and adds up what changed", async () => {
    const sent: number[][] = [];
    const result = await inParts(
      Array.from({ length: 47 }, (_, i) => i),
      async (part) => {
        sent.push(part);
        return { applied: part.length };
      },
    );
    expect(sent.map((p) => p.length)).toEqual([MAX_BULK_WRITE, MAX_BULK_WRITE, 7]);
    expect(result).toEqual({ applied: 47, error: null });
    expect(bulkSummary("Completed", 47, result)).toBe("Completed 47 tasks.");
  });

  it("stops at a refused part and says the rest weren't changed", async () => {
    let calls = 0;
    const result = await inParts(
      Array.from({ length: 45 }, (_, i) => i),
      async (part) => {
        if (++calls === 2) throw new Error("stale");
        return { applied: part.length };
      },
    );
    expect(calls).toBe(2);
    expect(
      bulkSummary("Snoozed", 45, result, " Deadlines unchanged.", () => "Something changed."),
    ).toBe("Snoozed 20 tasks. Deadlines unchanged. The rest weren't changed: Something changed.");
    expect(bulkSummary("Completed", 3, { applied: 2, error: null })).toBe(
      "Completed 2 tasks. 1 changed elsewhere and was left as it was.",
    );
    expect(bulkSummary("Completed", 2, { applied: 0, error: null })).toBe(
      "Nothing was changed. 2 changed elsewhere and were left as they were.",
    );
  });

  it("completes and cancels a selection larger than one request against the real API", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    for (let start = 0; start < 47; start += 8) {
      const lines = Array.from(
        { length: Math.min(8, 47 - start) },
        (_, i) => `Task ${start + i} by 30 Oct`,
      );
      await world.send(["/import", ...lines].join("\n"));
      await world.press(/^Import \d+ tasks?$/);
    }
    const items = async () =>
      (await rows<{ id: string; version: number }>(env.DB, "SELECT id, version FROM tasks")).map(
        (t) => ({ id: t.id, version: t.version }),
      );
    const completed = await inParts(await items(), async (part) => {
      const r = await appApi(world, "tasks/bulk", {
        method: "POST",
        body: { key: key(), action: "complete", items: part },
      });
      if (r.status !== 200) throw new Error(String(r.body.error));
      return r.body as { applied: number };
    });
    expect(completed).toEqual({ applied: 47, error: null });

    await env.DB.prepare("UPDATE tasks SET status = 'open', completed_at = NULL").run();
    const preview = await appApi(world, "tasks/bulk-cancel-preview", {
      method: "POST",
      body: { items: await items() },
    });
    const chunks = preview.body.chunks as { items: unknown[]; previewHash: string }[];
    const cancelled = await inParts(
      chunks,
      async ([chunk]) => {
        const r = await appApi(world, "tasks/bulk-cancel", {
          method: "POST",
          body: { key: key(), ...chunk },
        });
        if (r.status !== 200) throw new Error(String(r.body.error));
        return r.body as { applied: number };
      },
      1,
    );
    expect(cancelled).toEqual({ applied: 47, error: null });
    expect(await rows(env.DB, "SELECT id FROM tasks WHERE status != 'cancelled'")).toEqual([]);
  });
});
