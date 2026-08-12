/**
 * Prompts and response schemas.
 *
 * Versioned, because a generated document has to be reproducible from
 * `(prompt_version, inputs)` — a Woodshed document may be circulated to a
 * carrier or an attorney, and "which prompt produced this" is a question that
 * will eventually be asked.
 *
 * Note what is *not* asked for here: dates in display format, currency symbols,
 * deadline arithmetic, or the Protocol™ notice. All of those are produced in
 * code. The model emits data only.
 */

import { COMPLIANCE_RUBRIC, STANDARD_FINDINGS, WS_ROLES } from "../domain/mod.ts";

export const PROMPT_VERSION = "1.0.0";

const VOCABULARY_GUIDANCE = `
Preferred vocabulary. Use the term on the right, never the one on the left:
  Escalation        -> Collaborative Review
  Deficiency        -> Opportunity for Alignment
  Failure           -> Operational Concern
  Punitive Review   -> Strategy Roundtable
  Corrective Action -> Resolution Pathway

Objectivity principles:
- Base every statement on documented evidence only.
- Focus on operational behaviour, never on personal criticism of individuals.
- Do not assume anything the documents do not support.
`.trim();

// ---------------------------------------------------------------------------
// Claim Overview
// ---------------------------------------------------------------------------

export const CLAIM_OVERVIEW_SYSTEM = `
You are assisting a workers' compensation claim auditor in preparing a Woodshed
Claim Overview.

Write a factual overview of the claim in FIVE SENTENCES OR FEWER. Focus on key
dates, financials and claim information, with a direct focus on the injury. Be
concise and factual. Do not editorialise and do not speculate.

You may name the claimant, the adjuster, the employer and any attorney of record
where the source documents name them.

Also extract the claim's financial table. For every figure you MUST cite the
exact sheet and cell it came from. If a figure is not present in the documents,
return it as absent rather than inferring or calculating it. Never compute a
total yourself — report only what the document states.

Emit data only:
- Dates as ISO (YYYY-MM-DD). Never in display format.
- Money as integer cents. No currency symbols, no separators, no decimals.
- No markup, no formatting, no headings.

${VOCABULARY_GUIDANCE}
`.trim();

/**
 * Response schema.
 *
 * Sentences are an array so the five-sentence limit can be *counted* rather than
 * asked for — `maxItems` is unreliable across structured-output compilers, so the
 * guardrail counts the array instead.
 */
