import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  applyVocabulary,
  canTransition,
  childSearchTerm,
  computeDeadline,
  encodeWsTag,
  formatUsd,
  formatUsDate,
  lintVocabulary,
  normalizeFilename,
  parseFilenameDate,
  parseWsTag,
  sanitizeFilename,
  sessionVaultName,
  withWsTag,
} from "./mod.ts";

// ---------------------------------------------------------------------------
// Hierarchy encoding
// ---------------------------------------------------------------------------

Deno.test("hierarchy tags round-trip at every level", () => {
  const root = { level: "root" as const };
  const claim = { level: "claim" as const, parent: "aaa-111", claim: "10000001" };
  const session = { level: "session" as const, parent: "bbb-222", claim: "10000001", ws: 1 };

  assertEquals(parseWsTag(encodeWsTag(root)), root);
  assertEquals(parseWsTag(encodeWsTag(claim)), claim);
  assertEquals(parseWsTag(encodeWsTag(session)), session);
});

Deno.test("hierarchy tags use the documented wire format", () => {
  assertEquals(
    encodeWsTag({ level: "session", parent: "bbb", claim: "10000001", ws: 2 }),
    "ws:session|parent:bbb|claim:10000001|ws:2",
  );
});

Deno.test("untagged vaults are excluded from the tree", () => {
  assertEquals(parseWsTag("The stream mapped to the correspondence field"), null);
  assertEquals(parseWsTag(""), null);
  assertEquals(parseWsTag(null), null);
  assertEquals(parseWsTag(undefined), null);
});

Deno.test("a tag tolerates human prose after it", () => {
  const desc = "ws:claim|parent:abc|claim:10000001\nClaim narrative kept by an admin.";
  assertEquals(parseWsTag(desc), { level: "claim", parent: "abc", claim: "10000001" });
});

Deno.test("rewriting a tag preserves the prose around it", () => {
  const desc = "ws:claim|parent:old|claim:10000001\nAdmin note: reparented after a typo.";
  const updated = withWsTag(desc, { level: "claim", parent: "new", claim: "10000001" });

  assertEquals(parseWsTag(updated)?.parent, "new");
  assertEquals(updated.includes("Admin note: reparented after a typo."), true);
});

Deno.test("tagging an untagged description does not destroy it", () => {
  const updated = withWsTag("Existing human description", { level: "root" });
  assertEquals(updated.includes("Existing human description"), true);
  assertEquals(parseWsTag(updated), { level: "root" });
});

Deno.test("the child search term is a substring of the child's own tag", () => {
  // This is what makes the one-call child lookup work: the API's search_term is
  // a substring match over name OR description.
  assertEquals(childSearchTerm("abc-123"), "parent:abc-123");
  const child = encodeWsTag({ level: "session", parent: "abc-123", ws: 1 });
  assertEquals(child.includes(childSearchTerm("abc-123")), true);
});

Deno.test("session vaults are named claim + WS ordinal", () => {
  assertEquals(sessionVaultName("10000001", 1), "10000001 - WS1");
});

// ---------------------------------------------------------------------------
// Filename dates
// ---------------------------------------------------------------------------

Deno.test("filename dates parse in the primary format", () => {
  assertEquals(parseFilenameDate("07-09-2026 - Claim Summary.pdf")?.iso, "2026-07-09");
});

Deno.test("filename dates parse the alternates real files use", () => {
  assertEquals(parseFilenameDate("2026-07-09_transcript.pdf")?.iso, "2026-07-09");
  assertEquals(parseFilenameDate("Audit Summary 7.15.26.xlsx")?.iso, "2026-07-15");
  assertEquals(parseFilenameDate("Attendance report 7-09-26.xlsx")?.iso, "2026-07-09");
});

Deno.test("filenames with no date return null rather than guessing", () => {
  assertEquals(parseFilenameDate("Audit_Summary.xlsx"), null);
  assertEquals(parseFilenameDate("Claim_Overview_Example.docx"), null);
});

Deno.test("impossible dates are rejected, not rolled over", () => {
  assertEquals(parseFilenameDate("02-31-2026 report.pdf"), null);
  assertEquals(parseFilenameDate("13-01-2026 report.pdf"), null);
});

Deno.test("accepted date formats normalise to MM-DD-YYYY", () => {
  assertEquals(normalizeFilename("2026-07-09_transcript.pdf"), "07-09-2026_transcript.pdf");
  assertEquals(normalizeFilename("Audit Summary 7.15.26.xlsx"), "Audit Summary 07-15-2026.xlsx");
});

Deno.test("an undated filename gets the supplied date prepended", () => {
  assertEquals(
    normalizeFilename("Audit_Summary.xlsx", "2026-07-09"),
    "07-09-2026 - Audit_Summary.xlsx",
  );
});

