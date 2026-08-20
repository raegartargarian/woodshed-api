/**
 * Authorization.
 *
 * The `x-ws-session` header is NOT a security boundary. It ships inside the
 * frontend's JavaScript bundle, so anybody who opens devtools has it. It exists
 * only to keep casual scanners and other people's misconfigured apps off this
 * service.
 *
 * The real boundary is this: for every route scoped to a Woodshed, the caller
 * must prove — with their own Filedgr token — that the platform will let them
 * read that vault. The platform is the authority on who may see what, and
 * asking it is the only way to inherit that answer correctly.
 *
 * This matters most on the routes that spend money or send mail. Without it,
 * anyone holding the (public) session header could drive LLM generation or
 * email a claim's participants.
 */

import { FiledgrClient, FiledgrError } from "./client.ts";
import { HttpError, type RequestContext, requireCallerJwt } from "../http.ts";

/**
 * Confirm the caller may act on this Woodshed, and return a client bound to
 * their identity.
 *
 * Every mutation and every paid operation goes through here, so an action is
 * always attributable to a real person the platform has already authenticated.
 */
export async function requireVaultAccess(
  ctx: RequestContext,
  vaultId: string,
): Promise<FiledgrClient> {
  const client = FiledgrClient.forCaller(ctx.cfg, requireCallerJwt(ctx));

  try {
    await client.getVault(vaultId);
  } catch (error) {
    if (error instanceof FiledgrError) {
      // The platform answers 404 rather than 403 for a vault you may not see,
      // so vault existence never leaks. Preserve that here: both become the
      // same response, and neither confirms whether the vault exists.
      if (error.isNotFound || error.status === 401 || error.status === 403) {
        throw new HttpError(403, "You do not have access to this Woodshed");
      }
    }
    throw error;
  }

  return client;
}
