/**
 * Distribution, the SME return channel, and the deadline sweep.
 *
 * The return channel is a page this service hosts rather than a download package,
 * because a package is download-only by design — an SME can take documents out of
 * one but cannot put their summary back in. A hosted page also gives us role
 * tagging and an auditor notification, neither of which a package can do.
 */

import { html, HttpError, json, type RequestContext, Router } from "../http.ts";
import type { WoodshedStore } from "../kv.ts";
import type { Config } from "../config.ts";
import { Mailer } from "../email/resend.ts";
import { FiledgrClient } from "../filedgr/client.ts";
import { FINDINGS_STREAM, formatUsDate, type WoodshedRecord } from "../domain/mod.ts";
import { requireVaultAccess } from "../filedgr/access.ts";

/** How long an SME has to use their link. Generous — chasing a dead link is worse. */
const UPLOAD_TOKEN_DAYS = 45;

function uploadUrl(ctx: RequestContext, token: string): string {
  return `${ctx.cfg.publicBaseUrl}/return/${token}`;
}

/** Group open items by owner so each person gets one email, not one per item. */
function byOwner(record: WoodshedRecord) {
  const groups = new Map<string, typeof record.actionItems>();
  for (const item of record.actionItems) {
    if (item.status === "RETURNED" || item.status === "CLOSED") continue;
    const list = groups.get(item.owner_email) ?? [];
    list.push(item);
    groups.set(item.owner_email, list);
  }
  return groups;
}

