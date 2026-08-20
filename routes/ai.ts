/**
 * AI drafting: 1st Response (Claim Overview) and 2nd Response (Findings and
 * Action Items).
 *
 * The shape of every route here is the same and it is the point of the design:
 *
 *     generate → guardrails → DRAFT → auditor edits → approve → publish
 *
 * Nothing is rendered, uploaded, hashed, anchored or emailed before approval.
 * Once a document is anchored it is permanent, so the approval is the moment a
 * named human takes responsibility for what the model wrote.
 */

import { HttpError, json, type RequestContext, Router } from "../http.ts";
import type { WoodshedStore } from "../kv.ts";
import { estimateTokens, LlmError, OpenAiClient } from "../ai/openai.ts";
import {
  ATTENDANCE_SCHEMA,
  ATTENDANCE_SYSTEM,
  CLAIM_OVERVIEW_SCHEMA,
  CLAIM_OVERVIEW_SYSTEM,
  FINDINGS_SCHEMA,
  FINDINGS_SYSTEM,
  PROMPT_VERSION,
} from "../ai/prompts.ts";
import {
  type CellMap,
  guardClaimOverview,
  guardFindings,
  isRecoverable,
} from "../ai/guardrails.ts";
import {
  computeDeadline,
  FINANCIAL_EXTRAS,
  FINANCIAL_ROWS,
  type FinancialCell,
  type FinancialTable,
  SME_SUMMARY_ITEM,
  type WsActionItem,
  type WsFinding,
} from "../domain/mod.ts";
import { requireVaultAccess } from "../filedgr/access.ts";

// ---------------------------------------------------------------------------
// Request shapes
//
// Text arrives already extracted. The browser does that: it already holds the
// auditor's token and the document URLs, and it keeps document bytes out of this
// service entirely. It also means no PDF is ever sent to the model natively,
// which is the single largest cost lever in the system.
// ---------------------------------------------------------------------------

interface DocumentInput {
  attachmentId: string;
  filename: string;
  text: string;
  /** `"Sheet!A1" → raw text`, for workbooks. Enables the provenance check. */
  cells?: CellMap;
}

interface ClaimOverviewRequest {
  documents?: DocumentInput[];
}

interface FindingsRequest {
  transcript?: DocumentInput;
  attendance?: DocumentInput;
}

