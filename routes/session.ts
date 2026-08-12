/**
 * Session workflow: the record itself, status transitions, and participants.
 *
 * Like the hierarchy routes these act as the caller with their relayed token,
 * so a permission grant is always attributable to a real auditor rather than to
 * a shared service credential.
 */

import { FiledgrClient } from "../filedgr/client.ts";
import { HierarchyService } from "../filedgr/hierarchy.ts";
import { HttpError, json, type RequestContext, requireCallerJwt, Router } from "../http.ts";
import type { WoodshedStore } from "../kv.ts";
import {
  emptyWoodshed,
  isWsRole,
  type WoodshedRecord,
  WS_STATUSES,
  type WsParticipant,
  type WsStatus,
} from "../domain/mod.ts";

function clientFor(ctx: RequestContext): FiledgrClient {
  return FiledgrClient.forCaller(ctx.cfg, requireCallerJwt(ctx));
}

/**
 * Fetch the record, creating it on first touch.
 *
 * A session vault is created in the dashboard by an admin, so the first auditor
 * to open it finds no workflow record. Rather than make them press "start",
 * the record is materialised from the vault's own hierarchy tag — which already
 * holds the claim number and WS ordinal, so nothing has to be re-entered.
 */
async function ensureRecord(
  ctx: RequestContext,
  store: WoodshedStore,
  vaultId: string,
): Promise<WoodshedRecord> {
  const existing = await store.get(vaultId);
  if (existing) return existing;

  const service = new HierarchyService(clientFor(ctx), ctx.cfg);
  const { session, claim, root } = await service.resolveAncestry(vaultId);

  try {
    return await store.create(
      emptyWoodshed({
        vaultId,
        claimVaultId: claim.vaultId,
        rootVaultId: root.vaultId,
        claimNumber: session.tag.claim ?? claim.tag.claim ?? "",
        wsNumber: session.tag.ws ?? 1,
        now: new Date().toISOString(),
      }),
    );
  } catch {
    // Two auditors opened the same session at once and the other won the race.
    // Their record is just as valid as the one we were about to write.
    const raced = await store.get(vaultId);
    if (raced) return raced;
    throw new HttpError(500, "Could not create the Woodshed record");
  }
}