export function registerDistributionRoutes(router: Router, store: WoodshedStore): Router {
  /**
   * Send the action items.
   *
   * Refuses until the findings are approved: distributing items from an
   * unapproved draft would put an unreviewed AI output in front of an adjuster,
   * which is the exact failure the approval gate exists to prevent.
   */
  router.post("/api/sessions/:vaultId/distribute", async (ctx) => {
    const vaultId = ctx.params.vaultId!;
    // Guard first: this sends mail to real adjusters and SMEs.
    await requireVaultAccess(ctx, vaultId);

    const record = await store.get(vaultId);
    if (!record) throw new HttpError(404, "No Woodshed record for this session");

    const findings = record.findings;
    if (!findings || (findings.state !== "APPROVED" && findings.state !== "PUBLISHED")) {
      throw new HttpError(
        409,
        "Approve the Findings & Action Items before sending them. Action items from an " +
          "unapproved draft must not reach an adjuster or SME.",
      );
    }
    if (record.actionItems.length === 0) {
      throw new HttpError(409, "There are no action items to send");
    }

    const mailer = new Mailer(ctx.cfg);
    if (!mailer.enabled) {
      throw new HttpError(
        503,
        "Email is not configured on this deployment, so action items cannot be sent.",
      );
    }

    const results: { email: string; ok: boolean; error?: string; itemCount: number }[] = [];
    const issued = new Map<string, string>();

    for (const [email, items] of byOwner(record)) {
      const participant = record.participants.find((p) => p.email === email);
      const role = participant?.role ?? "SME";

      // Only SMEs get an upload link, and only for their summary item — the
      // token authorises exactly one upload against one item.
      let link: string | undefined;
      const summaryItem = items.find((i) => i.isSmeSummary);
      if (participant?.role === "SME" && summaryItem) {
        const token = await store.issueUploadToken({
          vaultId,
          actionItemId: summaryItem.id,
          ownerEmail: email,
          role,
          expiresAt: new Date(Date.now() + UPLOAD_TOKEN_DAYS * 86_400_000).toISOString(),
        });
        link = uploadUrl(ctx, token);
        issued.set(summaryItem.id, token);
      }

      const result = await mailer.actionItems({
        to: email,
        role,
        claimNumber: record.claimNumber,
        wsNumber: record.wsNumber,
        items: items.map((i) => ({ item: i.item, deadline: i.deadline })),
        uploadUrl: link,
      });

      results.push({
        email,
        ok: result.ok,
        error: result.error,
        itemCount: items.length,
      });
    }

    const delivered = new Set(results.filter((r) => r.ok).map((r) => r.email));

    const updated = await store.update(vaultId, (current) => {
      for (const item of current.actionItems) {
        // Only mark as sent what actually sent. A silently failed delivery
        // showing as "sent" is how an SME gets chased for something they never
        // received.
        if (item.status === "OPEN" && delivered.has(item.owner_email)) {
          item.status = "SENT";
        }
      }
      if (current.status === "IN_REVIEW" || current.status === "SUBMITTED") {
        current.status = "ACTIONED";
      }
      return current;
    });

    return json({
      woodshed: updated,
      results,
      sent: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    });
  });

  /** Resend one owner's items, for the "no reply" case. */
  router.post("/api/sessions/:vaultId/remind/:email", async (ctx) => {
    const { vaultId, email } = ctx.params as { vaultId: string; email: string };
    await requireVaultAccess(ctx, vaultId);

    const record = await store.get(vaultId);
    if (!record) throw new HttpError(404, "No Woodshed record for this session");

    const items = record.actionItems.filter(
      (i) => i.owner_email === email && i.status !== "RETURNED" && i.status !== "CLOSED",
    );
    if (items.length === 0) throw new HttpError(409, "This owner has no outstanding items");

    const today = new Date().toISOString().slice(0, 10);
    const result = await new Mailer(ctx.cfg).reminder({
      to: email,
      claimNumber: record.claimNumber,
      wsNumber: record.wsNumber,
      items: items.map((i) => ({
        item: i.item,
        deadline: i.deadline,
        overdue: i.deadline < today,
      })),
    });

    if (result.ok) {
      await store.update(vaultId, (current) => {
        for (const item of current.actionItems) {
          if (item.owner_email === email) item.lastReminderAt = new Date().toISOString();
        }
        return current;
      });
    }

    return json({ result });
  });

  // -------------------------------------------------------------------------
  // SME return channel — public, token-authenticated
  // -------------------------------------------------------------------------

  /** The landing page. Public: the SME has a link, not an account. */
  router.publicGet("/return/:token", async (ctx) => {
    const grant = await store.readUploadToken(ctx.params.token!);
    if (!grant) {
      return html(
        page(`
        <h1>This link is no longer valid</h1>
        <p>It may have already been used, or it may have expired. Please contact the
        auditor who sent it to you for a new one.</p>
      `),
        410,
      );
    }

    const record = await store.get(grant.vaultId);
    const item = record?.actionItems.find((i) => i.id === grant.actionItemId);

    if (grant.usedAt) {
      return html(page(`
        <h1>Already received</h1>
        <p>A summary was uploaded using this link on
        ${new Date(grant.usedAt).toLocaleDateString()}. Nothing further is needed.</p>
      `));
    }

    return html(page(`
      <h1>Upload your summary</h1>
      <p><strong>Claim ${record?.claimNumber ?? ""}</strong> &middot;
         Woodshed session ${record?.wsNumber ?? ""}</p>
      <p class="item">${item?.item ?? "Upload Final SME Summary (PDF format)"}</p>
      ${item ? `<p class="due">Due ${formatUsDate(item.deadline)}</p>` : ""}

      <form method="post" action="/return/${ctx.params.token}" enctype="multipart/form-data">
        <input type="file" name="file" accept=".pdf,application/pdf" required>
        <button type="submit">Upload</button>
      </form>
      <p class="note">PDF only. This link can be used once.</p>
    `));
  });

  /** The upload itself. */
  router.publicPost("/return/:token", async (ctx) => {
    const token = ctx.params.token!;

    // Read before consuming: a failed upload should not burn the SME's one use.
    const grant = await store.readUploadToken(token);
    if (!grant || grant.usedAt) {
      return html(page(`<h1>This link is no longer valid</h1>`), 410);
    }

    let file: File | null = null;
    try {
      const form = await ctx.request.formData();
      const entry = form.get("file");
      if (entry instanceof File) file = entry;
    } catch {
      return html(page(`<h1>Upload failed</h1><p>The form could not be read.</p>`), 400);
    }

    if (!file || file.size === 0) {
      return html(page(`<h1>No file received</h1><p>Please choose a PDF and try again.</p>`), 400);
    }

    const record = await store.get(grant.vaultId);
    if (!record) return html(page(`<h1>This Woodshed is no longer available</h1>`), 410);

    // Filing the document needs the machine credential — the SME has no account
    // and the auditor is not present. Without it, say so plainly rather than
    // accepting a file we cannot store.
    if (ctx.cfg.filedgr.authMode !== "apikey") {
      return html(
        page(`
        <h1>Uploads are not available yet</h1>
        <p>This deployment cannot file documents without an auditor present.
        Please email your summary to the auditor who contacted you.</p>
      `),
        503,
      );
    }

    try {
      const client = FiledgrClient.forServer(ctx.cfg);
      const stream = await client.findStream(grant.vaultId, FINDINGS_STREAM);
      if (!stream?.id) throw new Error("Correspondence stream is not available");

      const zip = await zipOne(file);
      const attachment = await client.uploadAttachment({
        streamId: stream.id,
        name: `SME summary - ${grant.ownerEmail}`,
        filename: `${file.name.replace(/\.[^.]+$/, "")}.zip`,
        bytes: zip,
        description: `Returned by ${grant.ownerEmail} (${grant.role})`,
      });

      await store.consumeUploadToken(token);
      await store.update(grant.vaultId, (current) => {
        const item = current.actionItems.find((i) => i.id === grant.actionItemId);
        if (item) {
          item.status = "RETURNED";
          item.returnedAttachmentId = attachment.id;
          item.returnedAt = new Date().toISOString();
        }
        return current;
      });

      // Notify every auditor on the roster. A returned summary nobody knows
      // about is not much better than one that never arrived.
      const mailer = new Mailer(ctx.cfg);
      for (const auditor of record.participants.filter((p) => p.role === "Auditor")) {
        await mailer.smeReturned({
          to: auditor.email,
          smeEmail: grant.ownerEmail,
          claimNumber: record.claimNumber,
          wsNumber: record.wsNumber,
          filename: file.name,
        });
      }

      return html(page(`
        <h1>Thank you</h1>
        <p>Your summary has been filed against claim
        <strong>${record.claimNumber}</strong> and the auditor has been notified.</p>
      `));
    } catch (error) {
      console.error("SME upload failed:", error);
      return html(
        page(`
        <h1>Upload failed</h1>
        <p>Your file could not be filed. Your link is still valid — please try again,
        or contact the auditor who sent it to you.</p>
      `),
        500,
      );
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// The deadline sweep
// ---------------------------------------------------------------------------

/**
 * Send reminders for everything due within `withinDays` or already past due.
 *
 * Reads the ordered deadline index rather than scanning every Woodshed, so the
 * cost is one range read regardless of how many sessions are open.
 *
 * Exported rather than inlined so it can be triggered manually and tested.
 */
export async function runDeadlineSweep(
  store: WoodshedStore,
  cfg: Config,
  { withinDays = 3, now = new Date() } = {},
): Promise<{ scanned: number; sent: number; skipped: number }> {
  const horizon = new Date(now.getTime() + withinDays * 86_400_000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  const due = await store.dueThrough(horizon);
  const mailer = new Mailer(cfg);
  if (!mailer.enabled) return { scanned: due.length, sent: 0, skipped: due.length };

  // One email per owner per Woodshed, not one per item.
  const grouped = new Map<string, { vaultId: string; itemIds: string[] }>();
  for (const entry of due) {
    const record = await store.get(entry.vaultId);
    const item = record?.actionItems.find((i) => i.id === entry.itemId);
    if (!record || !item || item.status === "RETURNED" || item.status === "CLOSED") continue;

    // At most one reminder per owner per day, so a sweep that runs twice does
    // not send twice.
    if (item.lastReminderAt?.slice(0, 10) === today) continue;

    const key = `${entry.vaultId}|${item.owner_email}`;
    const bucket = grouped.get(key) ?? { vaultId: entry.vaultId, itemIds: [] };
    bucket.itemIds.push(item.id);
    grouped.set(key, bucket);
  }

  let sent = 0;
  for (const [key, bucket] of grouped) {
    const email = key.split("|")[1]!;
    const record = await store.get(bucket.vaultId);
    if (!record) continue;

    const items = record.actionItems.filter((i) => bucket.itemIds.includes(i.id));
    const result = await mailer.reminder({
      to: email,
      claimNumber: record.claimNumber,
      wsNumber: record.wsNumber,
      items: items.map((i) => ({
        item: i.item,
        deadline: i.deadline,
        overdue: i.deadline < today,
      })),
    });

    if (result.ok) {
      sent++;
      await store.update(bucket.vaultId, (current) => {
        for (const item of current.actionItems) {
          if (bucket.itemIds.includes(item.id)) item.lastReminderAt = now.toISOString();
        }
        return current;
      });
    }
  }

  return { scanned: due.length, sent, skipped: due.length - sent };
}

// ---------------------------------------------------------------------------

async function zipOne(file: File): Promise<Uint8Array<ArrayBuffer>> {
  // Minimal stored-entry zip. A bare file would be stored with no usable mime
  // type, and pulling in a zip library for one uncompressed entry is not worth
  // the dependency.
  const { zipSync } = await import("npm:fflate@0.8.2");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const zipped = zipSync({ [file.name]: bytes }, { level: 0 });
  return new Uint8Array(zipped) as Uint8Array<ArrayBuffer>;
}

function page(inner: string): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Woodshed &middot; Upload your summary</title>
<style>
  :root{color-scheme:light}
  body{margin:0;padding:24px;background:#f8fafc;color:#111;
       font-family:-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.6}
  main{max-width:560px;margin:8vh auto;background:#fff;border-radius:16px;padding:36px}
  h1{font-size:20px;text-transform:uppercase;letter-spacing:1px;margin:0 0 16px}
  .item{background:#f1f5f9;border-radius:12px;padding:14px 16px;margin:20px 0}
  .due{color:#6b7280;font-size:14px}
  input[type=file]{display:block;margin:24px 0;width:100%}
  button{background:#6372ff;color:#fff;border:0;border-radius:999px;padding:12px 28px;
         font-size:15px;text-transform:uppercase;letter-spacing:1px;cursor:pointer}
  .note{font-size:13px;color:#6b7280;margin-top:20px}
</style></head><body><main>${inner}</main></body></html>`;
}
