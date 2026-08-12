/**
 * Email via Resend.
 *
 * These messages carry a link and a token to insurer and law-firm domains, which
 * is a textbook phishing signature from an unfamiliar sender. Two consequences
 * shape everything here:
 *
 *  - Send from a verified client domain, never a platform one.
 *  - Say plainly who sent it and why, in the first line. A terse "click here"
 *    from an unknown address gets deleted or reported.
 *
 * A non-delivery is indistinguishable from a busy recipient, so every send is
 * reported back to the auditor rather than assumed.
 */

import type { Config } from "../config.ts";
import { formatUsDate } from "../domain/mod.ts";

export interface SendResult {
  ok: boolean;
  to: string;
  id?: string;
  error?: string;
}

export class Mailer {
  constructor(private readonly cfg: Config) {}

  get enabled(): boolean {
    return this.cfg.email.enabled;
  }

  private async send(to: string, subject: string, html: string): Promise<SendResult> {
    if (!this.enabled) {
      return { ok: false, to, error: "Email is not configured on this deployment." };
    }

    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.email.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.cfg.email.from,
          to: [to],
          reply_to: this.cfg.email.replyTo || undefined,
          subject,
          html,
        }),
      });

      if (!response.ok) {
        return { ok: false, to, error: `Resend returned ${response.status}` };
      }
      const body = await response.json();
      return { ok: true, to, id: body?.id };
    } catch (error) {
      return { ok: false, to, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Action items for one owner, with their upload link when they are an SME. */
  actionItems(input: {
    to: string;
    role: string;
    claimNumber: string;
    wsNumber: number;
    items: { item: string; deadline: string }[];
    uploadUrl?: string;
  }): Promise<SendResult> {
    const rows = input.items
      .map(
        (item) =>
          `<tr>
             <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb">${escape(item.item)}</td>
             <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;white-space:nowrap">
               ${formatUsDate(item.deadline)}
             </td>
           </tr>`,
      )
      .join("");

    return this.send(
      input.to,
      `Woodshed ${input.claimNumber} - WS${input.wsNumber}: your action items`,
      layout(`
        <p>Following the Woodshed session on claim <strong>${escape(input.claimNumber)}</strong>,
        the following action ${input.items.length === 1 ? "item has" : "items have"} been
        assigned to you as <strong>${escape(input.role)}</strong>.</p>

        <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px">
          <thead>
            <tr>
              <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #111">Action item</th>
              <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #111">Due</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>

        ${
        input.uploadUrl
          ? `<p style="margin:24px 0">
               <a href="${input.uploadUrl}"
                  style="background:#6372ff;color:#fff;padding:12px 24px;border-radius:999px;
                         text-decoration:none;display:inline-block">Upload your summary</a>
             </p>
             <p style="font-size:13px;color:#6b7280">
               This link is unique to you and can be used once.
             </p>`
          : ""
      }
      `),
    );
  }

  /** A reminder for items that are due soon or already past due. */
  reminder(input: {
    to: string;
    claimNumber: string;
    wsNumber: number;
    items: { item: string; deadline: string; overdue: boolean }[];
    uploadUrl?: string;
  }): Promise<SendResult> {
    const anyOverdue = input.items.some((i) => i.overdue);

    const rows = input.items
      .map(
        (item) =>
          `<tr>
             <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb">${escape(item.item)}</td>
             <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;white-space:nowrap;
                        color:${item.overdue ? "#b91c1c" : "#111"}">
               ${formatUsDate(item.deadline)}${item.overdue ? " (past due)" : ""}
             </td>
           </tr>`,
      )
      .join("");

    return this.send(
      input.to,
      anyOverdue
        ? `Past due: Woodshed ${input.claimNumber} - WS${input.wsNumber}`
        : `Reminder: Woodshed ${input.claimNumber} - WS${input.wsNumber}`,
      layout(`
        <p>A quick reminder about your outstanding ${
        input.items.length === 1 ? "action item" : "action items"
      } from the Woodshed session on claim <strong>${escape(input.claimNumber)}</strong>.</p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px">
          <tbody>${rows}</tbody>
        </table>
        ${
        input.uploadUrl
          ? `<p style="margin:24px 0">
               <a href="${input.uploadUrl}"
                  style="background:#6372ff;color:#fff;padding:12px 24px;border-radius:999px;
                         text-decoration:none;display:inline-block">Upload your summary</a>
             </p>`
          : ""
      }
      `),
    );
  }

  /** Tells the auditor an SME has returned their summary. */
  smeReturned(input: {
    to: string;
    smeEmail: string;
    claimNumber: string;
    wsNumber: number;
    filename: string;
  }): Promise<SendResult> {
    return this.send(
      input.to,
      `Summary received: ${input.claimNumber} - WS${input.wsNumber}`,
      layout(`
        <p><strong>${escape(input.smeEmail)}</strong> has uploaded
        <strong>${escape(input.filename)}</strong> for claim
        <strong>${escape(input.claimNumber)}</strong> (WS${input.wsNumber}).</p>
        <p>It has been filed into the Correspondence stream.</p>
      `),
    );
  }
}

function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function layout(inner: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f8fafc;
    font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111">
    <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;padding:32px">
      <h1 style="font-size:18px;margin:0 0 20px;letter-spacing:1px;text-transform:uppercase">
        Woodshed Referral
      </h1>
      ${inner}
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0">
      <p style="font-size:11px;color:#6b7280;font-style:italic;line-height:1.5">
        The &ldquo;Woodshed&rdquo; is a closed collaborative advisory forum only. All
        recommendations, observations, and opinions are advisory in nature and do not
        constitute claim handling authority, legal advice, an attorney-client relationship,
        or decision-making authority. Information shared is confidential and restricted to
        authorized participants with a legitimate business need.
      </p>
    </div></body></html>`;
}