async function readJson<T>(ctx: RequestContext): Promise<T> {
  try {
    return await ctx.request.json() as T;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

/** RFC-5322 is not worth implementing; this rejects what actually gets typed. */
function normalizeEmail(raw: unknown): string {
  if (typeof raw !== "string") throw new HttpError(400, "email must be a string");
  const email = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new HttpError(400, `"${raw}" is not a valid email address`);
  }
  return email;
}

export function registerSessionRoutes(router: Router, store: WoodshedStore): Router {
  /** Create the workflow record if it does not exist, and return it. */
  router.post("/api/sessions/:vaultId/init", async (ctx) => {
    const record = await ensureRecord(ctx, store, ctx.params.vaultId!);
    return json({ woodshed: record });
  });

  /** Advance the status machine. Illegal transitions are refused, not clamped. */
  router.put("/api/sessions/:vaultId/status", async (ctx) => {
    const vaultId = ctx.params.vaultId!;
    const body = await readJson<{ status?: string }>(ctx);

    if (!body.status || !WS_STATUSES.includes(body.status as WsStatus)) {
      throw new HttpError(
        400,
        `status must be one of ${WS_STATUSES.join(", ")}`,
      );
    }

    await ensureRecord(ctx, store, vaultId);

    try {
      return json({ woodshed: await store.transition(vaultId, body.status as WsStatus) });
    } catch (error) {
      // A refused transition is the caller's mistake, not a server fault.
      throw new HttpError(409, error instanceof Error ? error.message : "Illegal transition");
    }
  });

  /** Set the meeting date, which seeds every action-item deadline. */
  router.put("/api/sessions/:vaultId/meeting-date", async (ctx) => {
    const vaultId = ctx.params.vaultId!;
    const body = await readJson<{ meetingDate?: string | null }>(ctx);

    const meetingDate = body.meetingDate ?? null;
    if (meetingDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(meetingDate)) {
      throw new HttpError(400, "meetingDate must be an ISO date (YYYY-MM-DD) or null");
    }

    await ensureRecord(ctx, store, vaultId);
    const updated = await store.update(vaultId, (record) => {
      record.meetingDate = meetingDate;
      return record;
    });
    return json({ woodshed: updated });
  });

  /**
   * Add a participant and grant them access to the session vault.
   *
   * The grant is attempted immediately: a participant who cannot open the vault
   * is not a participant, and discovering that at distribution time — after the
   * Woodshed has been held — is far more expensive than discovering it now.
   *
   * A failed grant does not fail the request. The participant is still recorded,
   * with the failure visible on the row, so the auditor can retry rather than
   * lose the roster.
   */
  router.post("/api/sessions/:vaultId/participants", async (ctx) => {
    const vaultId = ctx.params.vaultId!;
    const body = await readJson<{ role?: string; email?: string }>(ctx);

    if (typeof body.role !== "string" || !isWsRole(body.role)) {
      throw new HttpError(400, "role must be one of Auditor, Adjuster, Employer, SME");
    }
    const email = normalizeEmail(body.email);

    const record = await ensureRecord(ctx, store, vaultId);
    if (record.participants.some((p) => p.email === email)) {
      // One person, one row. The roles are fixed but their quantity is open —
      // two Adjusters are normal, the same address twice is not.
      throw new HttpError(409, `${email} is already a participant on this Woodshed`);
    }

    const client = clientFor(ctx);
    let access: WsParticipant["access"] = "PENDING";
    let message: string | undefined;

    try {
      const me = await client.getCurrentUser();
      const result = await client.grantVaultAccess({
        vaultId,
        email,
        // EDITOR, not VIEWER: SMEs must be able to upload their summary back
        // into the Correspondence stream.
        type: "EDITOR",
        inviterUserId: me.id,
      });
      access = result.status === "granted"
        ? "GRANTED"
        : result.status === "invited"
        ? "INVITED"
        : "FAILED";
      message = result.message;
    } catch (error) {
      access = "FAILED";
      message = error instanceof Error ? error.message : String(error);
    }

    const participant: WsParticipant = {
      id: crypto.randomUUID(),
      role: body.role,
      email,
      access,
      addedAt: new Date().toISOString(),
    };

    const updated = await store.update(vaultId, (current) => {
      current.participants.push(participant);
      return current;
    });

    return json({ woodshed: updated, participant, accessMessage: message ?? null }, 201);
  });

  /**
   * Retry a failed grant.
   *
   * Grants fail for transient reasons — a rate limit, a mid-flight deploy — and
   * re-adding the participant would hit the duplicate guard. This is the escape.
   */
  router.post("/api/sessions/:vaultId/participants/:participantId/grant", async (ctx) => {
    const { vaultId, participantId } = ctx.params as { vaultId: string; participantId: string };

    const record = await ensureRecord(ctx, store, vaultId);
    const participant = record.participants.find((p) => p.id === participantId);
    if (!participant) throw new HttpError(404, "No such participant on this Woodshed");

    const client = clientFor(ctx);
    const me = await client.getCurrentUser();
    const result = await client.grantVaultAccess({
      vaultId,
      email: participant.email,
      type: "EDITOR",
      inviterUserId: me.id,
    });

    const updated = await store.update(vaultId, (current) => {
      const target = current.participants.find((p) => p.id === participantId);
      if (target) {
        target.access = result.status === "granted"
          ? "GRANTED"
          : result.status === "invited"
          ? "INVITED"
          : "FAILED";
      }
      return current;
    });

    return json({ woodshed: updated, accessMessage: result.message ?? null });
  });

  /**
   * Remove a participant from the roster.
   *
   * This does NOT revoke their vault permission. Revocation is a separate,
   * deliberate act — quietly stripping access to evidence someone has already
   * seen, in a matter that may end up in litigation, is not something a roster
   * edit should do as a side effect.
   */
  router.delete("/api/sessions/:vaultId/participants/:participantId", async (ctx) => {
    const { vaultId, participantId } = ctx.params as { vaultId: string; participantId: string };

    const record = await store.get(vaultId);
    if (!record) throw new HttpError(404, "No Woodshed record for this session");
    if (!record.participants.some((p) => p.id === participantId)) {
      throw new HttpError(404, "No such participant on this Woodshed");
    }

    const assigned = record.actionItems.filter((item) =>
      item.owner_email === record.participants.find((p) => p.id === participantId)?.email
    );
    if (assigned.length > 0) {
      throw new HttpError(
        409,
        `This participant owns ${assigned.length} action item${
          assigned.length === 1 ? "" : "s"
        }. ` +
          `Reassign them before removing the participant.`,
      );
    }

    const updated = await store.update(vaultId, (current) => {
      current.participants = current.participants.filter((p) => p.id !== participantId);
      return current;
    });

    return json({ woodshed: updated, accessRevoked: false });
  });

  return router;
}
