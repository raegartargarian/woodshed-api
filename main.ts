/**
 * Woodshed API — entry point.
 *
 * Deploy target: Deno Deploy (KV and Cron are built in, no external services).
 * Run locally with `deno task dev` from ./server.
 */

import { loadConfig } from "./config.ts";
import { json, Router } from "./http.ts";
import { WoodshedStore } from "./kv.ts";
import { registerHierarchyRoutes } from "./routes/hierarchy.ts";
import { registerAiRoutes } from "./routes/ai.ts";
import { registerDistributionRoutes, runDeadlineSweep } from "./routes/distribute.ts";
import { registerDraftRoutes } from "./routes/drafts.ts";
import { registerSessionRoutes } from "./routes/session.ts";

const cfg = loadConfig();
const store = await WoodshedStore.open();

const router = new Router();

router.publicGet("/health", () =>
  json({
    ok: true,
    stage: cfg.stage,
    filedgrAuthMode: cfg.filedgr.authMode,
    emailEnabled: cfg.email.enabled,
  }));

registerHierarchyRoutes(router, store);
registerSessionRoutes(router, store);
registerAiRoutes(router, store);
registerDistributionRoutes(router, store);
registerDraftRoutes(router, store);

/**
 * Daily deadline sweep.
 *
 * Registered only when email is configured — a cron that runs and can send
 * nothing is a scheduled no-op that still looks like it is working.
 */
if (cfg.email.enabled) {
  Deno.cron("woodshed-deadline-sweep", "0 13 * * *", async () => {
    const result = await runDeadlineSweep(store, cfg);
    console.log(
      `Deadline sweep: scanned ${result.scanned}, sent ${result.sent}, skipped ${result.skipped}`,
    );
  });
}

Deno.serve((request) => router.handle(request, cfg));

console.log(
  `Woodshed API listening · stage=${cfg.stage} · filedgr=${cfg.filedgr.authMode} · ` +
    `email=${cfg.email.enabled ? "on" : "off"}`,
);
