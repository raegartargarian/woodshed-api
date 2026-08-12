import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { HierarchyService } from "./hierarchy.ts";
import type { FiledgrClient, ListVaultsQuery, VaultDto } from "./client.ts";
import type { Config } from "../config.ts";
import { encodeWsTag } from "../domain/mod.ts";

const T_ROOT = "tpl-root";
const T_CLAIM = "tpl-claim";
const T_SESSION = "tpl-session";

const cfg = {
  filedgr: {
    rootTemplateId: T_ROOT,
    claimTemplateId: T_CLAIM,
    sessionTemplateId: T_SESSION,
  },
} as unknown as Config;

function vault(init: Partial<VaultDto> & { id: string }): VaultDto {
  return {
    name: init.id,
    description: null,
    template_id: T_SESSION,
    status: "FILEDGR_VAULT_COMPLETED",
    ledger: "POLYGON_ZKEVM",
    created_at: "2026-07-09T00:00:00.000Z",
    archived: false,
    streams: [],
    ...init,
  };
}

/**
 * Fake platform client.
 *
 * Reimplements the two API behaviours the hierarchy design depends on — the
 * repeatable `template_id` filter and the substring `search_term` over name OR
 * description — so the tree logic is exercised without live credentials. If the
 * real API ever stops matching descriptions, these tests still pass and the
 * integration breaks; that risk is called out in the build doc.
 */
function fakeClient(vaults: VaultDto[]): FiledgrClient {
  const listAll = (query: ListVaultsQuery = {}) => {
    let out = vaults.filter((v) => !v.archived);
    if (query.templateIds?.length) {
      out = out.filter((v) => query.templateIds!.includes(v.template_id));
    }
    if (query.searchTerm) {
      const term = query.searchTerm.toLowerCase();
      out = out.filter(
        (v) =>
          (v.name ?? "").toLowerCase().includes(term) ||
          (v.description ?? "").toLowerCase().includes(term),
      );
    }
    return Promise.resolve(out);
  };

  return {
    listAllVaults: listAll,
    getVault: (id: string) => {
      const found = vaults.find((v) => v.id === id);
      if (!found) return Promise.reject(new Error(`no vault ${id}`));
      return Promise.resolve(found);
    },
  } as unknown as FiledgrClient;
}

/** A complete, well-formed tree: one client, two claims, three sessions. */
function tree(): VaultDto[] {
  return [
    vault({
      id: "root-1",
      name: "Example District",
      template_id: T_ROOT,
      description: encodeWsTag({ level: "root" }),
    }),
    vault({
      id: "claim-1",
      name: "10000001",
      template_id: T_CLAIM,
      description: encodeWsTag({ level: "claim", parent: "root-1", claim: "10000001" }),
    }),
    vault({
      id: "claim-2",
      name: "10000002",
      template_id: T_CLAIM,
      description: encodeWsTag({ level: "claim", parent: "root-1", claim: "10000002" }),
    }),
    vault({
      id: "sess-1b",
      name: "10000001 - WS2",
      description: encodeWsTag({
        level: "session",
        parent: "claim-1",
        claim: "10000001",
        ws: 2,
      }),
    }),
    vault({
      id: "sess-1a",
      name: "10000001 - WS1",
      description: encodeWsTag({
        level: "session",
        parent: "claim-1",
        claim: "10000001",
        ws: 1,
      }),
    }),
    vault({
      id: "sess-2a",
      name: "10000002 - WS1",
      description: encodeWsTag({
        level: "session",
        parent: "claim-2",
        claim: "10000002",
        ws: 1,
      }),
    }),
  ];
}

const svc = (vaults: VaultDto[]) => new HierarchyService(fakeClient(vaults), cfg);

Deno.test("roots are listed from the root template", async () => {
  const roots = await svc(tree()).listRoots();
  assertEquals(roots.map((r) => r.vaultId), ["root-1"]);
  assertEquals(roots[0]?.level, "root");
});

Deno.test("claims are scoped to their parent client", async () => {
  const claims = await svc(tree()).listClaims("root-1");
  assertEquals(claims.map((c) => c.vaultId).sort(), ["claim-1", "claim-2"]);
});

