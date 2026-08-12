/**
 * Deno KV persistence for Woodshed workflow state.
 *
 * What lives here: status, WS numbering, participants as {role, email}, action
 * items, deadlines, draft findings, SME upload tokens.
 *
 * What must NEVER live here (D19, the PHI boundary): document bytes, extracted
 * transcript text, claim summaries, or claimant PII. Documents stay in Filedgr;
 * text is fetched, sent to OpenAI, and discarded within the request.
 */

import type { WoodshedRecord, WsStatus } from "./domain/mod.ts";
import { canTransition, WS_SCHEMA_VERSION } from "./domain/mod.ts";

// ---------------------------------------------------------------------------
// Key schema
// ---------------------------------------------------------------------------

const KEYS = {
  /** The record itself, keyed by session vault id. */
  woodshed: (vaultId: string) => ["ws", "record", vaultId] as const,
  /** Secondary index so a claim's sessions can be listed without scanning. */
  byClaim: (claimVaultId: string, vaultId: string) =>
    ["ws", "byClaim", claimVaultId, vaultId] as const,
  byClaimPrefix: (claimVaultId: string) => ["ws", "byClaim", claimVaultId] as const,
  /** Atomic WS-number allocator, per claim. */
  wsCounter: (claimVaultId: string) => ["ws", "counter", claimVaultId] as const,
  /** SME upload tokens. Value is the grant; the token itself is the key. */
  uploadToken: (token: string) => ["ws", "token", token] as const,
  /** Deadline sweep index: one entry per open action item, ordered by due date. */
  deadline: (dueIso: string, vaultId: string, itemId: string) =>
    ["ws", "deadline", dueIso, vaultId, itemId] as const,
  deadlinePrefix: ["ws", "deadline"] as const,
} as const;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface UploadTokenGrant {
  vaultId: string;
  actionItemId: string;
  ownerEmail: string;
  role: string;
  /** ISO timestamp. A token past this is refused. */
  expiresAt: string;
  /** Set once used, so a leaked link cannot be replayed indefinitely. */
  usedAt?: string;
}

export class ConcurrencyError extends Error {
  constructor(vaultId: string) {
    super(
      `Woodshed ${vaultId} was modified concurrently. Re-read the record and retry the update.`,
    );
    this.name = "ConcurrencyError";
  }
}

export class WoodshedStore {
  constructor(private readonly kv: Deno.Kv) {}

  static async open(path?: string): Promise<WoodshedStore> {
    return new WoodshedStore(await Deno.openKv(path));
  }

  close(): void {
    this.kv.close();
  }

  // -------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------

  async get(vaultId: string): Promise<WoodshedRecord | null> {
    const entry = await this.kv.get<WoodshedRecord>(KEYS.woodshed(vaultId));
    if (!entry.value) return null;
    return migrate(entry.value);
  }

  async listByClaim(claimVaultId: string): Promise<WoodshedRecord[]> {
    const out: WoodshedRecord[] = [];
    for await (
      const entry of this.kv.list<string>({ prefix: KEYS.byClaimPrefix(claimVaultId) })
    ) {
      const record = await this.get(entry.value);
      if (record) out.push(record);
    }
    return out.sort((a, b) => a.wsNumber - b.wsNumber);
  }

  /** Create a record, failing if one already exists for that vault. */
  async create(record: WoodshedRecord): Promise<WoodshedRecord> {
    const result = await this.kv.atomic()
      .check({ key: KEYS.woodshed(record.vaultId), versionstamp: null })
      .set(KEYS.woodshed(record.vaultId), record)
      .set(KEYS.byClaim(record.claimVaultId, record.vaultId), record.vaultId)
      .commit();

    if (!result.ok) throw new ConcurrencyError(record.vaultId);
    return record;
  }

  /**
   * Read-modify-write under a versionstamp check.
   *
   * This is the concurrency guard the platform itself does not provide —
   * `PUT /vaults/{id}` is last-write-wins, so two auditors editing the same
   * Woodshed would silently lose one of the writes. Here they cannot.
   */
  async update(
    vaultId: string,
    mutate: (record: WoodshedRecord) => WoodshedRecord | Promise<WoodshedRecord>,
    attempts = 3,
  ): Promise<WoodshedRecord> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const entry = await this.kv.get<WoodshedRecord>(KEYS.woodshed(vaultId));
      if (!entry.value) throw new Error(`No Woodshed record for vault ${vaultId}`);

      const current = migrate(entry.value);
      const next = await mutate(structuredClone(current));

      next.revision = current.revision + 1;
      next.updatedAt = new Date().toISOString();

      const tx = this.kv.atomic()
        .check({ key: KEYS.woodshed(vaultId), versionstamp: entry.versionstamp })
        .set(KEYS.woodshed(vaultId), next);

      reindexDeadlines(tx, current, next);