async function body<T>(ctx: RequestContext): Promise<T> {
  try {
    return await ctx.request.json() as T;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

// ---------------------------------------------------------------------------
// Model output → domain
// ---------------------------------------------------------------------------

interface RawFigure {
  cents: number | null;
  cell: string | null;
  raw_text: string | null;
  absent_reason: string | null;
}

/**
 * A figure the model reported as absent becomes a zero with no source, which the
 * provenance check will then reject unless it really is absent from the sheet.
 * Refunds / Subrogation / Reinsurance are genuinely blank most of the time,
 * which is exactly why absence has to be expressible rather than guessed at.
 */
function toCell(figure: RawFigure | undefined, sheet: string): FinancialCell {
  if (!figure || figure.cents === null || !figure.cell) {
    return { cents: 0, source: null };
  }
  return {
    cents: figure.cents,
    source: { sheet, cell: figure.cell, raw_text: figure.raw_text ?? "" },
  };
}

interface RawOverview {
  sentences: string[];
  financials: {
    sheet: string;
    rows: { label: string; reserves: RawFigure; paid: RawFigure; incurred: RawFigure }[];
    totals: { reserves: RawFigure; paid: RawFigure; incurred: RawFigure };
    extras: { label: string; figure: RawFigure }[];
  } | null;
}

function toFinancialTable(raw: RawOverview["financials"]): FinancialTable | null {
  if (!raw) return null;
  const sheet = raw.sheet || "CLAIM";

  const rows = {} as FinancialTable["rows"];
  for (const label of FINANCIAL_ROWS) {
    const found = raw.rows.find((r) => r.label === label);
    rows[label] = {
      reserves: toCell(found?.reserves, sheet),
      paid: toCell(found?.paid, sheet),
      incurred: toCell(found?.incurred, sheet),
    };
  }

  const extras = {} as FinancialTable["extras"];
  for (const label of FINANCIAL_EXTRAS) {
    extras[label] = toCell(raw.extras.find((e) => e.label === label)?.figure, sheet);
  }

  return {
    rows,
    totals: {
      reserves: toCell(raw.totals?.reserves, sheet),
      paid: toCell(raw.totals?.paid, sheet),
      incurred: toCell(raw.totals?.incurred, sheet),
    },
    extras,
  };
}

// ---------------------------------------------------------------------------

export function registerAiRoutes(router: Router, store: WoodshedStore): Router {
  /**
   * Token estimate for a proposed input set.
   *
   * Lets the auditor see the size and cost of a run before committing to it,
   * and lets the UI show which documents are driving it.
   */
  router.post("/api/sessions/:vaultId/ai/estimate", async (ctx) => {
    await requireVaultAccess(ctx, ctx.params.vaultId!);
    const request = await body<{ documents?: DocumentInput[] }>(ctx);
    const documents = request.documents ?? [];

    const perDocument = documents.map((doc) => ({
      attachmentId: doc.attachmentId,
      filename: doc.filename,
      tokens: estimateTokens(doc.text),
    }));
    const total = perDocument.reduce((sum, d) => sum + d.tokens, 0);

    return json({
      documents: perDocument,
      totalTokens: total,
      limit: ctx.cfg.openai.maxInputTokens,
      withinLimit: total <= ctx.cfg.openai.maxInputTokens,
    });
  });

  /** 1st Response — generate the Claim Overview draft. */
  router.post("/api/sessions/:vaultId/ai/claim-overview", async (ctx) => {
    const vaultId = ctx.params.vaultId!;
    // Guard first: generation spends money, so it must never run for a caller
    // who cannot prove access to this Woodshed.
    await requireVaultAccess(ctx, vaultId);

    const request = await body<ClaimOverviewRequest>(ctx);
    const documents = request.documents ?? [];

    if (documents.length === 0) {
      throw new HttpError(400, "Select at least one document to generate from");
    }

    const record = await store.get(vaultId);
    if (!record) throw new HttpError(404, "No Woodshed record for this session");

    // Merge every supplied workbook's cells into one map. Provenance is checked
    // against what the documents actually contain, not against the model's word.
    const cells: CellMap = {};
    for (const doc of documents) {
      for (const [key, value] of Object.entries(doc.cells ?? {})) {
        cells[key.toUpperCase()] = value;
      }
    }

    const prompt = documents
      .map((doc) => `=== ${doc.filename} ===\n${doc.text}`)
      .join("\n\n");

    await store.update(vaultId, (current) => {
      current.claimOverview = {
        kind: "CLAIM_OVERVIEW",
        state: "GENERATING",
        sentences: [],
        financials: null,
        inputAttachmentIds: documents.map((d) => d.attachmentId),
      };
      return current;
    });

    let result;
    try {
      result = await new OpenAiClient(ctx.cfg).complete<RawOverview>({
        tier: "frontier",
        system: CLAIM_OVERVIEW_SYSTEM,
        user: prompt,
        schema: CLAIM_OVERVIEW_SCHEMA as unknown as Record<string, unknown>,
        schemaName: "claim_overview",
        reasoningEffort: "medium",
      });
    } catch (error) {
      await store.update(vaultId, (current) => {
        if (current.claimOverview) current.claimOverview.state = "NOT_STARTED";
        return current;
      });
      if (error instanceof LlmError) throw new HttpError(502, error.message);
      throw error;
    }

    const financials = toFinancialTable(result.data.financials);
    const guard = guardClaimOverview({
      sentences: result.data.sentences,
      financials,
      cells,
    });

    const updated = await store.update(vaultId, (current) => {
      current.claimOverview = {
        kind: "CLAIM_OVERVIEW",
        // A hard failure produces no usable draft. A recoverable one — too long,
        // a banned term — is still shown, flagged, for the auditor to fix.
        state: guard.ok || isRecoverable(guard) ? "DRAFT" : "GUARDRAIL_FAILED",
        sentences: result.data.sentences,
        financials,
        inputAttachmentIds: documents.map((d) => d.attachmentId),
        generatedAt: new Date().toISOString(),
        guardrailFailures: guard.failures,
        model: result.model,
        promptVersion: PROMPT_VERSION,
      };
      return current;
    });

    return json({
      woodshed: updated,
      guardrails: guard,
      usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
    });
  });

  /** 2nd Response — findings, action items and proposed compliance scores. */
  router.post("/api/sessions/:vaultId/ai/findings", async (ctx) => {
    const vaultId = ctx.params.vaultId!;
    await requireVaultAccess(ctx, vaultId);

    const request = await body<FindingsRequest>(ctx);

    if (!request.transcript?.text) {
      throw new HttpError(400, "A transcript is required to generate findings");
    }

    const record = await store.get(vaultId);
    if (!record) throw new HttpError(404, "No Woodshed record for this session");
    if (record.participants.length === 0) {
      // Without a roster there is nobody to own an action item, and the
      // ownership guardrail would reject everything the model produced.
      throw new HttpError(
        409,
        "Add the participants before generating findings — action items are assigned " +
          "to roster members, and a draft with no valid owners cannot be approved.",
      );
    }
    if (!record.meetingDate) {
      throw new HttpError(
        409,
        "Set the meeting date before generating findings — every deadline is computed from it.",
      );
    }

    const client = new OpenAiClient(ctx.cfg);

    // The attendance report is a small table, so it uses the cheap tier. Its
    // job is reconciliation, not judgement.
    let attendanceNote = "";
    let durationMinutes: number | null = null;
    if (request.attendance?.text) {
      try {
        const attendance = await client.complete<{
          participants: { email: string; role: string; name_in_report: string | null }[];
          duration_minutes: number | null;
        }>({
          tier: "cheap",
          system: ATTENDANCE_SYSTEM,
          user: request.attendance.text,
          schema: ATTENDANCE_SCHEMA as unknown as Record<string, unknown>,
          schemaName: "attendance",
        });
        durationMinutes = attendance.data.duration_minutes;
        attendanceNote = `\n\nAttendance report participants:\n` +
          attendance.data.participants
            .map((p) => `  ${p.role}: ${p.email}`)
            .join("\n");
      } catch {
        // A failed attendance parse is not fatal — the roster the auditor
        // entered is authoritative anyway.
        attendanceNote = "";
      }
    }

    const roster = record.participants
      .map((p) => `  ${p.role}: ${p.email}`)
      .join("\n");

    const prompt = `Roster for this Woodshed (assign action items only to these):\n${roster}` +
      attendanceNote +
      `\n\n=== Transcript ===\n${request.transcript.text}`;

    let result;
    try {
      result = await client.complete<{
        findings: {
          text: string;
          evidence_quote: string;
          source_segments: string[];
          proposed_score: number | null;
          score_rationale: string | null;
        }[];
        action_items: {
          item: string;
          role: string;
          owner_email: string;
          finding_index: number | null;
        }[];
        speaker_labels: string[];
      }>({
        tier: "frontier",
        system: FINDINGS_SYSTEM,
        user: prompt,
        schema: FINDINGS_SCHEMA as unknown as Record<string, unknown>,
        schemaName: "woodshed_findings",
        // Long-horizon synthesis over a whole meeting is the hardest job here.
        reasoningEffort: "high",
      });
    } catch (error) {
      if (error instanceof LlmError) throw new HttpError(502, error.message);
      throw error;
    }

    const findings: WsFinding[] = result.data.findings.map((raw, index) => ({
      id: `f${index}`,
      text: raw.text,
      evidence_quote: raw.evidence_quote,
      source_segments: raw.source_segments ?? [],
      proposed_score: raw.proposed_score,
      confirmed_score: null,
      score_rationale: raw.score_rationale,
      edited: false,
    }));

    // Deadlines are computed here, never taken from the model.
    const deadline = computeDeadline(record.meetingDate);

    const actionItems: WsActionItem[] = result.data.action_items.map((raw, index) => ({
      id: `a${index}`,
      item: raw.item,
      role: raw.role as WsActionItem["role"],
      owner_email: raw.owner_email.toLowerCase(),
      deadline,
      finding_id: raw.finding_index !== null ? `f${raw.finding_index}` : undefined,
      status: "OPEN",
      edited: false,
    }));

    // Every SME gets the standard summary item, whether or not the model
    // produced one. It is a fixed obligation of the protocol, not a judgement.
    for (const sme of record.participants.filter((p) => p.role === "SME")) {
      const alreadyHas = actionItems.some(
        (item) => item.owner_email === sme.email && item.isSmeSummary,
      );
      if (!alreadyHas) {
        actionItems.push({
          id: `sme-${sme.id}`,
          item: SME_SUMMARY_ITEM,
          role: "SME",
          owner_email: sme.email,
          deadline,
          status: "OPEN",
          isSmeSummary: true,
          edited: false,
        });
      }
    }

    const guard = guardFindings({
      findings,
      actionItems,
      participants: record.participants,
      meetingDate: record.meetingDate,
    });

    const updated = await store.update(vaultId, (current) => {
      current.findings = {
        kind: "FINDINGS_ACTION_ITEMS",
        state: guard.ok || isRecoverable(guard) ? "DRAFT" : "GUARDRAIL_FAILED",
        meetingDate: current.meetingDate,
        // The attendance report is authoritative on duration, not the
        // transcript header — they disagree in practice.
        durationMinutes,
        participants: current.participants,
        findings,
        actionItems,
        speakerMap: result.data.speaker_labels.map((label) => ({
          speakerLabel: label,
          participantId: null,
          inferred: false,
          confirmed: false,
        })),
        inputAttachmentIds: [
          request.transcript!.attachmentId,
          ...(request.attendance ? [request.attendance.attachmentId] : []),
        ],
        generatedAt: new Date().toISOString(),
        guardrailFailures: guard.failures,
        model: result.model,
        promptVersion: PROMPT_VERSION,
      };
      current.actionItems = actionItems;
      return current;
    });

    return json({
      woodshed: updated,
      guardrails: guard,
      usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
    });
  });

  /**
   * Approve a draft.
   *
   * The gate. Refuses while any non-recoverable guardrail failure stands — there
   * is no "publish with a warning" path for a figure that does not reconcile.
   */
  router.post("/api/sessions/:vaultId/ai/:kind/approve", async (ctx) => {
    const { vaultId, kind } = ctx.params as { vaultId: string; kind: string };
    if (kind !== "claim-overview" && kind !== "findings") {
      throw new HttpError(404, "Unknown document kind");
    }
    await requireVaultAccess(ctx, vaultId);

    const record = await store.get(vaultId);
    if (!record) throw new HttpError(404, "No Woodshed record for this session");

    const draft = kind === "claim-overview" ? record.claimOverview : record.findings;
    if (!draft) throw new HttpError(409, "There is no draft to approve");
    if (draft.state === "APPROVED" || draft.state === "PUBLISHED") {
      throw new HttpError(409, "This document has already been approved");
    }

    const blocking = (draft.guardrailFailures ?? []).filter((f) => !f.recoverable);
    if (blocking.length > 0) {
      throw new HttpError(
        409,
        "This draft cannot be approved while checks are failing.",
        blocking,
      );
    }

    const approvedBy = ctx.request.headers.get("x-ws-approver") ?? "unknown";
    const updated = await store.update(vaultId, (current) => {
      const target = kind === "claim-overview" ? current.claimOverview : current.findings;
      if (target) {
        target.state = "APPROVED";
        target.approvedAt = new Date().toISOString();
        target.approvedBy = approvedBy;
      }
      return current;
    });

    return json({ woodshed: updated });
  });

  return router;
}
