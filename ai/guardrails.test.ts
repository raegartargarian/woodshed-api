import { assertEquals } from "jsr:@std/assert@1";
import {
  type CellMap,
  checkColumnTotals,
  checkDeadlines,
  checkEvidence,
  checkIncurredIdentity,
  checkNoNames,
  checkOwnership,
  checkProvenance,
  checkSentenceCount,
  checkVocabulary,
  guardClaimOverview,
  guardFindings,
  isRecoverable,
  parseMoney,
} from "./guardrails.ts";
import type { FinancialTable, WsActionItem, WsFinding, WsParticipant } from "../domain/mod.ts";

/**
 * The financial fixture uses the figures from a real Claim Summary, which
 * reconcile exactly: each column sums to TOTALS, and incurred = reserves + paid
 * on every row. That is what makes it a useful baseline — a fixture that did not
 * reconcile would make the checks untestable.
 */
const CELLS: CellMap = {
  "CLAIM!B27": "$3,820.09",
  "CLAIM!C27": "$41,979.91",
  "CLAIM!D27": "$45,800.00",
  "CLAIM!B28": "$12,829.02",
  "CLAIM!C28": "$26,794.44",
  "CLAIM!D28": "$39,623.46",
  "CLAIM!B29": "$0.00",
  "CLAIM!C29": "$0.00",
  "CLAIM!D29": "$0.00",
  "CLAIM!B30": "$0.00",
  "CLAIM!C30": "$0.00",
  "CLAIM!D30": "$0.00",
  "CLAIM!B31": "$1,214.36",
  "CLAIM!C31": "$2,435.64",
  "CLAIM!D31": "$3,650.00",
  "CLAIM!B32": "$17,863.47",
  "CLAIM!C32": "$71,209.99",
  "CLAIM!D32": "$89,073.46",
  "CLAIM!B33": "$0.00",
  "CLAIM!C33": "$0.00",
  "CLAIM!D33": "$0.00",
};

const cell = (ref: string) => ({ sheet: "CLAIM", cell: ref, raw_text: CELLS[`CLAIM!${ref}`]! });

function table(): FinancialTable {
  return {
    rows: {
      Medical: {
        reserves: { cents: 382009, source: cell("B27") },
        paid: { cents: 4197991, source: cell("C27") },
        incurred: { cents: 4580000, source: cell("D27") },
      },
      Indemnity: {
        reserves: { cents: 1282902, source: cell("B28") },
        paid: { cents: 2679444, source: cell("C28") },
        incurred: { cents: 3962346, source: cell("D28") },
      },
      Rehab: {
        reserves: { cents: 0, source: cell("B29") },
        paid: { cents: 0, source: cell("C29") },
        incurred: { cents: 0, source: cell("D29") },
      },
      Legal: {
        reserves: { cents: 0, source: cell("B30") },
        paid: { cents: 0, source: cell("C30") },
        incurred: { cents: 0, source: cell("D30") },
      },
      Other: {
        reserves: { cents: 121436, source: cell("B31") },
        paid: { cents: 243564, source: cell("C31") },
        incurred: { cents: 365000, source: cell("D31") },
      },
    },
    totals: {
      reserves: { cents: 1786347, source: cell("B32") },
      paid: { cents: 7120999, source: cell("C32") },
      incurred: { cents: 8907346, source: cell("D32") },
    },
    extras: {
      Refunds: { cents: 0, source: cell("B33") },
      Subrogation: { cents: 0, source: cell("C33") },
      Reinsurance: { cents: 0, source: cell("D33") },
    },
  };
}

// ---------------------------------------------------------------------------

Deno.test("money parses the formats a workbook actually contains", () => {
  assertEquals(parseMoney("$3,820.09"), 382009);
  assertEquals(parseMoney("0"), 0);
  assertEquals(parseMoney("$0.00"), 0);
  assertEquals(parseMoney("  1234.5 "), 123450);
  assertEquals(parseMoney("(514.83)"), -51483); // accounting negative
  assertEquals(parseMoney("-514.83"), -51483);
});

Deno.test("money refuses text that is not a number", () => {
  assertEquals(parseMoney(""), null);
  assertEquals(parseMoney("N/A"), null);
  assertEquals(parseMoney("see note"), null);
  assertEquals(parseMoney("1.234"), null); // three decimal places is not currency
});