export const CLAIM_OVERVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sentences", "financials"],
  properties: {
    sentences: {
      type: "array",
      description: "The overview, one sentence per element. Five or fewer.",
      items: { type: "string" },
    },
    financials: {
      type: "object",
      additionalProperties: false,
      required: ["rows", "totals", "extras", "sheet"],
      properties: {
        sheet: {
          type: "string",
          description: "Name of the sheet or document section the figures came from.",
        },
        rows: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "reserves", "paid", "incurred"],
            properties: {
              label: {
                type: "string",
                enum: ["Medical", "Indemnity", "Rehab", "Legal", "Other"],
              },
              reserves: { $ref: "#/$defs/figure" },
              paid: { $ref: "#/$defs/figure" },
              incurred: { $ref: "#/$defs/figure" },
            },
          },
        },
        totals: {
          type: "object",
          additionalProperties: false,
          required: ["reserves", "paid", "incurred"],
          properties: {
            reserves: { $ref: "#/$defs/figure" },
            paid: { $ref: "#/$defs/figure" },
            incurred: { $ref: "#/$defs/figure" },
          },
        },
        extras: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "figure"],
            properties: {
              label: { type: "string", enum: ["Refunds", "Subrogation", "Reinsurance"] },
              figure: { $ref: "#/$defs/figure" },
            },
          },
        },
      },
    },
  },
  $defs: {
    figure: {
      type: "object",
      additionalProperties: false,
      required: ["cents", "cell", "raw_text", "absent_reason"],
      properties: {
        cents: {
          type: ["integer", "null"],
          description: "Integer cents. Null when the figure is not in the document.",
        },
        cell: {
          type: ["string", "null"],
          description: "Cell reference the figure was read from, e.g. B27.",
        },
        raw_text: { type: ["string", "null"] },
        absent_reason: {
          type: ["string", "null"],
          description: "Why the figure is missing. Null when it is present.",
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Findings & action items
// ---------------------------------------------------------------------------

export const FINDINGS_SYSTEM = `
You are assisting a workers' compensation claim auditor in preparing Woodshed
Findings and Action Items from a meeting transcript and its attendance report.

Produce:
1. Findings — the substantive points discussed. Each MUST carry a verbatim
   supporting quote from the transcript. A finding you cannot quote is a finding
   you must not report.
2. Action items — the concrete next steps identified, each assigned to a role and
   to the email address of a participant on the supplied roster.
3. A proposed compliance score per finding, 0-5, WITH a rationale. This is a
   suggestion for the auditor to confirm, never a conclusion.

Hard rules:
- Assign action items ONLY to email addresses on the supplied roster, and ONLY to
  the role that roster gives them. Never invent a participant.
- Use ONLY these roles: ${WS_ROLES.join(", ")}.
- NEVER output a person's name in the participants or action items. Emails only.
- Do NOT compute deadlines. Omit them; they are calculated separately.
- Where the transcript identifies a speaker only by a label such as "Speaker 1",
  do not guess who they are. Report the label.

Compliance scale:
${COMPLIANCE_RUBRIC.map((r) => `  ${r.score} - ${r.label}: ${r.guidance}`).join("\n")}

Where a finding matches one of these standard findings, prefer its wording:
${STANDARD_FINDINGS.map((f) => `  - ${f}`).join("\n")}

${VOCABULARY_GUIDANCE}
`.trim();

export const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings", "action_items", "speaker_labels"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "text",
          "evidence_quote",
          "source_segments",
          "proposed_score",
          "score_rationale",
        ],
        properties: {
          text: { type: "string" },
          evidence_quote: {
            type: "string",
            description: "Verbatim from the transcript. Required.",
          },
          source_segments: {
            type: "array",
            items: { type: "string" },
            description: "Timestamps or speaker turns the finding came from.",
          },
          proposed_score: { type: ["integer", "null"], minimum: 0, maximum: 5 },
          score_rationale: { type: ["string", "null"] },
        },
      },
    },
    action_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "role", "owner_email", "finding_index"],
        properties: {
          item: { type: "string" },
          role: { type: "string", enum: [...WS_ROLES] },
          owner_email: {
            type: "string",
            description: "Must be an address from the supplied roster.",
          },
          finding_index: {
            type: ["integer", "null"],
            description: "Index into findings, or null when the item stands alone.",
          },
        },
      },
    },
    speaker_labels: {
      type: "array",
      description: "Unresolved speaker labels, e.g. 'Speaker 1'. Never guessed at.",
      items: { type: "string" },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Attendance → participants
// ---------------------------------------------------------------------------

export const ATTENDANCE_SYSTEM = `
Extract meeting participants from an attendance report.

The report has several sections. Use the section that lists business roles
(${WS_ROLES.join(", ")}), not the one listing meeting-platform roles such as
Organizer or Presenter.

For each participant return their email address, their business role, and the
name shown in the report. The name is returned ONLY so the auditor can check the
report for transposed rows — it is never rendered into a document.

Also return the meeting duration in minutes as stated by this report.
`.trim();

export const ATTENDANCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["participants", "duration_minutes", "meeting_date"],
  properties: {
    participants: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["email", "role", "name_in_report"],
        properties: {
          email: { type: "string" },
          role: { type: "string", enum: [...WS_ROLES] },
          name_in_report: { type: ["string", "null"] },
        },
      },
    },
    duration_minutes: { type: ["number", "null"] },
    meeting_date: {
      type: ["string", "null"],
      description: "ISO date (YYYY-MM-DD) of the meeting.",
    },
  },
} as const;
