/**
 * Woodshed domain model.
 *
 * Imported by BOTH the React app (`@shared/woodshed`) and the Deno server
 * (`../shared/woodshed.ts`). Keep it dependency-free and runtime-agnostic —
 * no React, no Deno globals, no Node built-ins.
 */

// ---------------------------------------------------------------------------
// Hierarchy
// ---------------------------------------------------------------------------

/**
 * The three vault levels. Each maps to one Filedgr template; `template_id`
 * is what identifies a vault's level, since vaults have no type column.
 */
export type WsLevel = "root" | "claim" | "session";

/** The seven fixed streams a session vault materialises from its template. */
export const WS_STREAMS = [
  { mapping: "state-documents", label: "State Documents" },
  { mapping: "medical", label: "Medical" },
  { mapping: "legal", label: "Legal" },
  { mapping: "investigation", label: "Investigation" },
  { mapping: "correspondence", label: "Correspondence" },
  { mapping: "claim-notes", label: "Claim Notes" },
  { mapping: "claim-financials", label: "Claim Financials" },
] as const;

export type WsStreamMapping = (typeof WS_STREAMS)[number]["mapping"];

export const WS_STREAM_MAPPINGS = WS_STREAMS.map((s) => s.mapping) as readonly WsStreamMapping[];

export function streamLabel(mapping: string): string {
  return WS_STREAMS.find((s) => s.mapping === mapping)?.label ?? mapping;
}

/** Where generated artefacts are filed. */
export const CLAIM_OVERVIEW_STREAM: WsStreamMapping = "claim-notes";
export const FINDINGS_STREAM: WsStreamMapping = "correspondence";
export const STATE_SNAPSHOT_STREAM: WsStreamMapping = "claim-notes";

// ---------------------------------------------------------------------------
// Description encoding
//
// `vaults.description` is the only writable free-text field on a vault
// (`UpdateVaultRequest` = {name?, description?, archived?}) and `GET /vaults`
// matches `search_term` against `name OR description`. That combination is what
// makes the hierarchy queryable in a single call without a backend change.
//
//   ws:root
//   ws:claim|parent:<uuid>|claim:10000001
//   ws:session|parent:<uuid>|claim:10000001|ws:1
// ---------------------------------------------------------------------------

export interface WsVaultTag {
  level: WsLevel;
  /** Parent vault id. Absent on roots. */
  parent?: string;
  /** Claim number, on claim and session vaults. */
  claim?: string;
  /** Session ordinal, on session vaults. 1-based. */
  ws?: number;
}

const TAG_PREFIX = "ws:";

export function encodeWsTag(tag: WsVaultTag): string {
  const parts = [`ws:${tag.level}`];
  if (tag.parent) parts.push(`parent:${tag.parent}`);
  if (tag.claim) parts.push(`claim:${tag.claim}`);
  if (tag.ws !== undefined) parts.push(`ws:${tag.ws}`);
  return parts.join("|");
}

/**
 * Parse the tag out of a vault description. Tolerant of surrounding human text
 * so an admin can leave a note alongside it. Returns null when no tag is present,
 * which is how non-Woodshed vaults are distinguished.
 */
export function parseWsTag(description?: string | null): WsVaultTag | null {
  if (!description) return null;
  const idx = description.indexOf(TAG_PREFIX);
  if (idx === -1) return null;

  // The tag runs to end-of-line; anything after a newline is free-form prose.
  const line = description.slice(idx).split(/[\n\r]/)[0] ?? "";
  const fields = line.split("|").map((f) => f.trim());

  let level: WsLevel | undefined;
  const tag: Partial<WsVaultTag> = {};

  for (const field of fields) {
    const sep = field.indexOf(":");
    if (sep === -1) continue;
    const key = field.slice(0, sep).trim();
    const value = field.slice(sep + 1).trim();
    if (!value) continue;

    if (key === "ws") {
      // `ws:` is overloaded: `ws:session` names the level, `ws:1` the ordinal.
      if (value === "root" || value === "claim" || value === "session") {
        level = value;
      } else {
        const n = Number(value);
        if (Number.isInteger(n) && n > 0) tag.ws = n;
      }
    } else if (key === "parent") {
      tag.parent = value;
    } else if (key === "claim") {
      tag.claim = value;
    }
  }

  if (!level) return null;
  return { level, ...tag };
}

/**
 * Rewrite a description's tag while preserving any human prose around it.
 * Callers must read-modify-write — `PUT /vaults/{id}` is last-write-wins.
 */
