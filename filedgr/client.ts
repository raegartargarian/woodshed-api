/**
 * Filedgr API client.
 *
 * Every quirk encoded here was verified against the live API. The ones that will
 * bite you if you forget them:
 *
 *   - List endpoints return **204 No Content**, not 200 with an empty page.
 *   - `template_id` is a repeatable query param; `search_term` is a
 *     case-insensitive substring match on name OR description.
 *   - `json_payload` is accepted on create and silently dropped
 *     (the vault create path), and is absent from `UpdateVaultRequest`.
 *     `description` is the only writable free text on a vault.
 *   - The webapp API authorizes JWTs only; `x-api-key` works solely against the
 *     partner API.
 *   - Attachments are listed by `asset_code`, not by stream UUID.
 *   - Uploads are a 4-step dance and must always carry a zip, or the stored
 *     mimetype degrades to application/octet-stream.
 */

import type { Config } from "../config.ts";

// ---------------------------------------------------------------------------
// Wire types (subset — only what this server touches)
// ---------------------------------------------------------------------------

export interface VaultStreamDto {
  id: string;
  asset_code: string | null;
  description: string | null;
  status: string;
  mapping: string | null;
  ledger: string;
  tx_hash: string | null;
  created_at: string;
  archived?: boolean;
}

export interface VaultDto {
  id: string;
  name: string | null;
  description: string | null;
  template_id: string;
  status: string;
  ledger: string;
  created_at: string;
  archived: boolean;
  streams: VaultStreamDto[];
  json_payload?: string | null;
  config?: Record<string, unknown>;
  vault_permission_type?: string | null;
}

export interface FileDto {
  id: string;
  filename: string;
  mimetype: string;
  created_at: string;
  status: string;
  hash: string | null;
  size: number | null;
  cid: string | null;
}

export interface UploadPart {
  part: number;
  link?: string | null;
  etag?: string | null;
}

export interface DataAttachmentDto {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  status: string;
  stream_id: string;
  filename: string | null;
  size: number | null;
  file_count: number;
  files: FileDto[];
  presigned_urls?: UploadPart[] | null;
}

export interface Paginated<T> {
  total_records: number;
  current_page: number;
  total_pages: number;
  content: T[];
}

export interface ListVaultsQuery {
  templateIds?: string[];
  searchTerm?: string;
  archived?: boolean;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortType?: "ASC" | "DESC";
}

export type PermissionType = "OWNER" | "ADMIN" | "EDITOR" | "VIEWER" | "CUSTOM";

