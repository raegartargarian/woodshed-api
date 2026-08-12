import { assertEquals } from "jsr:@std/assert@1";
import { FiledgrClient, FiledgrError } from "./client.ts";

/**
 * Access granting, including the invite-on-404 fallback.
 *
 * The platform answers 404 rather than 403 when a permission target has no
 * account, so the same status code means both "no such user" and "no such
 * vault". The fallback therefore has to be correct about which calls it makes
 * and in what order — these tests pin that down by recording the calls.
 */

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function clientWith(
  handler: (call: Call) => unknown,
): { client: FiledgrClient; calls: Call[] } {
  const calls: Call[] = [];

  const auth = {
    baseUrl: "https://api.example.test",
    headers: () => ({ "x-api-key": "k", "x-api-secret": "s" }),
  };
  const client = new FiledgrClient(auth, "POLYGON_ZKEVM");

  // Swap the private transport. Cheaper and more precise than a fetch stub:
  // the assertions are about which endpoint is called with what, not about HTTP.
  // deno-lint-ignore no-explicit-any
  (client as any).request = (method: string, path: string, init: { body?: unknown } = {}) => {
    const call: Call = { method, path, body: init.body };
    calls.push(call);
    const result = handler(call);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  };

  return { client, calls };
}

const notFound = (path: string) => new FiledgrError(404, "POST", path, "not found");

Deno.test("a grant to an existing user succeeds without sending an invitation", async () => {
  const { client, calls } = clientWith(() => ({}));

  const result = await client.grantVaultAccess({
    vaultId: "vault-1",
    email: "sme@example.com",
    type: "EDITOR",
    inviterUserId: "user-1",
  });

  assertEquals(result.status, "granted");
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.path, "/vaults/vault-1/permissions");
});

Deno.test("the permission payload carries the email as an EMAIL credential", async () => {
  const { client, calls } = clientWith(() => ({}));

  await client.grantVaultAccess({
    vaultId: "vault-1",
    email: "sme@example.com",
    type: "EDITOR",
  });

  assertEquals(calls[0]?.body, {
    credentials_key: "sme@example.com",
    credentials_type: "EMAIL",
    vault_id: "vault-1",
    type: "EDITOR",
    action: "ADD",
    network: "POLYGON_ZKEVM",
  });
});

Deno.test("a 404 falls back to exactly one invitation carrying the grant", async () => {
  const { client, calls } = clientWith((call) =>
    call.path.endsWith("/permissions") ? notFound(call.path) : {}
  );

  const result = await client.grantVaultAccess({
    vaultId: "vault-1",
    email: "newcomer@example.com",
    type: "EDITOR",
    inviterUserId: "user-1",
  });

  assertEquals(result.status, "invited");
  assertEquals(calls.length, 2);
  assertEquals(calls[1]?.path, "/users/user-1/invitations");

  // Exactly one invitation, never two: where an address has more than one
  // pending invitation the platform applies only the first one's grant.
  assertEquals(calls.filter((c) => c.path.includes("/invitations")).length, 1);

  // `invite_to` must be a JSON *string*, not an object — it is parsed on accept.
  const body = calls[1]?.body as { send_email_to: string; invite_to: string };
  assertEquals(body.send_email_to, "newcomer@example.com");
  assertEquals(typeof body.invite_to, "string");
  assertEquals(JSON.parse(body.invite_to).vault_id, "vault-1");
  assertEquals(JSON.parse(body.invite_to).type, "EDITOR");
});

Deno.test("a 404 with no inviter reports failure instead of silently doing nothing", async () => {
  const { client, calls } = clientWith((call) =>
    call.path.endsWith("/permissions") ? notFound(call.path) : {}
  );

  const result = await client.grantVaultAccess({
    vaultId: "vault-1",
    email: "newcomer@example.com",
    type: "EDITOR",
  });

  assertEquals(result.status, "failed");
  assertEquals(calls.length, 1);
});

Deno.test("a failed invitation is reported, not reported as a grant", async () => {
  // 400 here means the invitee already has an account — which contradicts the
  // 404 above. Claiming success would leave a participant with no access.
  const { client } = clientWith((call) => {
    if (call.path.endsWith("/permissions")) return notFound(call.path);
    return new FiledgrError(400, "POST", call.path, "already has an account");
  });

  const result = await client.grantVaultAccess({
    vaultId: "vault-1",
    email: "returning@example.com",
    type: "EDITOR",
    inviterUserId: "user-1",
  });

  assertEquals(result.status, "failed");
  assertEquals(result.message?.includes("400"), true);
});

Deno.test("a non-404 error does not trigger an invitation", async () => {
  const { client, calls } = clientWith((call) =>
    new FiledgrError(500, "POST", call.path, "upstream exploded")
  );

  const result = await client.grantVaultAccess({
    vaultId: "vault-1",
    email: "sme@example.com",
    type: "EDITOR",
    inviterUserId: "user-1",
  });

  assertEquals(result.status, "failed");
  assertEquals(calls.length, 1);
});

Deno.test("FiledgrError classifies the statuses the caller branches on", () => {
  assertEquals(new FiledgrError(404, "GET", "/x", "").isNotFound, true);
  assertEquals(new FiledgrError(402, "POST", "/x", "").isInsufficientCredits, true);
  assertEquals(new FiledgrError(500, "GET", "/x", "").isNotFound, false);
});

Deno.test("an empty attachment is refused before any request is made", async () => {
  const { client, calls } = clientWith(() => ({}));

  // estimated_size carries a greater-than-zero validator upstream; catching it
  // here turns a confusing 422 into a clear local failure.
  let threw = false;
  try {
    await client.uploadAttachment({
      streamId: "stream-1",
      name: "Empty",
      filename: "empty.zip",
      bytes: new Uint8Array(0),
    });
  } catch {
    threw = true;
  }

  assertEquals(threw, true);
  assertEquals(calls.length, 0);
});
