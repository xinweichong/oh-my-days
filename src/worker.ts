import { createServices, httpDeps, tickDeps } from "./app";
import type { Env } from "./env";
import { route } from "./http/router";
import { runTick } from "./jobs/tick";
import { RunBudget } from "./shared/run-budget";

export default {
  async fetch(request, env, ctx) {
    return route(
      request,
      httpDeps(() => createServices(env)),
      ctx,
    );
  },
  async scheduled(_controller, env) {
    // A fresh budget per run: every D1 statement and outgoing call counts (ADR 0009).
    await runTick(tickDeps(createServices(env, new RunBudget())));
  },
} satisfies ExportedHandler<Env>;