Deno.test("an undated filename with no fallback is left alone", () => {
  assertEquals(normalizeFilename("Transcript.pdf"), "Transcript.pdf");
});

// ---------------------------------------------------------------------------
// Filename sanitisation
// ---------------------------------------------------------------------------

Deno.test("separators that would corrupt the storage key are removed", () => {
  // The object key embeds the filename after the stream and attachment ids and
  // is split on "/", so a stray slash silently mis-parses those ids.
  assertEquals(
    sanitizeFilename("07/09/2026 - Claim Summary.pdf"),
    "07-09-2026 - Claim Summary.pdf",
  );
  assertEquals(sanitizeFilename("a\\b.pdf"), "a-b.pdf");
});

Deno.test("traversal sequences and leading dots are stripped", () => {
  assertEquals(sanitizeFilename("../../etc/passwd"), "etc-passwd");
  assertEquals(sanitizeFilename(".hidden.pdf"), "hidden.pdf");
});

Deno.test("long filenames truncate while keeping the extension", () => {
  const out = sanitizeFilename("x".repeat(300) + ".pdf");
  assertEquals(out.length, 255);
  assertEquals(out.endsWith(".pdf"), true);
});

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

Deno.test("deadlines are 14 calendar days from the meeting date", () => {
  assertEquals(computeDeadline("2026-07-09"), "2026-07-23");
});

Deno.test("deadlines cross month and year boundaries", () => {
  assertEquals(computeDeadline("2026-12-26"), "2027-01-09");
  assertEquals(computeDeadline("2028-02-20"), "2028-03-05"); // leap year
});

Deno.test("deadlines are stable regardless of host timezone", () => {
  assertEquals(computeDeadline("2026-07-09T23:30:00-07:00"), "2026-07-23");
});

Deno.test("an unparseable meeting date throws instead of yielding Invalid Date", () => {
  assertThrows(() => computeDeadline("not a date"));
});

Deno.test("dates render MM/DD/YYYY, date only", () => {
  assertEquals(formatUsDate("2026-07-23"), "07/23/2026");
});

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

Deno.test("currency is formatted in code from integer cents", () => {
  assertEquals(formatUsd(382009), "$3,820.09");
  assertEquals(formatUsd(4197991), "$41,979.91");
  assertEquals(formatUsd(8907346), "$89,073.46");
  assertEquals(formatUsd(0), "$0.00");
});

Deno.test("currency handles negatives and sub-dollar amounts", () => {
  assertEquals(formatUsd(-51483), "-$514.83");
  assertEquals(formatUsd(9), "$0.09");
});

// ---------------------------------------------------------------------------
// Controlled vocabulary
// ---------------------------------------------------------------------------

Deno.test("the vocabulary lint flags every banned term", () => {
  const hits = lintVocabulary(
    "Escalation recommended; a deficiency was noted and corrective action required.",
  );
  assertEquals(hits.map((h) => h.banned.toLowerCase()), [
    "escalation",
    "deficiency",
    "corrective action",
  ]);
});

Deno.test("the longest banned term wins, so multi-word terms are not split", () => {
  const hits = lintVocabulary("A Punitive Review was proposed.");
  assertEquals(hits.length, 1);
  assertEquals(hits[0]?.replacement, "Strategy Roundtable");
});

Deno.test("substitution preserves sentence capitalisation", () => {
  assertEquals(
    applyVocabulary("Escalation recommended for Woodshed review."),
    "Collaborative Review recommended for Woodshed review.",
  );
  assertEquals(
    applyVocabulary("A deficiency was noted."),
    "A opportunity for Alignment was noted.",
  );
});

Deno.test("compliant prose is left untouched", () => {
  const clean = "Medical management proactive and documented.";
  assertEquals(lintVocabulary(clean), []);
  assertEquals(applyVocabulary(clean), clean);
});

// ---------------------------------------------------------------------------
// Status machine
// ---------------------------------------------------------------------------

Deno.test("the status machine advances through every state", () => {
  assertEquals(canTransition("DRAFT", "SUBMITTED"), true);
  assertEquals(canTransition("SUBMITTED", "IN_REVIEW"), true);
  assertEquals(canTransition("IN_REVIEW", "ACTIONED"), true);
  assertEquals(canTransition("ACTIONED", "CLOSED"), true);
});

Deno.test("the status machine refuses to skip states", () => {
  assertEquals(canTransition("DRAFT", "CLOSED"), false);
  assertEquals(canTransition("DRAFT", "ACTIONED"), false);
});

Deno.test("a closed Woodshed can be reopened", () => {
  assertEquals(canTransition("CLOSED", "ACTIONED"), true);
});
