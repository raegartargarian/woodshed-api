/**
 * Editing a draft, confirming scores, and recording publication.
 *
 * The auditor's edits are the point of the approval gate — a gate you cannot act
 * on is just a delay. Every edit marks the item `edited: true` so the record
 * distinguishes what the model wrote from what a human changed, which is the
 * question that gets asked when a document is disputed.
 */

import { HttpError, json, type RequestContext, Router } from "../http.ts";
import type { WoodshedStore } from "../kv.ts";
import { guardClaimOverview, guardFindings } from "../ai/guardrails.ts";
import { requireVaultAccess } from "../filedgr/access.ts";

async function body<T>(ctx: RequestContext): Promise<T> {
  try {
    return await ctx.request.json() as T;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

/** An approved document is immutable. Editing it would invalidate the approval. */
function assertEditable(state: string | undefined, what: string): void {
  if (state === "APPROVED" || state === "PUBLISHED") {
    throw new HttpError(
      409,
      `This ${what} has been approved and can no longer be edited. Regenerate to start over.`,
    );
  }
}

export function registerDraftRoutes(router: Router, store: WoodshedStore): Router {
  /** Rewrite the Claim Overview prose. Re-runs the checks against the new text. */
  router.put("/api/sessions/:vaultId/draft/claim-overview", async (ctx) => {
    const vaultId = ctx.params.vaultId!;
    await requireVaultAccess(ctx, vaultId);
    const { sentences } = await body<{ sentences?: string[] }>(ctx);

    if (!Array.isArray(sentences) || sentences.some((s) => typeof s !== "string")) {
      throw new HttpError(400, "sentences must be an array of strings");
    }

    const record = await store.get(vaultId);
    if (!record?.claimOverview) throw new HttpError(404, "There is no Claim Overview draft");
    assertEditable(record.claimOverview.state, "Claim Overview");

    const cleaned = sentences.map((s) => s.trim()).filter(Boolean);

    // Re-check. An auditor can introduce a banned term or a sixth sentence just
    // as easily as the model can, and the document is bound for a carrier either
    // way. Financials are not re-checked — they are not editable here.
    const guard = guardClaimOverview({
      sentences: cleaned,
      financials: record.claimOverview.financials,
      cells: {},
    });
    const failures = guard.failures.filter((f) => !f.check.startsWith("G1"));

    const updated = await store.update(vaultId, (current) => {
      if (current.claimOverview) {
        current.claimOverview.sentences = cleaned;
        current.claimOverview.guardrailFailures = [
          // Keep any financial failures from generation; they still stand.
          ...(current.claimOverview.guardrailFailures ?? []).filter((f) =>
            f.check.startsWith("G1") || f.check.startsWith("G2") || f.check.startsWith("G3")
          ),
          ...failures,
        ];
      }
      return current;
    });

    return json({ woodshed: updated, guardrails: { ok: failures.length === 0, failures } });
  });

  /**
   * Edit findings and action items.
   *
   * Accepts partial updates keyed by id so the client sends only what changed —
   * a whole-document PUT would make two auditors editing different items
   * overwrite each other even though the store itself is safe.
   */
  router.put("/api/sessions/:vaultId/draft/findings", async (ctx) => {
    const vaultId = ctx.params.vaultId!;
    await requireVaultAccess(ctx, vaultId);
    const patch = await body<{
      findings?: { id: string; text?: string; confirmed_score?: number | null }[];
      actionItems?: {
        id: string;
        item?: string;
        deadline?: string;
        owner_email?: string;
        role?: string;
      }[];
    }>(ctx);

    const record = await store.get(vaultId);
    if (!record?.findings) throw new HttpError(404, "There is no Findings draft");
    assertEditable(record.findings.state, "Findings document");

    for (const change of patch.actionItems ?? []) {
      if (change.deadline && !/^\d{4}-\d{2}-\d{2}$/.test(change.deadline)) {
        throw new HttpError(400, `"${change.deadline}" is not an ISO date`);
      }
    }
    for (const change of patch.findings ?? []) {
      if (
        change.confirmed_score !== undefined && change.confirmed_score !== null &&
        (!Number.isInteger(change.confirmed_score) ||
          change.confirmed_score < 0 || change.confirmed_score > 5)
      ) {
        throw new HttpError(400, "A compliance score must be an integer from 0 to 5");
      }
    }

    const updated = await store.update(vaultId, (current) => {
      const draft = current.findings!;

      for (const change of patch.findings ?? []) {
        const finding = draft.findings.find((f) => f.id === change.id);
        if (!finding) continue;
        if (change.text !== undefined && change.text !== finding.text) {
          finding.text = change.text;
          finding.edited = true;
        }
        if (change.confirmed_score !== undefined) {
          finding.confirmed_score = change.confirmed_score;
        }
      }

      for (const change of patch.actionItems ?? []) {
        for (const list of [draft.actionItems, current.actionItems]) {
          const item = list.find((i) => i.id === change.id);
          if (!item) continue;
          if (change.item !== undefined && change.item !== item.item) {
            item.item = change.item;
            item.edited = true;
          }
          if (change.deadline !== undefined) item.deadline = change.deadline;
          if (change.owner_email !== undefined) {
            item.owner_email = change.owner_email.toLowerCase();
            item.edited = true;
          }
          if (change.role !== undefined) {
            item.role = change.role as typeof item.role;
            item.edited = true;
          }
        }
      }

      // Re-run ownership and deadline checks — reassigning an item to somebody
      // off the roster is exactly the edit that needs catching.
      const guard = guardFindings({
        findings: draft.findings,
        actionItems: draft.actionItems,
        participants: current.participants,
        meetingDate: current.meetingDate,
      });
      draft.guardrailFailures = guard.failures;

      return current;
    });

    return json({
      woodshed: updated,
      guardrails: {
        ok: (updated.findings?.guardrailFailures ?? []).length === 0,
        failures: updated.findings?.guardrailFailures ?? [],
      },
    });
  });

  /**
   * Record that an approved document has been filed.
   *
   * The rendering and upload happen in the browser, which is where the document
   * is composed and where the auditor's token is. This closes the loop so the
   * record knows which attachment is the published artefact.
   */
  router.post("/api/sessions/:vaultId/draft/:kind/published", async (ctx) => {
    const { vaultId, kind } = ctx.params as { vaultId: string; kind: string };
    if (kind !== "claim-overview" && kind !== "findings") {
      throw new HttpError(404, "Unknown document kind");
    }

    await requireVaultAccess(ctx, vaultId);
    const { attachmentId } = await body<{ attachmentId?: string }>(ctx);
    if (!attachmentId) throw new HttpError(400, "attachmentId is required");

    const record = await store.get(vaultId);
    const draft = kind === "claim-overview" ? record?.claimOverview : record?.findings;
    if (!draft) throw new HttpError(404, "There is no draft");
    if (draft.state !== "APPROVED" && draft.state !== "PUBLISHED") {
      throw new HttpError(409, "Only an approved document can be recorded as published");
    }

    const updated = await store.update(vaultId, (current) => {
      const target = kind === "claim-overview" ? current.claimOverview : current.findings;
      if (target) {
        target.state = "PUBLISHED";
        target.publishedAttachmentId = attachmentId;
      }
      return current;
    });

    return json({ woodshed: updated });
  });

  return router;
}