Deno.test("a correct financial table passes every check", () => {
  assertEquals(checkProvenance(table(), CELLS), []);
  assertEquals(checkColumnTotals(table()), []);
  assertEquals(checkIncurredIdentity(table()), []);
});

Deno.test("a figure that does not match its cited cell is caught", () => {
  const t = table();
  t.rows.Medical.paid.cents = 4197990; // one cent off
  const failures = checkProvenance(t, CELLS);

  assertEquals(failures.length, 1);
  assertEquals(failures[0]?.check, "G1 provenance");
  assertEquals(failures[0]?.recoverable, false);
});

Deno.test("a figure citing a cell that does not exist is caught", () => {
  const t = table();
  t.rows.Medical.paid.source = { sheet: "CLAIM", cell: "Z99", raw_text: "$41,979.91" };
  assertEquals(checkProvenance(t, CELLS).length, 1);
});

Deno.test("a figure with no source at all is caught", () => {
  const t = table();
  t.rows.Legal.incurred.source = null;
  const failures = checkProvenance(t, CELLS);
  assertEquals(failures.length, 1);
  assertEquals(failures[0]?.message.includes("without a source cell"), true);
});

Deno.test("a column that does not sum to its total is caught", () => {
  const t = table();
  t.totals.paid.cents = 7120000;
  const failures = checkColumnTotals(t);
  assertEquals(failures.length, 1);
  assertEquals(failures[0]?.check, "G2 column reconciliation");
});

Deno.test("a broken incurred identity is caught on the row that broke it", () => {
  const t = table();
  t.rows.Indemnity.incurred.cents = 3962300;
  const failures = checkIncurredIdentity(t);
  assertEquals(failures.length, 1);
  assertEquals(failures[0]?.message.startsWith("Indemnity"), true);
});

Deno.test("a plausible-but-wrong table fails rather than being published", () => {
  // The realistic failure mode: every number looks like money and the table
  // renders fine, but one figure was misread from a merged cell.
  const t = table();
  t.rows.Other.paid.cents = 243560;
  const result = guardClaimOverview({
    sentences: ["One sentence."],
    financials: t,
    cells: CELLS,
  });

  assertEquals(result.ok, false);
  assertEquals(isRecoverable(result), false); // money errors are never waivable
});

// ---------------------------------------------------------------------------

Deno.test("the Claim Overview must be five sentences or fewer", () => {
  assertEquals(checkSentenceCount(["a", "b", "c", "d", "e"]), []);
  const failures = checkSentenceCount(["a", "b", "c", "d", "e", "f"]);
  assertEquals(failures.length, 1);
  assertEquals(failures[0]?.recoverable, true); // worth one retry
});

Deno.test("an empty Claim Overview is a hard failure, not a short one", () => {
  const failures = checkSentenceCount([]);
  assertEquals(failures.length, 1);
  assertEquals(failures[0]?.recoverable, false);
});

// ---------------------------------------------------------------------------

const roster: WsParticipant[] = [
  { id: "1", role: "Auditor", email: "auditor@example.com", addedAt: "" },
  { id: "2", role: "SME", email: "sme@example.com", addedAt: "" },
  { id: "3", role: "Adjuster", email: "adjuster@example.com", addedAt: "" },
];

function item(overrides: Partial<WsActionItem> = {}): WsActionItem {
  return {
    id: "i1",
    item: "Complete the chart review and distribute a written summary",
    role: "SME",
    owner_email: "sme@example.com",
    deadline: "2026-07-23",
    status: "OPEN",
    edited: false,
    ...overrides,
  };
}

Deno.test("an item owned by a roster member in their own role passes", () => {
  assertEquals(checkOwnership([item()], roster), []);
});

Deno.test("an item assigned to someone off the roster is caught", () => {
  const failures = checkOwnership([item({ owner_email: "stranger@example.com" })], roster);
  assertEquals(failures.length, 1);
  assertEquals(failures[0]?.message.includes("not on this Woodshed's roster"), true);
});

Deno.test("an item assigning a roster member the wrong role is caught", () => {
  // The realistic error: the model reads the transcript and decides the SME is
  // the adjuster. The item would then be chased from the wrong person.
  const failures = checkOwnership([item({ role: "Adjuster" })], roster);
  assertEquals(failures.length, 1);
  assertEquals(failures[0]?.message.includes("on the roster as SME"), true);
});

