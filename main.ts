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

Deno.serve((request) => router.handle(request, cfg));

console.log(
  `Woodshed API listening · stage=${cfg.stage} · filedgr=${cfg.filedgr.authMode} · ` +
    `email=${cfg.email.enabled ? "on" : "off"}`,
);
