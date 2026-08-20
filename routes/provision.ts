/**
 * Creating the hierarchy.
 *
 * This is what makes the design work without touching the Filedgr dashboard.
 * The dashboard's vault form has no field for a hierarchy tag, so building the
 * tree there would mean an admin hand-pasting
 * `ws:claim|parent:<uuid>|claim:10000001` into a description and copying the
 * parent's UUID out of a URL — for every claim and every session. One typo and
 * the session silently disappears from the tree.
 *
 * Here the tag is generated, never typed. Everything runs as the caller with
 * their own token, so vaults belong to them and their credits pay for them,
 * exactly as if they had used the dashboard.
 */

import { HttpError, json, type RequestContext, Router } from "../http.ts";
import type { WoodshedStore } from "../kv.ts";
import { FiledgrClient } from "../filedgr/client.ts";
import { HierarchyService } from "../filedgr/hierarchy.ts";
import { requireVaultAccess } from "../filedgr/access.ts";
import { encodeWsTag, sessionVaultName } from "../domain/mod.ts";
import { requireCallerJwt } from "../http.ts";

async function body<T>(ctx: RequestContext): Promise<T> {
  try {
    return await ctx.request.json() as T;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

function requireTemplate(id: string, level: string): string {
  if (!id) {
    throw new HttpError(
      503,
      `No template configured for the "${level}" level. Set WS_${level.toUpperCase()}` +
        `_TEMPLATE_ID on this deployment.`,
    );
  }
  return id;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${field} is required`);
  }
  return value.trim();
}

export function registerProvisionRoutes(router: Router, store: WoodshedStore): Router {
  /** Create a client (root) vault. */
  router.post("/api/clients", async (ctx) => {
    const { name } = await body<{ name?: string }>(ctx);
    const client = FiledgrClient.forCaller(ctx.cfg, requireCallerJwt(ctx));

    const vault = await client.createVault({
      templateId: requireTemplate(ctx.cfg.filedgr.rootTemplateId, "root"),
      name: nonEmpty(name, "name"),
      description: encodeWsTag({ level: "root" }),
    });

    return json({ vaultId: vault.id, name: vault.name, level: "root" }, 201);
  });

  /** Create a claim under a client. */
  router.post("/api/clients/:rootId/claims", async (ctx) => {
    const rootId = ctx.params.rootId!;
    const { claimNumber } = await body<{ claimNumber?: string }>(ctx);
    const number = nonEmpty(claimNumber, "claimNumber");

    // Authorize against the parent, and prove it is really a client vault —
    // parenting a claim to a session would produce a tree that renders but
    // navigates nowhere.
    const client = await requireVaultAccess(ctx, rootId);
    const service = new HierarchyService(client, ctx.cfg);
    const root = await service.getNode(rootId);
    if (!root || root.level !== "root") {
      throw new HttpError(400, "That vault is not a Woodshed client vault");
    }

    const existing = await service.listClaims(rootId);
    const clash = existing.find((c) => c.tag.claim === number);
    if (clash) {
      throw new HttpError(
        409,
        `Claim ${number} already exists under this client (${clash.name}). ` +
          `Open it rather than creating a second one.`,
      );
    }

    const vault = await client.createVault({
      templateId: requireTemplate(ctx.cfg.filedgr.claimTemplateId, "claim"),
      name: number,
      description: encodeWsTag({ level: "claim", parent: rootId, claim: number }),
    });

    return json({ vaultId: vault.id, name: vault.name, level: "claim" }, 201);
  });

  /**
   * Create the next Woodshed session on a claim.
   *
   * The number is allocated from what Filedgr actually holds, not from a
   * counter alone, so a session created elsewhere cannot cause a collision.
   * Note the deck asks this to *prevent* duplicates: it cannot. There is no
   * uniqueness constraint on vault names, so a clash is reported, not blocked.
   */
  router.post("/api/claims/:claimId/sessions", async (ctx) => {
    const claimId = ctx.params.claimId!;

    const client = await requireVaultAccess(ctx, claimId);
    const service = new HierarchyService(client, ctx.cfg);
    const claim = await service.getNode(claimId);
    if (!claim || claim.level !== "claim") {
      throw new HttpError(400, "That vault is not a Woodshed claim vault");
    }

    const used = await service.usedWsNumbers(claimId);
    const wsNumber = await store.allocateWsNumber(claimId, used);
    const claimNumber = claim.tag.claim ?? claim.name;

    const vault = await client.createVault({
      templateId: requireTemplate(ctx.cfg.filedgr.sessionTemplateId, "session"),
      name: sessionVaultName(claimNumber, wsNumber),
      description: encodeWsTag({
        level: "session",
        parent: claimId,
        claim: claimNumber,
        ws: wsNumber,
      }),
    });

    return json({
      vaultId: vault.id,
      name: vault.name,
      level: "session",
      wsNumber,
      // The seven streams are materialised by the platform from the template's
      // required_streams; they arrive on the vault immediately but only become
      // readable once each one mints an asset code.
      streams: (vault.streams ?? []).map((s) => s.mapping),
      warning: used.includes(wsNumber)
        ? `WS${wsNumber} already exists on this claim. Filedgr does not enforce ` +
          `unique vault names, so this needs resolving by hand.`
        : null,
    }, 201);
  });

  return router;
}