Deno.test("sessions are scoped to their parent claim and ordered by WS number", async () => {
  const sessions = await svc(tree()).listSessions("claim-1");
  // sess-1b (WS2) is listed before sess-1a (WS1) in the raw data.
  assertEquals(sessions.map((s) => s.vaultId), ["sess-1a", "sess-1b"]);
  assertEquals(sessions.map((s) => s.tag.ws), [1, 2]);
});

Deno.test("a sibling claim's sessions never leak into another claim", async () => {
  const sessions = await svc(tree()).listSessions("claim-2");
  assertEquals(sessions.map((s) => s.vaultId), ["sess-2a"]);
});

Deno.test("used WS numbers are read from what actually exists", async () => {
  assertEquals(await svc(tree()).usedWsNumbers("claim-1"), [1, 2]);
  assertEquals(await svc(tree()).usedWsNumbers("claim-2"), [1]);
});

Deno.test("untagged vaults on a Woodshed template are ignored", async () => {
  // A vault created from the session template but never tagged has no place in
  // the tree — including it would produce a session with no parent.
  const vaults = tree();
  vaults.push(vault({ id: "stray", name: "Ad-hoc vault", description: "just a note" }));

  const sessions = await svc(vaults).listSessions("claim-1");
  assertEquals(sessions.map((s) => s.vaultId), ["sess-1a", "sess-1b"]);
});

Deno.test("a coincidental substring match is rejected by the tag re-check", async () => {
  // The server has no idea what "parent:claim-1" means, so a vault that merely
  // mentions it in prose would come back from the search. The tag must decide.
  const vaults = tree();
  vaults.push(
    vault({
      id: "decoy",
      name: "Notes",
      description: "See parent:claim-1 for background. " + encodeWsTag({
        level: "session",
        parent: "claim-9",
        ws: 1,
      }),
    }),
  );

  const sessions = await svc(vaults).listSessions("claim-1");
  assertEquals(sessions.map((s) => s.vaultId), ["sess-1a", "sess-1b"]);
});

Deno.test("archived vaults are excluded", async () => {
  const vaults = tree();
  vaults.push(
    vault({
      id: "sess-1c",
      name: "10000001 - WS3",
      archived: true,
      description: encodeWsTag({ level: "session", parent: "claim-1", ws: 3 }),
    }),
  );
  assertEquals(await svc(vaults).usedWsNumbers("claim-1"), [1, 2]);
});

Deno.test("claim search matches the claim number", async () => {
  const hits = await svc(tree()).searchClaims("10000001");
  assertEquals(hits.map((c) => c.vaultId), ["claim-1"]);
});

Deno.test("claim search ignores a term that is too short to be meaningful", async () => {
  assertEquals(await svc(tree()).searchClaims(""), []);
  assertEquals(await svc(tree()).searchClaims("   "), []);
});

Deno.test("ancestry resolves a session to its claim and client", async () => {
  const { session, claim, root } = await svc(tree()).resolveAncestry("sess-1a");
  assertEquals(session.vaultId, "sess-1a");
  assertEquals(claim.vaultId, "claim-1");
  assertEquals(root.vaultId, "root-1");
});

Deno.test("ancestry refuses a vault that is not a session", async () => {
  await assertRejects(() => svc(tree()).resolveAncestry("claim-1"));
});

Deno.test("ancestry reports a broken parent pointer instead of guessing", async () => {
  // A mis-parented session is a real possibility — the pointer is hand-editable
  // in the dashboard. It must fail loudly, not silently attach to the wrong claim.
  const vaults = tree();
  vaults.push(
    vault({
      id: "orphan",
      name: "10000003 - WS1",
      description: encodeWsTag({ level: "session", parent: "claim-missing", ws: 1 }),
    }),
  );
  await assertRejects(() => svc(vaults).resolveAncestry("orphan"));
});

Deno.test("ancestry rejects a session whose parent is not a claim", async () => {
  const vaults = tree();
  vaults.push(
    vault({
      id: "misparented",
      name: "10000004 - WS1",
      // Points straight at the client, skipping the claim level.
      description: encodeWsTag({ level: "session", parent: "root-1", ws: 1 }),
    }),
  );
  await assertRejects(() => svc(vaults).resolveAncestry("misparented"));
});

Deno.test("getNode returns null for a vault outside the hierarchy", async () => {
  const vaults = tree();
  vaults.push(vault({ id: "plain", name: "Unrelated", description: null }));
  assertEquals(await svc(vaults).getNode("plain"), null);
});
