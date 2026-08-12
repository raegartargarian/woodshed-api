/**
 * Deterministic guardrails.
 *
 * These run **before any draft is shown to the auditor** and before anything is
 * rendered, uploaded, hashed or emailed. Every check is fail-closed: a failure
 * produces no draft at all, naming the specific assertion that failed.
 *
 * The point is that almost none of the hard constraints are enforced by prompt
 * text. A model asked politely for correct arithmetic will sometimes produce
 * incorrect arithmetic; a model that cannot say "not in the document" will
 * invent one. So the model proposes and this module disposes.
 */

import {
  type CellRef,
  FINANCIAL_EXTRAS,
  FINANCIAL_ROWS,
  type FinancialTable,
  formatUsd,
  type GuardrailFailure,
  isWsRole,
  lintVocabulary,
  type WsActionItem,
  type WsFinding,
  type WsParticipant,
} from "../domain/mod.ts";

export interface GuardrailResult {
  ok: boolean;
  failures: GuardrailFailure[];
}

function fail(check: string, message: string, recoverable = false): GuardrailFailure {
  return { check, message, recoverable };
}

// ---------------------------------------------------------------------------
// Financials
// ---------------------------------------------------------------------------

/** A flat map of `"Sheet!A1" → raw cell text`, supplied by whoever parsed the workbook. */
export type CellMap = Record<string, string>;

function cellKey(ref: CellRef): string {
  return `${ref.sheet}!${ref.cell}`.toUpperCase();
}

/** Currency text → integer cents. Returns null when the text is not a number. */
export function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "").trim();
  if (!cleaned) return null;

  // Accounting negatives: (1,234.56)
  const negated = /^\((.*)\)$/.exec(cleaned);
  const body = negated ? negated[1]! : cleaned;
  if (!/^-?\d+(\.\d{1,2})?$/.test(body)) return null;

  const cents = Math.round(Number(body) * 100);
  if (!Number.isFinite(cents)) return null;
  return negated || body.startsWith("-") ? -Math.abs(cents) : cents;
}

/**
 * G1 — every figure is traceable to a cell that actually contains it.
 *
 * The single highest-value check in the system. A model reading a spreadsheet
 * with merged cells and multi-row headers will confidently return a plausible
 * wrong number; re-reading the cell it cited catches exactly that.
 */
export function checkProvenance(table: FinancialTable, cells: CellMap): GuardrailFailure[] {
  const failures: GuardrailFailure[] = [];

  const verify = (label: string, cents: number, source: CellRef | null) => {
    if (!source) {
      failures.push(fail("G1 provenance", `${label} was reported without a source cell.`));
      return;
    }
    const raw = cells[cellKey(source)];
    if (raw === undefined) {
      failures.push(
        fail("G1 provenance", `${label} cites ${cellKey(source)}, which is not in the workbook.`),
      );
      return;
    }
    const actual = parseMoney(raw);
    if (actual === null) {
      failures.push(
        fail(
          "G1 provenance",
          `${label} cites ${cellKey(source)} ("${raw}"), which is not a number.`,
        ),
      );
      return;
    }
    if (actual !== cents) {
      failures.push(
        fail(
          "G1 provenance",
          `${label} was reported as ${formatUsd(cents)} but ${cellKey(source)} contains ` +
            `${formatUsd(actual)}.`,
        ),
      );
    }
  };

  for (const row of FINANCIAL_ROWS) {
    const entry = table.rows[row];
    verify(`${row} reserves`, entry.reserves.cents, entry.reserves.source);
    verify(`${row} paid`, entry.paid.cents, entry.paid.source);
    verify(`${row} incurred`, entry.incurred.cents, entry.incurred.source);
  }
  for (const extra of FINANCIAL_EXTRAS) {
    verify(extra, table.extras[extra].cents, table.extras[extra].source);
  }

  return failures;
}

/**
 * G2 — the column sums to its stated total, to the cent.
 *
 * Verified against the client's own example: Medical + Indemnity + Rehab +
 * Legal + Other equals TOTALS exactly in all three columns.
 */