export function withWsTag(description: string | null | undefined, tag: WsVaultTag): string {
  const encoded = encodeWsTag(tag);
  if (!description) return encoded;

  const idx = description.indexOf(TAG_PREFIX);
  if (idx === -1) return `${encoded}\n${description}`.trim();

  const lineEnd = description.indexOf("\n", idx);
  const before = description.slice(0, idx);
  const after = lineEnd === -1 ? "" : description.slice(lineEnd);
  return `${before}${encoded}${after}`;
}

/** The `search_term` that returns every child of a given vault. */
export function childSearchTerm(parentVaultId: string): string {
  return `parent:${parentVaultId}`;
}

/** Display name for a session vault, e.g. "10000001 - WS1". */
export function sessionVaultName(claimNumber: string, wsNumber: number): string {
  return `${claimNumber} - WS${wsNumber}`;
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

/**
 * Fixed role enum. The Findings template states the role *types* are fixed but
 * the *quantity* of each is open-ended — the Castillo example has two Adjusters.
 */
export const WS_ROLES = ["Auditor", "Adjuster", "Employer", "SME"] as const;
export type WsRole = (typeof WS_ROLES)[number];

export function isWsRole(value: string): value is WsRole {
  return (WS_ROLES as readonly string[]).includes(value);
}

export interface WsParticipant {
  /** Stable id, assigned by Deno. */
  id: string;
  role: WsRole;
  email: string;
  /**
   * Only ever used to reconcile the attendance report against the roster and to
   * warn about transposed rows. Never rendered into a generated document —
   * the participant tables are email-only (D9).
   */
  nameFromAttendance?: string;
  /** Vault permission state, mirrored from Filedgr for display. */
  access?: WsAccessState;
  addedAt: string;
}

export type WsAccessState =
  | "PENDING"
  | "GRANTED"
  | "INVITED"
  | "FAILED";

// ---------------------------------------------------------------------------
// Status machine
// ---------------------------------------------------------------------------

export const WS_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "IN_REVIEW",
  "ACTIONED",
  "CLOSED",
] as const;
export type WsStatus = (typeof WS_STATUSES)[number];

/** Allowed transitions. CLOSED is reversible (open question Q4, default yes). */
export const WS_TRANSITIONS: Record<WsStatus, readonly WsStatus[]> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["IN_REVIEW", "DRAFT"],
  IN_REVIEW: ["ACTIONED", "SUBMITTED"],
  ACTIONED: ["CLOSED", "IN_REVIEW"],
  CLOSED: ["ACTIONED"],
};

