/**
 * The Client → Claim → Session tree, reconstructed from Filedgr alone.
 *
 * Filedgr has no parent/child relationship on vaults or templates, and
 * `json_payload` is unwritable. What it does have is exactly enough:
 *
 *   - `template_id` is a repeatable filter, so each level gets its own template
 *     and one query returns every vault at that level.
 *   - `search_term` substring-matches name OR description, and `description` is
 *     writable via `PUT /vaults/{id}`.
 *
 * Together those give a one-call child lookup with no backend change, and —
 * unlike a `json_payload` blob — a pointer an admin can repair by hand.
 */

import {
  childSearchTerm,
  parseWsTag,
  withWsTag,
  type WsLevel,
  type WsVaultTag,
} from "../domain/mod.ts";
import type { Config } from "../config.ts";
import type { FiledgrClient, VaultDto } from "./client.ts";

export interface WsNode {
  vaultId: string;
  name: string;
  level: WsLevel;
  tag: WsVaultTag;
  createdAt: string;
  archived: boolean;
  vault: VaultDto;
}

export class HierarchyService {
  constructor(
    private readonly client: FiledgrClient,
    private readonly cfg: Config,
  ) {}

  private templateFor(level: WsLevel): string {
    switch (level) {
      case "root":
        return this.cfg.filedgr.rootTemplateId;
      case "claim":
        return this.cfg.filedgr.claimTemplateId;
      case "session":
        return this.cfg.filedgr.sessionTemplateId;
    }
  }

  /**
   * Every vault at a level, with untagged ones dropped.
   *
   * The tag filter matters: the level templates may be reused for vaults created
   * outside this workflow, and an untagged vault has no place in the tree.
   */
  async listLevel(level: WsLevel, searchTerm?: string): Promise<WsNode[]> {
    const vaults = await this.client.listAllVaults({
      templateIds: [this.templateFor(level)],
      searchTerm,
    });
    return vaults.flatMap((vault) => toNode(vault, level) ?? []);
  }

  /** All client roots. */
  listRoots(): Promise<WsNode[]> {
    return this.listLevel("root");
  }

  /**
   * Children of a vault, in one call.
   *
   * `search_term` narrows server-side to descriptions containing
   * `parent:<id>`; the tag re-check then rejects a coincidental substring match,
   * since the server has no notion of what the term means.
   */
  async listChildren(parentVaultId: string, childLevel: WsLevel): Promise<WsNode[]> {
    const nodes = await this.listLevel(childLevel, childSearchTerm(parentVaultId));
    return nodes.filter((node) => node.tag.parent === parentVaultId);
  }

  listClaims(rootVaultId: string): Promise<WsNode[]> {
    return this.listChildren(rootVaultId, "claim");
  }

  async listSessions(claimVaultId: string): Promise<WsNode[]> {
    const sessions = await this.listChildren(claimVaultId, "session");
    return sessions.sort((a, b) => (a.tag.ws ?? 0) - (b.tag.ws ?? 0));
  }

  /**
   * Find claims by claim number across every client.
   *
   * Backs the deck's "live search by Claim # + WS#". Matches on the tag's claim
   * field rather than the vault name, so a renamed vault still resolves.
   */
  async searchClaims(claimNumber: string): Promise<WsNode[]> {
    const term = claimNumber.trim();
    if (!term) return [];
    const nodes = await this.listLevel("claim", term);
    return nodes.filter(
      (node) =>
        node.tag.claim?.includes(term) || node.name.toLowerCase().includes(term.toLowerCase()),
    );
  }

  /** WS numbers already taken on a claim, read live rather than trusted from KV. */
  async usedWsNumbers(claimVaultId: string): Promise<number[]> {
    const sessions = await this.listSessions(claimVaultId);
    return sessions.map((s) => s.tag.ws).filter((n): n is number => typeof n === "number");
  }

  async getNode(vaultId: string): Promise<WsNode | null> {
    const vault = await this.client.getVault(vaultId);
    const tag = parseWsTag(vault.description);
    if (!tag) return null;
    return toNode(vault, tag.level);
  }

  /** Resolve a session's full ancestry in one place, so callers never guess. */
  async resolveAncestry(
    sessionVaultId: string,
  ): Promise<{ session: WsNode; claim: WsNode; root: WsNode }> {
    const session = await this.getNode(sessionVaultId);
    if (!session || session.level !== "session") {
      throw new Error(`Vault ${sessionVaultId} is not a Woodshed session vault`);
    }
    if (!session.tag.parent) {
      throw new Error(`Session vault ${sessionVaultId} has no parent claim in its description`);
    }

    const claim = await this.getNode(session.tag.parent);
    if (!claim || claim.level !== "claim") {
      throw new Error(
        `Session ${sessionVaultId} points at ${session.tag.parent}, not a claim vault`,
      );
    }
    if (!claim.tag.parent) {
      throw new Error(`Claim vault ${claim.vaultId} has no parent client in its description`);
    }

    const root = await this.getNode(claim.tag.parent);
    if (!root || root.level !== "root") {
      throw new Error(`Claim ${claim.vaultId} points at ${claim.tag.parent}, not a client vault`);
    }

    return { session, claim, root };
  }

  /**
   * Write or repair a vault's tag, preserving any human prose in the description.
   *
   * Read-modify-write: `PUT /vaults/{id}` is last-write-wins, so the current
   * description is re-read immediately before the update rather than trusted
   * from a stale copy.
   */
  async setTag(vaultId: string, tag: WsVaultTag): Promise<VaultDto> {
    const current = await this.client.getVault(vaultId);
    return await this.client.updateVault(vaultId, {
      description: withWsTag(current.description, tag),
    });
  }
}

function toNode(vault: VaultDto, expectedLevel: WsLevel): WsNode | null {
  const tag = parseWsTag(vault.description);
  if (!tag || tag.level !== expectedLevel) return null;
  return {
    vaultId: vault.id,
    name: vault.name ?? "(unnamed)",
    level: tag.level,
    tag,
    createdAt: vault.created_at,
    archived: vault.archived,
    vault,
  };
}