export interface GrantResult {
  status: "granted" | "invited" | "failed";
  email: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class FiledgrError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Filedgr ${method} ${path} → ${status}: ${body.slice(0, 300)}`);
    this.name = "FiledgrError";
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** 402 — the entity is out of credits, or has no active subscription. */
  get isInsufficientCredits(): boolean {
    return this.status === 402;
  }
}

// ---------------------------------------------------------------------------
// Auth strategies
// ---------------------------------------------------------------------------

export interface FiledgrAuth {
  baseUrl: string;
  headers(): Record<string, string>;
}

/** Partner API (`api.<stage>.filedgr.network`) — the only surface accepting keys. */
export function apiKeyAuth(cfg: Config): FiledgrAuth {
  if (!cfg.filedgr.apiKey || !cfg.filedgr.apiSecret) {
    throw new Error(
      "FILEDGR_AUTH_MODE=apikey but FILEDGR_API_KEY / FILEDGR_API_SECRET are unset. " +
        "Note that keys cannot be self-served: POST /credentials is rejected with 403 " +
        '("API keys cannot be created via this endpoint") and must be provisioned out of band.',
    );
  }
  return {
    baseUrl: cfg.filedgr.apiBaseUrl,
    headers: () => ({
      "x-api-key": cfg.filedgr.apiKey,
      "x-api-secret": cfg.filedgr.apiSecret,
    }),
  };
}

/**
 * Relayed caller JWT against the webapp API.
 *
 * Attended work only. There is no refresh grant anywhere in the platform, so a
 * background job holding one of these silently starts 401ing on expiry.
 */
export function jwtAuth(cfg: Config, token: string): FiledgrAuth {
  return {
    baseUrl: cfg.filedgr.webappBaseUrl,
    headers: () => ({ Authorization: `Bearer ${token}` }),
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class FiledgrClient {
  constructor(private readonly auth: FiledgrAuth, private readonly ledger: string) {}

  static forServer(cfg: Config): FiledgrClient {
    const auth = cfg.filedgr.authMode === "apikey" ? apiKeyAuth(cfg) : null;
    if (!auth) {
      throw new Error(
        "FiledgrClient.forServer requires apikey mode — unattended work cannot use a caller JWT.",
      );
    }
    return new FiledgrClient(auth, cfg.filedgr.ledger);
  }

  static forCaller(cfg: Config, jwt: string): FiledgrClient {
    return new FiledgrClient(jwtAuth(cfg, jwt), cfg.filedgr.ledger);
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    init: { query?: URLSearchParams; body?: unknown } = {},
  ): Promise<T | null> {
    const url = new URL(this.auth.baseUrl + path);
    if (init.query) url.search = init.query.toString();

    const headers: Record<string, string> = { ...this.auth.headers() };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.body);
    }

    const response = await fetch(url, { method, headers, body });

    // Filedgr list endpoints answer 204 rather than 200-with-empty-content.
    // Treating that as "no results" instead of an error is load-bearing.
    if (response.status === 204) return null;

    if (!response.ok) {
      throw new FiledgrError(response.status, method, path, await response.text());
    }

    const text = await response.text();
    return text ? JSON.parse(text) as T : null;
  }

  // -------------------------------------------------------------------------
  // Vaults
  // -------------------------------------------------------------------------

  async listVaults(query: ListVaultsQuery = {}): Promise<Paginated<VaultDto>> {
    const params = new URLSearchParams({
      page: String(query.page ?? 1),
      page_size: String(query.pageSize ?? 50),
      archived: String(query.archived ?? false),
    });
    if (query.searchTerm) params.set("search_term", query.searchTerm);
    if (query.sortBy) params.set("sort_by", query.sortBy);
    if (query.sortType) params.set("sort_type", query.sortType);
    // Repeatable — one entry per template id, not a comma-joined value.
    for (const id of query.templateIds ?? []) params.append("template_id", id);

    const page = await this.request<Paginated<VaultDto>>("GET", "/vaults", { query: params });
    return page ?? { total_records: 0, current_page: 1, total_pages: 0, content: [] };
  }

  /** Walk every page. Vault counts here are small; sessions per claim are single digits. */
  async listAllVaults(query: ListVaultsQuery = {}): Promise<VaultDto[]> {
    const out: VaultDto[] = [];
    let page = 1;
    for (;;) {
      const result = await this.listVaults({ ...query, page });
      out.push(...result.content);
      if (page >= result.total_pages || result.content.length === 0) break;
      page++;
    }
    return out;
  }

  /**
   * Create a vault.
   *
   * Verified against the live API with an ordinary user token — this needs no
   * admin rights and no dashboard. `config` is copied from the template, which
   * is what the platform's own dashboard does; sending values the template does
   * not support is rejected.
   */
  async createVault(input: {
    templateId: string;
    name: string;
    description: string;
    config?: Record<string, boolean>;
  }): Promise<VaultDto> {
    const vault = await this.request<VaultDto>("POST", "/vaults", {
      body: {
        template_id: input.templateId,
        name: input.name,
        description: input.description,
        ledger: this.ledger,
        config: input.config ?? {
          is_permissioned: true,
          is_searchable: true,
          is_ai_ready: false,
          is_dynamic_streams: false,
        },
      },
    });
    if (!vault) throw new Error("POST /vaults returned no content");
    return vault;
  }

  async getTemplate(templateId: string): Promise<{ config?: Record<string, boolean> }> {
    const template = await this.request<{ config?: Record<string, boolean> }>(
      "GET",
      `/templates/${templateId}`,
    );
    if (!template) throw new Error(`Template ${templateId} returned no content`);
    return template;
  }

  async getVault(vaultId: string): Promise<VaultDto> {
    const vault = await this.request<VaultDto>("GET", `/vaults/${vaultId}`);
    if (!vault) throw new Error(`Vault ${vaultId} returned no content`);
    return vault;
  }

  /**
   * Update a vault's writable fields.
   *
   * Last-write-wins server-side, so callers must read-modify-write and never
   * send a description they did not just read.
   */
  async updateVault(
    vaultId: string,
    patch: { name?: string; description?: string; archived?: boolean },
  ): Promise<VaultDto> {
    const vault = await this.request<VaultDto>("PUT", `/vaults/${vaultId}`, { body: patch });
    if (!vault) throw new Error(`Vault ${vaultId} update returned no content`);
    return vault;
  }

  // -------------------------------------------------------------------------
  // Streams
  //
  // There is no GET /vaults/{id}/streams on the webapp or partner API; streams
  // arrive embedded in the vault (the relationship is lazy="joined").
  // -------------------------------------------------------------------------

  async getStreams(vaultId: string): Promise<VaultStreamDto[]> {
    return (await this.getVault(vaultId)).streams ?? [];
  }

  async findStream(vaultId: string, mapping: string): Promise<VaultStreamDto | null> {
    const streams = await this.getStreams(vaultId);
    return streams.find((s) => s.mapping === mapping) ?? null;
  }

  // -------------------------------------------------------------------------
  // Attachments
  // -------------------------------------------------------------------------

  /**
   * Listed by `asset_code`, not stream UUID , which
   * means a stream must be minted before its attachments are listable at all.
   */
  async listStreamAttachments(
    assetCode: string,
    page = 1,
    pageSize = 50,
  ): Promise<Paginated<DataAttachmentDto>> {
    const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    const result = await this.request<Paginated<DataAttachmentDto>>(
      "GET",
      `/streams/${assetCode}/attachments`,
      { query },
    );
    return result ?? { total_records: 0, current_page: 1, total_pages: 0, content: [] };
  }

  async getAttachment(attachmentId: string): Promise<DataAttachmentDto> {
    const attachment = await this.request<DataAttachmentDto>("GET", `/attachments/${attachmentId}`);
    if (!attachment) throw new Error(`Attachment ${attachmentId} returned no content`);
    return attachment;
  }

  /**
   * Upload a document into a stream.
   *
   * Four steps, in this order, none skippable:
   *   1. POST /attachments            → row created, status FILEDGR_RECEIVED
   *   2. poll GET /attachments/{id}   → wait for FILEDGR_REVIEWED + presigned_urls
   *   3. PUT <presigned link>         → the bytes; capture the ETag
   *   4. PUT /attachments/{id}        → complete the multipart upload
   *
   * `bytes` must be a zip. A bare file is written to /tmp/{attachment_id} with
   * no extension, so mimetypes.guess_type finds nothing and everything lands as
   * application/octet-stream, which breaks preview downstream.
   */
  async uploadAttachment(input: {
    streamId: string;
    name: string;
    filename: string;
    /** Explicitly non-shared: a SharedArrayBuffer-backed view is not a valid body. */
    bytes: Uint8Array<ArrayBuffer>;
    description?: string;
  }): Promise<DataAttachmentDto> {
    if (input.bytes.byteLength === 0) {
      // estimated_size carries a `gt=0` validator; a zero-byte body 422s.
      throw new Error("Refusing to upload an empty attachment.");
    }

    const created = await this.request<DataAttachmentDto>("POST", "/attachments", {
      body: {
        name: input.name,
        description: input.description ?? null,
        stream_id: input.streamId,
        ledger: this.ledger,
        filename: input.filename,
        estimated_size: input.bytes.byteLength,
      },
    });
    if (!created) throw new Error("POST /attachments returned no content");

    const reviewed = await this.pollAttachment(created.id, "FILEDGR_REVIEWED");
    const parts = reviewed.presigned_urls ?? [];
    const first = parts[0];
    if (!first?.link) {
      throw new Error(`Attachment ${created.id} was reviewed without a presigned upload URL`);
    }

    // Single part: the multipart path only engages above 150 MiB, and every
    // Woodshed document is far below that.
    const put = await fetch(first.link, {
      method: "PUT",
      headers: { "Content-Type": "application/zip" },
      // Wrapped in a Blob rather than passed raw: a Uint8Array over a
      // SharedArrayBuffer is not a valid BodyInit, and the distinction is not
      // visible at the call site.
      body: new Blob([input.bytes]),
    });
    if (!put.ok) {
      throw new Error(`Presigned upload failed with ${put.status}: ${await put.text()}`);
    }
    const etag = put.headers.get("etag");

    await this.request("PUT", `/attachments/${created.id}`, {
      body: [{ part: first.part, etag }],
    });

    return await this.getAttachment(created.id);
  }

  private async pollAttachment(
    attachmentId: string,
    until: string,
    { attempts = 60, intervalMs = 3000 } = {},
  ): Promise<DataAttachmentDto> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const attachment = await this.getAttachment(attachmentId);
      if (attachment.status === until) return attachment;
      if (attachment.status === "ERROR") {
        throw new Error(`Attachment ${attachmentId} failed processing`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(
      `Attachment ${attachmentId} did not reach ${until} within ` +
        `${(attempts * intervalMs) / 1000}s`,
    );
  }

  // -------------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------------

  /**
   * Grant vault access, falling back to an invitation when the email has no
   * Filedgr account yet.
   *
   * A 404 from the permissions route means "no such user" — nft answers 404
   * rather than 403 throughout so vault existence never leaks. The invitation
   * carries the grant as a JSON string in `invite_to`, which is replayed when
   * the invitee accepts.
   *
   * Send exactly one invitation per email address. Where an address has more
   * than one pending invitation, only the first one's grant is applied.
   */
  async grantVaultAccess(input: {
    vaultId: string;
    email: string;
    type: PermissionType;
    /** Required for the invite fallback; the invitation is scoped to a user. */
    inviterUserId?: string;
  }): Promise<GrantResult> {
    const permission = {
      credentials_key: input.email,
      credentials_type: "EMAIL",
      vault_id: input.vaultId,
      type: input.type,
      action: "ADD",
      network: this.ledger,
    };

    try {
      await this.request("POST", `/vaults/${input.vaultId}/permissions`, { body: permission });
      return { status: "granted", email: input.email };
    } catch (error) {
      if (!(error instanceof FiledgrError) || !error.isNotFound) {
        return {
          status: "failed",
          email: input.email,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (!input.inviterUserId) {
        return {
          status: "failed",
          email: input.email,
          message: "No Filedgr account for this address, and no inviter to send an invitation as.",
        };
      }

      try {
        await this.request("POST", `/users/${input.inviterUserId}/invitations`, {
          body: {
            send_email_to: input.email,
            invite_to: JSON.stringify(permission),
          },
        });
        return { status: "invited", email: input.email };
      } catch (inviteError) {
        // 400 here means the invitee already has an account — which contradicts
        // the 404 above, and happens when a returning participant's credential
        // type differs. Surface it rather than pretending the grant worked.
        return {
          status: "failed",
          email: input.email,
          message: inviteError instanceof Error ? inviteError.message : String(inviteError),
        };
      }
    }
  }

  /**
   * The calling user.
   *
   * Needed because the invitation route is scoped to a user id
   * (`POST /users/{id}/invitations`) — an invite has to be sent *as* somebody,
   * and the caller is the only identity available in attended mode.
   */
  async getCurrentUser(): Promise<{ id: string; email: string | null }> {
    const user = await this.request<{
      id: string;
      credentials?: { type: string; key: string }[];
    }>("GET", "/users");
    if (!user?.id) throw new Error("GET /users returned no user");

    const email = user.credentials?.find((c) => c.type === "EMAIL")?.key ?? null;
    return { id: user.id, email };
  }

  async listVaultPermissions(vaultId: string): Promise<Paginated<Record<string, unknown>>> {
    const query = new URLSearchParams({ page: "1", page_size: "100" });
    const result = await this.request<Paginated<Record<string, unknown>>>(
      "GET",
      `/vaults/${vaultId}/permissions`,
      { query },
    );
    return result ?? { total_records: 0, current_page: 1, total_pages: 0, content: [] };
  }
}
