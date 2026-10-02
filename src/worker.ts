import { createServices, httpDeps, tickDeps } from "./app";
import type { Env } from "./env";
import { route } from "./http/router";
import { runTick } from "./jobs/tick";

export default {
  async fetch(request, env, ctx) {
    return route(
      request,
      httpDeps(() => createServices(env)),
      ctx,
    );
  },
  async scheduled(_controller, env) {
    await runTick(tickDeps(createServices(env)));
  },
} satisfies ExportedHandler<Env>;