export function checkColumnTotals(table: FinancialTable): GuardrailFailure[] {
  const failures: GuardrailFailure[] = [];
  const columns = ["reserves", "paid", "incurred"] as const;

  for (const column of columns) {
    const sum = FINANCIAL_ROWS.reduce((acc, row) => acc + table.rows[row][column].cents, 0);
    const stated = table.totals[column].cents;
    if (sum !== stated) {
      failures.push(
        fail(
          "G2 column reconciliation",
          `The ${column} column sums to ${formatUsd(sum)} but TOTALS says ` +
            `${formatUsd(stated)} (out by ${formatUsd(stated - sum)}).`,
        ),
      );
    }
  }
  return failures;
}

/** G3 — `Incurred == Reserves + Paid`, on every row and on the totals. */
export function checkIncurredIdentity(table: FinancialTable): GuardrailFailure[] {
  const failures: GuardrailFailure[] = [];

  const check = (label: string, r: number, p: number, i: number) => {
    if (r + p !== i) {
      failures.push(
        fail(
          "G3 incurred identity",
          `${label}: reserves ${formatUsd(r)} + paid ${formatUsd(p)} = ${formatUsd(r + p)}, ` +
            `but incurred says ${formatUsd(i)}.`,
        ),
      );
    }
  };

  for (const row of FINANCIAL_ROWS) {
    const entry = table.rows[row];
    check(row, entry.reserves.cents, entry.paid.cents, entry.incurred.cents);
  }
  check(
    "TOTALS",
    table.totals.reserves.cents,
    table.totals.paid.cents,
    table.totals.incurred.cents,
  );

  return failures;
}

// ---------------------------------------------------------------------------
// Roles, roster and dates
// ---------------------------------------------------------------------------

/**
 * G4 — every action item is owned by a real member of this Woodshed's roster,
 * in a role from the fixed enum.
 *
 * An action item addressed to someone who is not a participant cannot be
 * delivered, and one addressed to the wrong role misdirects the work.
 */
export function checkOwnership(
  items: WsActionItem[],
  roster: WsParticipant[],
): GuardrailFailure[] {
  const failures: GuardrailFailure[] = [];
  const byEmail = new Map(roster.map((p) => [p.email.toLowerCase(), p]));

  for (const item of items) {
    const email = item.owner_email?.toLowerCase() ?? "";
    const participant = byEmail.get(email);

    if (!participant) {
      failures.push(
        fail(
          "G4 ownership",
          `"${item.item.slice(0, 60)}…" is assigned to ${item.owner_email || "nobody"}, ` +
            `who is not on this Woodshed's roster.`,
        ),
      );
      continue;
    }
    if (!isWsRole(item.role)) {
      failures.push(fail("G4 ownership", `"${item.role}" is not a valid role.`));
      continue;
    }
    if (participant.role !== item.role) {
      failures.push(
        fail(
          "G4 ownership",
          `${item.owner_email} is on the roster as ${participant.role}, but the item ` +
            `assigns them as ${item.role}.`,
        ),
      );
    }
  }
  return failures;
}

/**
 * G5 — participant tables carry emails only, never names.
 *
 * The rule applies to meeting participants specifically; the Claim Overview
 * prose may name the claimant, adjuster and attorney, as the client's own
 * example does. This checks the roster the Findings document renders.
 */
export function checkNoNames(participants: WsParticipant[]): GuardrailFailure[] {
  const failures: GuardrailFailure[] = [];
  for (const participant of participants) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(participant.email)) {
      failures.push(
        fail(
          "G5 emails only",
          `"${participant.email}" is not an email address. The participants table ` +
            `must contain addresses, never names.`,
        ),
      );
    }
  }
  return failures;
}

/**
 * G6 — dates parse and fall in a plausible window.
 *
 * A deadline before the meeting or years after it is a model arithmetic error,
 * and deadlines drive when people are chased.
 */