Deno.test("an item with no owner at all is caught", () => {
  assertEquals(checkOwnership([item({ owner_email: "" })], roster).length, 1);
});

Deno.test("owner matching is case-insensitive", () => {
  assertEquals(checkOwnership([item({ owner_email: "SME@Example.com" })], roster), []);
});

// ---------------------------------------------------------------------------

Deno.test("the participants table must hold addresses, not names", () => {
  assertEquals(checkNoNames(roster), []);
  const failures = checkNoNames([
    { id: "4", role: "SME", email: "Katie Reynolds", addedAt: "" },
  ]);
  assertEquals(failures.length, 1);
  assertEquals(failures[0]?.check, "G5 emails only");
});

// ---------------------------------------------------------------------------

Deno.test("deadlines inside the window pass", () => {
  assertEquals(checkDeadlines([item()], "2026-07-09"), []);
});

Deno.test("a deadline before the meeting is caught", () => {
  const failures = checkDeadlines([item({ deadline: "2026-07-01" })], "2026-07-09");
  assertEquals(failures.length, 1);
  assertEquals(failures[0]?.message.includes("before the meeting"), true);
});

Deno.test("a deadline far beyond the horizon is caught", () => {
  const failures = checkDeadlines([item({ deadline: "2028-01-01" })], "2026-07-09");
  assertEquals(failures.length, 1);
});

Deno.test("an unparseable deadline is caught", () => {
  assertEquals(checkDeadlines([item({ deadline: "next Tuesday" })], "2026-07-09").length, 1);
});

Deno.test("no meeting date means deadlines cannot be validated at all", () => {
  const failures = checkDeadlines([item()], null);
  assertEquals(failures.length, 1);
  assertEquals(failures[0]?.message.includes("No meeting date"), true);
});

// ---------------------------------------------------------------------------

function finding(overrides: Partial<WsFinding> = {}): WsFinding {
  return {
    id: "f1",
    text: "Medical management is proactive and documented.",
    evidence_quote: "We have the injections scheduled and documented.",
    source_segments: ["00:12:04"],
    proposed_score: 4,
    confirmed_score: null,
    score_rationale: null,
    edited: false,
    ...overrides,
  };
}

Deno.test("a finding with no supporting quote is caught", () => {
  assertEquals(checkEvidence([finding()]), []);
  assertEquals(checkEvidence([finding({ evidence_quote: "" })]).length, 1);
  assertEquals(checkEvidence([finding({ evidence_quote: "   " })]).length, 1);
});

Deno.test("banned vocabulary in a finding is caught and is waivable", () => {
  const failures = checkVocabulary([
    finding({ text: "Escalation recommended for further review." }),
  ]);
  assertEquals(failures.length, 1);
  assertEquals(failures[0]?.check, "G7 vocabulary");
  assertEquals(failures[0]?.recoverable, true);
  assertEquals(failures[0]?.message.includes("Collaborative Review"), true);
});

// ---------------------------------------------------------------------------

Deno.test("a clean findings draft passes the whole suite", () => {
  const result = guardFindings({
    findings: [finding()],
    actionItems: [item()],
    participants: roster,
    meetingDate: "2026-07-09",
  });
  assertEquals(result, { ok: true, failures: [] });
});

Deno.test("a findings draft with only vocabulary problems is waivable", () => {
  const result = guardFindings({
    findings: [finding({ text: "A deficiency was noted in the file." })],
    actionItems: [item()],
    participants: roster,
    meetingDate: "2026-07-09",
  });
  assertEquals(result.ok, false);
  assertEquals(isRecoverable(result), true);
});

Deno.test("a findings draft with a misassigned owner is not waivable", () => {
  const result = guardFindings({
    findings: [finding()],
    actionItems: [item({ owner_email: "stranger@example.com" })],
    participants: roster,
    meetingDate: "2026-07-09",
  });
  assertEquals(result.ok, false);
  assertEquals(isRecoverable(result), false);
});

Deno.test("every failure names the specific assertion that failed", () => {
  const result = guardFindings({
    findings: [finding({ evidence_quote: "" })],
    actionItems: [item({ deadline: "2020-01-01" })],
    participants: roster,
    meetingDate: "2026-07-09",
  });
  assertEquals(result.failures.length, 2);
  for (const failure of result.failures) {
    assertEquals(failure.check.length > 0, true);
    assertEquals(failure.message.length > 20, true);
  }
});