      if ((await tx.commit()).ok) return next;
    }
    throw new ConcurrencyError(vaultId);
  }

  /** Apply a status transition, refusing moves the machine does not allow. */
  async transition(vaultId: string, to: WsStatus): Promise<WoodshedRecord> {
    return await this.update(vaultId, (record) => {
      if (record.status === to) return record;
      if (!canTransition(record.status, to)) {
        throw new Error(`Illegal Woodshed transition: ${record.status} → ${to}`);
      }
      record.status = to;
      return record;
    });
  }

  // -------------------------------------------------------------------------
  // WS numbering
  // -------------------------------------------------------------------------

  /**
   * Allocate the next WS number for a claim.
   *
   * `known` is what a live query of Filedgr returned, so a counter that has
   * fallen behind (a session created outside this server, or a KV reset) still
   * yields a number that does not collide. The counter only ever moves forward.
   */
  async allocateWsNumber(claimVaultId: string, known: number[] = []): Promise<number> {
    const floor = known.length ? Math.max(...known) : 0;

    // N concurrent callers all read the same versionstamp and only one commits,
    // so a burst of N needs up to N rounds. Retrying immediately just re-collides
    // the same losers, hence the jittered backoff.
    const attempts = 25;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const entry = await this.kv.get<Deno.KvU64>(KEYS.wsCounter(claimVaultId));
      const current = Number(entry.value?.value ?? 0n);
      const next = Math.max(current, floor) + 1;

      const result = await this.kv.atomic()
        .check({ key: KEYS.wsCounter(claimVaultId), versionstamp: entry.versionstamp })
        .set(KEYS.wsCounter(claimVaultId), new Deno.KvU64(BigInt(next)))
        .commit();

      if (result.ok) return next;

      const backoffMs = Math.min(2 ** attempt, 50) * (0.5 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
    throw new Error(
      `Could not allocate a WS number for claim ${claimVaultId} after ${attempts} attempts`,
    );
  }

  // -------------------------------------------------------------------------
  // SME upload tokens
  // -------------------------------------------------------------------------

  async issueUploadToken(grant: Omit<UploadTokenGrant, "usedAt">): Promise<string> {
    const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    await this.kv.set(KEYS.uploadToken(token), grant, {
      expireIn: expiryMs(grant.expiresAt),
    });
    return token;
  }

  async readUploadToken(token: string): Promise<UploadTokenGrant | null> {
    const entry = await this.kv.get<UploadTokenGrant>(KEYS.uploadToken(token));
    if (!entry.value) return null;
    if (Date.parse(entry.value.expiresAt) <= Date.now()) return null;
    return entry.value;
  }

  /** Single-use consume. Returns null if already used or expired. */
  async consumeUploadToken(token: string): Promise<UploadTokenGrant | null> {
    const entry = await this.kv.get<UploadTokenGrant>(KEYS.uploadToken(token));
    const grant = entry.value;
    if (!grant || grant.usedAt || Date.parse(grant.expiresAt) <= Date.now()) return null;

    const result = await this.kv.atomic()
      .check({ key: KEYS.uploadToken(token), versionstamp: entry.versionstamp })
      .set(KEYS.uploadToken(token), { ...grant, usedAt: new Date().toISOString() }, {
        expireIn: expiryMs(grant.expiresAt),
      })
      .commit();

    return result.ok ? grant : null;
  }

  // -------------------------------------------------------------------------
  // Deadline sweep
  // -------------------------------------------------------------------------

  /**
   * Every open action item due on or before `throughIso`.
   *
   * Reads the ordered secondary index rather than scanning every Woodshed, so
   * the daily sweep costs one range read regardless of how many are open.
   */
  async dueThrough(throughIso: string): Promise<{ vaultId: string; itemId: string }[]> {
    const out: { vaultId: string; itemId: string }[] = [];
    for await (
      const entry of this.kv.list<{ vaultId: string; itemId: string }>({
        start: [...KEYS.deadlinePrefix, ""],
        end: [...KEYS.deadlinePrefix, throughIso + "￿"],
      })
    ) {
      out.push(entry.value);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function expiryMs(expiresAt: string): number {
  // KV rejects a non-positive TTL; clamp so an already-expired grant still
  // writes and is then rejected on read by the explicit expiry check.
  return Math.max(1000, Date.parse(expiresAt) - Date.now());
}

/**
 * Keep the deadline index in step with the record inside the same atomic
 * commit, so an item can never be both open and missing from the sweep.
 */
function reindexDeadlines(
  tx: Deno.AtomicOperation,
  before: WoodshedRecord,
  after: WoodshedRecord,
): void {
  const isSweepable = (status: string) => status === "OPEN" || status === "SENT";

  for (const item of before.actionItems) {
    if (isSweepable(item.status)) {
      tx.delete(KEYS.deadline(item.deadline, before.vaultId, item.id));
    }
  }
  for (const item of after.actionItems) {
    if (isSweepable(item.status)) {
      tx.set(KEYS.deadline(item.deadline, after.vaultId, item.id), {
        vaultId: after.vaultId,
        itemId: item.id,
      });
    }
  }
}

/**
 * Forward-migrate a stored record. Today there is one schema version, but the
 * hook exists from the first commit so a v1 record is never silently read as v2.
 */
function migrate(record: WoodshedRecord): WoodshedRecord {
  if (record.schema === WS_SCHEMA_VERSION) return record;
  throw new Error(
    `Woodshed record for vault ${record.vaultId} has schema ${record.schema}, ` +
      `this server understands ${WS_SCHEMA_VERSION}.`,
  );
}