export function checkDeadlines(
  items: WsActionItem[],
  meetingDate: string | null,
  horizonDays = 180,
): GuardrailFailure[] {
  const failures: GuardrailFailure[] = [];
  if (!meetingDate) {
    return [fail("G6 deadlines", "No meeting date is set, so deadlines cannot be validated.")];
  }

  const meeting = Date.parse(`${meetingDate}T00:00:00Z`);
  const horizon = meeting + horizonDays * 86_400_000;

  for (const item of items) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.deadline)) {
      failures.push(
        fail("G6 deadlines", `"${item.item.slice(0, 40)}…" has an unparseable deadline.`),
      );
      continue;
    }
    const due = Date.parse(`${item.deadline}T00:00:00Z`);
    if (due < meeting) {
      failures.push(
        fail(
          "G6 deadlines",
          `"${item.item.slice(0, 40)}…" is due ${item.deadline}, before the meeting ` +
            `on ${meetingDate}.`,
        ),
      );
    } else if (due > horizon) {
      failures.push(
        fail(
          "G6 deadlines",
          `"${item.item.slice(0, 40)}…" is due ${item.deadline}, more than ${horizonDays} ` +
            `days after the meeting.`,
        ),
      );
    }
  }
  return failures;
}

/** G7 — generated prose respects the client's controlled vocabulary. */
export function checkVocabulary(findings: WsFinding[]): GuardrailFailure[] {
  const failures: GuardrailFailure[] = [];
  for (const finding of findings) {
    for (const hit of lintVocabulary(finding.text)) {
      failures.push(
        fail(
          "G7 vocabulary",
          `"${hit.banned}" is on the avoid list — use "${hit.replacement}" instead.`,
          // Recoverable: the substitution is mechanical and the auditor can
          // accept it, unlike a wrong number.
          true,
        ),
      );
    }
  }
  return failures;
}

/**
 * G8 — the Claim Overview is five sentences or fewer.
 *
 * Enforced on the output shape rather than by asking: the model returns an array
 * of sentences and the array is counted. Recoverable — worth one retry before
 * involving the auditor.
 */
export function checkSentenceCount(sentences: string[], max = 5): GuardrailFailure[] {
  if (sentences.length === 0) {
    return [fail("G8 length", "The Claim Overview came back empty.")];
  }
  if (sentences.length > max) {
    return [
      fail(
        "G8 length",
        `The Claim Overview is ${sentences.length} sentences; the limit is ${max}.`,
        true,
      ),
    ];
  }
  return [];
}

/** G9 — every finding cites the transcript. An unsourced finding is unverifiable. */
export function checkEvidence(findings: WsFinding[]): GuardrailFailure[] {
  const failures: GuardrailFailure[] = [];
  for (const finding of findings) {
    if (!finding.evidence_quote?.trim()) {
      failures.push(
        fail(
          "G9 evidence",
          `"${finding.text.slice(0, 60)}…" carries no supporting quote from the transcript.`,
        ),
      );
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

export function guardClaimOverview(input: {
  sentences: string[];
  financials: FinancialTable | null;
  cells: CellMap;
}): GuardrailResult {
  const failures = [
    ...checkSentenceCount(input.sentences),
    ...(input.financials
      ? [
        ...checkProvenance(input.financials, input.cells),
        ...checkColumnTotals(input.financials),
        ...checkIncurredIdentity(input.financials),
      ]
      : []),
  ];
  return { ok: failures.length === 0, failures };
}

export function guardFindings(input: {
  findings: WsFinding[];
  actionItems: WsActionItem[];
  participants: WsParticipant[];
  meetingDate: string | null;
}): GuardrailResult {
  const failures = [
    ...checkNoNames(input.participants),
    ...checkEvidence(input.findings),
    ...checkVocabulary(input.findings),
    ...checkOwnership(input.actionItems, input.participants),
    ...checkDeadlines(input.actionItems, input.meetingDate),
  ];
  return { ok: failures.length === 0, failures };
}

/** True when every remaining failure is one the auditor may knowingly accept. */
export function isRecoverable(result: GuardrailResult): boolean {
  return !result.ok && result.failures.every((f) => f.recoverable);
}
