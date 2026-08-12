/**
 * Tree browsing: clients → claims → sessions.
 *
 * These routes act as the caller, using their relayed Filedgr JWT, so a user
 * only ever sees vaults they already have permission to see. Using the bot
 * credential here would silently widen visibility to the whole entity.
 */

import { FiledgrClient } from "../filedgr/client.ts";
import { HierarchyService, type WsNode } from "../filedgr/hierarchy.ts";
import { HttpError, json, type RequestContext, requireCallerJwt, Router } from "../http.ts";
import type { WoodshedStore } from "../kv.ts";
import { streamLabel, WS_STREAM_MAPPINGS } from "../domain/mod.ts";

/** Trimmed node — the vault DTO is large and the client never needs all of it. */
function serialize(node: WsNode) {
  return {
    vaultId: node.vaultId,
    name: node.name,
    level: node.level,
    claimNumber: node.tag.claim ?? null,
    wsNumber: node.tag.ws ?? null,
    parentVaultId: node.tag.parent ?? null,
    createdAt: node.createdAt,
    archived: node.archived,
    status: node.vault.status,
  };
}

function serviceFor(ctx: RequestContext): HierarchyService {
  const client = FiledgrClient.forCaller(ctx.cfg, requireCallerJwt(ctx));
  return new HierarchyService(client, ctx.cfg);
}

export function registerHierarchyRoutes(router: Router, store: WoodshedStore): Router {
  /** All client roots. */
  router.get("/api/clients", async (ctx) => {
    const roots = await serviceFor(ctx).listRoots();
    return json({ clients: roots.map(serialize) });
  });

  /** Claims under a client. */
  router.get("/api/clients/:rootId/claims", async (ctx) => {
    const claims = await serviceFor(ctx).listClaims(ctx.params.rootId!);
    return json({ claims: claims.map(serialize) });
  });

  /**
   * Cross-client claim search, backing the deck's live search by claim number.
   */
  router.get("/api/claims/search", async (ctx) => {
    const term = ctx.url.searchParams.get("q")?.trim() ?? "";
    if (term.length < 2) return json({ claims: [] });

    const service = serviceFor(ctx);
    const claims = await service.searchClaims(term);

    // Include existing sessions so the auditor sees, before committing, that
    // this claim already has a WS1 and WS2.
    const withSessions = await Promise.all(
      claims.map(async (claim) => ({
        ...serialize(claim),
        sessions: (await service.listSessions(claim.vaultId)).map(serialize),
      })),
    );

    return json({ claims: withSessions });
  });

  /** Woodshed sessions under a claim, plus the next free WS number. */
  router.get("/api/claims/:claimId/sessions", async (ctx) => {
    const claimId = ctx.params.claimId!;
    const service = serviceFor(ctx);

    const sessions = await service.listSessions(claimId);
    const used = sessions.map((s) => s.tag.ws).filter((n): n is number => typeof n === "number");

    return json({
      sessions: sessions.map(serialize),
      usedWsNumbers: used,
      nextWsNumber: (used.length ? Math.max(...used) : 0) + 1,
    });
  });

  /**
   * Allocate a WS number.
   *
   * The counter is seeded from what Filedgr actually holds, so a KV reset or a
   * session created outside this server cannot produce a collision. There is no
   * unique constraint on vault names server-side, so this warns rather than
   * guarantees — the deck's "prevent duplicates" is not deliverable as a
   * guarantee and should not survive into an acceptance test.
   */
  router.post("/api/claims/:claimId/next-ws-number", async (ctx) => {
    const claimId = ctx.params.claimId!;
    const used = await serviceFor(ctx).usedWsNumbers(claimId);
    const wsNumber = await store.allocateWsNumber(claimId, used);

    return json({
      wsNumber,
      usedWsNumbers: used,
      warning: used.includes(wsNumber)
        ? `WS${wsNumber} already exists on this claim. Filedgr does not enforce uniqueness on ` +
          `vault names, so this must be resolved manually.`
        : null,
    });
  });

  /** A session's full context: ancestry, streams, and workflow state. */
  router.get("/api/sessions/:vaultId", async (ctx) => {
    const vaultId = ctx.params.vaultId!;
    const service = serviceFor(ctx);

    const { session, claim, root } = await service.resolveAncestry(vaultId);
    const record = await store.get(vaultId);

    // Surface the 7 expected streams whether or not they have minted yet, so the
    // UI can show a stream as pending instead of missing.
    const actual = session.vault.streams ?? [];
    const streams = WS_STREAM_MAPPINGS.map((mapping) => {
      const stream = actual.find((s) => s.mapping === mapping);
      return {
        mapping,
        label: streamLabel(mapping),
        streamId: stream?.id ?? null,
        assetCode: stream?.asset_code ?? null,
        status: stream?.status ?? "PENDING",
        // Attachments are listed by asset_code, so a stream without one cannot
        // be read yet no matter what its status says.
        readable: Boolean(stream?.asset_code),
      };
    });

    const unexpected = actual
      .filter((s) => s.mapping && !WS_STREAM_MAPPINGS.includes(s.mapping as never))
      .map((s) => ({ mapping: s.mapping, streamId: s.id }));

    return json({
      session: serialize(session),
      claim: serialize(claim),
      client: serialize(root),
      streams,
      unexpectedStreams: unexpected,
      woodshed: record,
    });
  });

  /** Documents in one stream of a session. */
  router.get("/api/sessions/:vaultId/streams/:mapping/attachments", async (ctx) => {
    const { vaultId, mapping } = ctx.params as { vaultId: string; mapping: string };
    const client = FiledgrClient.forCaller(ctx.cfg, requireCallerJwt(ctx));

    const stream = await client.findStream(vaultId, mapping);
    if (!stream) throw new HttpError(404, `Session ${vaultId} has no "${mapping}" stream`);
    if (!stream.asset_code) {
      // Not an error — the stream exists but has not finished minting, and the
      // attachments route is keyed by asset_code.
      return json({ attachments: [], pending: true });
    }

    const page = await client.listStreamAttachments(stream.asset_code);
    return json({ attachments: page.content, pending: false, total: page.total_records });
  });

  return router;
}