export function canTransition(from: WsStatus, to: WsStatus): boolean {
  return WS_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Findings & action items
// ---------------------------------------------------------------------------

/**
 * Every extracted value can be explicitly absent. A model with no way to say
 * "not in the document" will invent one — this matters most for Refunds,
 * Subrogation and Reinsurance, which are usually blank.
 */
export interface Extracted<T> {
  value: T | null;
  absent_reason: string | null;
}

/** Provenance for a figure read out of the Audit Summary workbook. */
export interface CellRef {
  sheet: string;
  cell: string;
  raw_text: string;
}

export interface WsFinding {
  id: string;
  /** Prose as it will appear under "Woodshed Referral Findings". */
  text: string;
  /** Verbatim transcript support. Required — an unsourced finding is unverifiable. */
  evidence_quote: string;
  /** Transcript timestamps or speaker turns the finding was synthesised from. */
  source_segments: string[];
  /** AI-proposed 0–5 compliance score. Always a suggestion (D22). */
  proposed_score: number | null;
  /** Set once the auditor confirms or overrides the score. */
  confirmed_score: number | null;
  score_rationale: string | null;
  /** Terms the vocabulary lint rewrote or flagged. */
  lint_notes?: string[];
  edited: boolean;
}

export interface WsActionItem {
  id: string;
  /** The concrete next step. */
  item: string;
  role: WsRole;
  /** Must be a member of the session roster (guardrail G5). */
  owner_email: string;
  /** ISO date. Rendered MM/DD/YYYY. Always computed in code, never by a model. */
  deadline: string;
  /** Links the item back to the finding that produced it. */
  finding_id?: string;
  status: WsActionItemStatus;
  /** True for the auto-generated "Upload Final SME Summary (PDF format)" item. */
  isSmeSummary?: boolean;
  /** Set when a reminder was last sent, to avoid re-sending on every sweep. */
  lastReminderAt?: string;
  /** Attachment id of the SME's returned document, once uploaded. */
  returnedAttachmentId?: string;
  returnedAt?: string;
  edited: boolean;
}

export type WsActionItemStatus =
  | "OPEN"
  | "SENT"
  | "RETURNED"
  | "CLOSED";

/** The default SME action item every SME gets, per the Findings template prompt. */
export const SME_SUMMARY_ITEM = "Upload Final SME Summary (PDF format)";

/** D15: 14 calendar days from the meeting date, every item, editable. */
export const DEFAULT_DEADLINE_DAYS = 14;

/**
 * Deadline arithmetic. Calendar days, no holiday adjustment (open question Q6).
 * Pure date math on a UTC-normalised date so it cannot drift by timezone.
 */
export function computeDeadline(meetingDateIso: string, days = DEFAULT_DEADLINE_DAYS): string {
  const base = new Date(`${meetingDateIso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) {
    throw new Error(`computeDeadline: unparseable meeting date "${meetingDateIso}"`);
  }
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** Display format for every date in a generated document: MM/DD/YYYY. */
export function formatUsDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${m}/${d}/${y}`;
}

// ---------------------------------------------------------------------------
// Financials
// ---------------------------------------------------------------------------

export const FINANCIAL_ROWS = [
  "Medical",
  "Indemnity",
  "Rehab",
  "Legal",
  "Other",
] as const;
export type FinancialRow = (typeof FINANCIAL_ROWS)[number];

export const FINANCIAL_EXTRAS = ["Refunds", "Subrogation", "Reinsurance"] as const;
export type FinancialExtra = (typeof FINANCIAL_EXTRAS)[number];

/** Amounts are minor units (cents) as integers — never floats, never model-formatted. */
export interface FinancialCell {
  cents: number;
  source: CellRef | null;
}

export interface FinancialTable {
  rows: Record<
    FinancialRow,
    { reserves: FinancialCell; paid: FinancialCell; incurred: FinancialCell }
  >;
  totals: { reserves: FinancialCell; paid: FinancialCell; incurred: FinancialCell };
  extras: Record<FinancialExtra, FinancialCell>;
}

/** Currency rendering happens here, in code, from an integer. Never from model output. */
export function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const rest = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars}.${rest}`;
}

// ---------------------------------------------------------------------------
// Generated documents
// ---------------------------------------------------------------------------

export type WsDocumentKind = "CLAIM_OVERVIEW" | "FINDINGS_ACTION_ITEMS";

export type WsDraftState =
  | "NOT_STARTED"
  | "GENERATING"
  | "GUARDRAIL_FAILED"
  | "DRAFT"
  | "APPROVED"
  | "PUBLISHED";

export interface WsClaimOverviewDraft {
  kind: "CLAIM_OVERVIEW";
  state: WsDraftState;
  /** ≤5 sentences (guardrail G9). Stored as sentences so the count is checkable. */
  sentences: string[];
  financials: FinancialTable | null;
  /** Attachment ids the draft was generated from, for reproducibility. */
  inputAttachmentIds: string[];
  generatedAt?: string;
  approvedAt?: string;
  approvedBy?: string;
  /** Attachment id of the published PDF. */
  publishedAttachmentId?: string;
  guardrailFailures?: GuardrailFailure[];
  model?: string;
  promptVersion?: string;
}

export interface WsFindingsDraft {
  kind: "FINDINGS_ACTION_ITEMS";
  state: WsDraftState;
  meetingDate: string | null;
  /** Authoritative duration comes from the attendance report, not the transcript header. */
  durationMinutes: number | null;
  participants: WsParticipant[];
  findings: WsFinding[];
  actionItems: WsActionItem[];
  /** Inferred "Speaker N" → participant mapping, pending auditor confirmation. */
  speakerMap?: SpeakerMapping[];
  inputAttachmentIds: string[];
  generatedAt?: string;
  approvedAt?: string;
  approvedBy?: string;
  publishedAttachmentId?: string;
  guardrailFailures?: GuardrailFailure[];
  model?: string;
  promptVersion?: string;
}

export interface SpeakerMapping {
  speakerLabel: string;
  participantId: string | null;
  inferred: boolean;
  confirmed: boolean;
}

export interface GuardrailFailure {
  check: string;
  message: string;
  /** Set for soft failures the auditor may override. */
  recoverable: boolean;
}

// ---------------------------------------------------------------------------
// The Woodshed record
// ---------------------------------------------------------------------------

/** Schema version. Bump on any breaking change to the stored shape. */
export const WS_SCHEMA_VERSION = 1;

export interface WoodshedRecord {
  schema: typeof WS_SCHEMA_VERSION;

  /** Session vault id — the primary key. */
  vaultId: string;
  claimVaultId: string;
  rootVaultId: string;

  claimNumber: string;
  wsNumber: number;

  status: WsStatus;
  /** ISO date of the Woodshed meeting. Seeds every deadline. */
  meetingDate: string | null;

  participants: WsParticipant[];
  claimOverview: WsClaimOverviewDraft | null;
  findings: WsFindingsDraft | null;
  actionItems: WsActionItem[];

  createdAt: string;
  updatedAt: string;
  /** Bumped on every write; used for optimistic concurrency. */
  revision: number;
}

export function emptyWoodshed(init: {
  vaultId: string;
  claimVaultId: string;
  rootVaultId: string;
  claimNumber: string;
  wsNumber: number;
  now: string;
}): WoodshedRecord {
  return {
    schema: WS_SCHEMA_VERSION,
    vaultId: init.vaultId,
    claimVaultId: init.claimVaultId,
    rootVaultId: init.rootVaultId,
    claimNumber: init.claimNumber,
    wsNumber: init.wsNumber,
    status: "DRAFT",
    meetingDate: null,
    participants: [],
    claimOverview: null,
    findings: null,
    actionItems: [],
    createdAt: init.now,
    updatedAt: init.now,
    revision: 0,
  };
}

// ---------------------------------------------------------------------------
// Filename dates
//
// The brief says "Date_of_Service must be MM/DD/YYYY and in the doc name or
// upload fails". `/` is a path separator: it would corrupt the S3 key
// `uploads/{stream_id}/{attachment_id}/{filename}` and the server's filename guard rejects
// it outright. D18: accept several formats, normalise to MM-DD-YYYY, block only
// when nothing parses.
// ---------------------------------------------------------------------------

const DATE_PATTERNS: { re: RegExp; order: "mdy" | "ymd" }[] = [
  { re: /(\d{4})-(\d{2})-(\d{2})/, order: "ymd" },
  { re: /(\d{1,2})[-._](\d{1,2})[-._](\d{4})/, order: "mdy" },
  { re: /(\d{1,2})[-._](\d{1,2})[-._](\d{2})(?!\d)/, order: "mdy" },
];

export interface FilenameDate {
  iso: string;
  /** The exact substring matched, so the caller can replace it in place. */
  matched: string;
}

/** Extract a date of service from a filename. Returns null when none parses. */
export function parseFilenameDate(filename: string): FilenameDate | null {
  for (const { re, order } of DATE_PATTERNS) {
    const m = filename.match(re);
    if (!m) continue;

    let y: number, mo: number, d: number;
    if (order === "ymd") {
      [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    } else {
      [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (y < 100) y += 2000;
    }

    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    // Reject impossible days (e.g. 02-31) rather than silently rolling over.
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) continue;

    const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return { iso, matched: m[0] };
  }
  return null;
}

/**
 * Normalise a filename so its date of service reads MM-DD-YYYY, prepending one
 * when the caller supplies a fallback. Also strips characters the server's filename guard
 * rejects, so an upload can never fail on the filename alone.
 */
export function normalizeFilename(filename: string, fallbackIso?: string): string {
  const found = parseFilenameDate(filename);

  let out = filename;
  if (found) {
    const [y, m, d] = found.iso.split("-");
    out = filename.replace(found.matched, `${m}-${d}-${y}`);
  } else if (fallbackIso) {
    const [y, m, d] = fallbackIso.slice(0, 10).split("-");
    out = `${m}-${d}-${y} - ${filename}`;
  }
  return sanitizeFilename(out);
}

/**
 * Mirror of the backend's the server's filename guard, applied client-side so an upload
 * can never fail on the filename alone.
 */
export function sanitizeFilename(filename: string): string {
  let out = filename
    // Control characters are stripped deliberately; the storage layer rejects them.
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    // Collapse traversal sequences BEFORE touching separators — doing it after
    // turns "../.." into ".-.-", which then survives the leading-dot strip.
    .replace(/\.{2,}/g, ".")
    .replace(/[/\\]/g, "-")
    // Whatever debris a stripped path left behind at the front goes too.
    .replace(/^[-.\s]+/, "")
    .trim();

  if (out.length > 255) {
    const dot = out.lastIndexOf(".");
    const ext = dot > 0 ? out.slice(dot) : "";
    out = out.slice(0, 255 - ext.length) + ext;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Controlled vocabulary (Findings Library, from the client's own workbook)
// ---------------------------------------------------------------------------

export const FINDINGS_LIBRARY_SUBSTITUTIONS: Record<string, string> = {
  Escalation: "Collaborative Review",
  Deficiency: "Opportunity for Alignment",
  Failure: "Operational Concern",
  "Punitive Review": "Strategy Roundtable",
  "Corrective Action": "Resolution Pathway",
};

export interface VocabularyHit {
  banned: string;
  replacement: string;
  index: number;
}

/**
 * Find banned terms in generated prose. Longest-first so "Punitive Review" is
 * matched before "Review", and word-boundary anchored so "Failures" in a quoted
 * document title is caught but "failsafe" is not.
 */
export function lintVocabulary(text: string): VocabularyHit[] {
  const hits: VocabularyHit[] = [];
  const terms = Object.keys(FINDINGS_LIBRARY_SUBSTITUTIONS).sort((a, b) => b.length - a.length);

  for (const banned of terms) {
    const replacement = FINDINGS_LIBRARY_SUBSTITUTIONS[banned];
    if (!replacement) continue;

    const re = new RegExp(`\\b${banned.replace(/\s+/g, "\\s+")}\\w*\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const match = m;
      // A longer term already claimed this span — don't double-report the tail
      // (e.g. "Review" inside an already-matched "Punitive Review").
      if (hits.some((h) => match.index >= h.index && match.index < h.index + h.banned.length)) {
        continue;
      }
      hits.push({ banned: match[0], replacement, index: match.index });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** Apply the substitutions, preserving the original leading capitalisation. */
export function applyVocabulary(text: string): string {
  let out = text;
  for (const hit of lintVocabulary(text).reverse()) {
    const replacement = /^[A-Z]/.test(hit.banned)
      ? hit.replacement
      : hit.replacement.charAt(0).toLowerCase() + hit.replacement.slice(1);
    out = out.slice(0, hit.index) + replacement + out.slice(hit.index + hit.banned.length);
  }
  return out;
}

/** The 21 standard audit findings from the workbook, offered as auditor shortcuts. */
export const STANDARD_FINDINGS = [
  "Timely contact completed and documented",
  "Late initial contact",
  "Insufficient investigation documentation",
  "Reserve not timely updated",
  "Reserve rationale not documented",
  "Diary overdue",
  "Claim notes incomplete",
  "Medical management proactive and documented",
  "ODG guidelines not referenced",
  "Indemnity payment delay identified",
  "Subrogation opportunity missed",
  "Return to work strategy not addressed",
  "Compliance forms timely filed",
  "Late compliance form submission",
  "Litigation exposure not documented",
  "Closure strategy appropriate",
  "Closure opportunity missed",
  "Escalation recommended for Woodshed review",
  "Adjuster strategy appropriate",
  "Additional supervision recommended",
  "Request outstanding bills for closure",
] as const;

/** 0–5 compliance rubric from the Scoring Key Guide sheet. */
export const COMPLIANCE_RUBRIC = [
  { score: 5, label: "Excellent Compliance", guidance: "No guidance needed — claim on task" },
  { score: 4, label: "Critical Thinking evidenced", guidance: "Monitor for trends" },
  { score: 3, label: "Meets Expectations", guidance: "Standard supervisor oversight" },
  { score: 2, label: "Moderate Deficiency", guidance: "Corrective action required" },
  { score: 1, label: "Significant Deficiency", guidance: "Strong Woodshed consideration" },
  { score: 0, label: "Critical Failure", guidance: "Immediate escalation recommended" },
] as const;

// ---------------------------------------------------------------------------
// Protocol™ notice
//
// Rendered verbatim from this constant, never from model output, so it cannot be
// paraphrased, truncated or omitted.
// ---------------------------------------------------------------------------

export const WOODSHED_PROTOCOL_NOTICE =
  'The "Woodshed" is a closed collaborative advisory forum only. All recommendations, ' +
  "observations, and opinions are advisory in nature and do not constitute claim handling " +
  "authority, legal advice, an attorney-client relationship, or decision-making authority. " +
  "Final authority for compensability, benefits, reserves, and all operational decisions " +
  "remains solely with the designated claims administrator, employer, or carrier. " +
  "Participation does not alter existing contractual responsibilities or waive any legal " +
  "rights, defenses, or obligations. Information shared is confidential and restricted to " +
  "authorized participants with a legitimate business need.";
