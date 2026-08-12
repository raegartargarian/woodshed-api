/**
 * Runtime configuration, read once at boot from the environment.
 *
 * On Deno Deploy these are project environment variables. Locally, export them
 * or use a `.env` file with `deno run --env-file`.
 */

export type FiledgrAuthMode = "apikey" | "jwt";

export interface Config {
  /** Deployment stage. */
  stage: "dev" | "test" | "prod";

  filedgr: {
    /**
     * How the server authenticates to Filedgr.
     *
     * `apikey` targets the partner API (`api.<stage>.filedgr.network`), which is
     * the only surface that accepts `x-api-key`/`x-api-secret`. The webapp API's
     * authorizer verifies a JWT and raises `Unauthorized` for anything else, so
     * `jwt` mode relays the caller's own token and cannot run unattended.
     */
    authMode: FiledgrAuthMode;
    /** Partner API base, used in apikey mode. */
    apiBaseUrl: string;
    /** Webapp API base, used in jwt mode and for relayed calls. */
    webappBaseUrl: string;
    apiKey: string;
    apiSecret: string;
    /** Template ids identifying each hierarchy level. */
    rootTemplateId: string;
    claimTemplateId: string;
    sessionTemplateId: string;
    /** Ledger new attachments are minted on. */
    ledger: string;
  };

  openai: {
    apiKey: string;
    /** Long-horizon synthesis: overview prose, findings, action items. */
    frontierModel: string;
    /** Tabular mapping: attendance report → participants. */
    cheapModel: string;
    /** Refuse a run whose prompt exceeds this, so a mis-wired input can't run away. */
    maxInputTokens: number;
  };

  email: {
    enabled: boolean;
    apiKey: string;
    from: string;
    replyTo: string;
  };

  /** Public origin of this server, used to build SME upload links. */
  publicBaseUrl: string;
  /** Origins allowed to call this server from a browser. */
  allowedOrigins: string[];
  /** Shared secret the SPA presents. Distinct from the Filedgr credentials. */
  sessionSecret: string;
}

function env(key: string, fallback?: string): string {
  const value = Deno.env.get(key) ?? fallback;
  if (value === undefined) {
    throw new Error(
      `Missing required environment variable ${key}. See server/README.md for the full list.`,
    );
  }
  return value;
}

function optional(key: string, fallback = ""): string {
  return Deno.env.get(key) ?? fallback;
}

function int(key: string, fallback: number): number {
  const raw = Deno.env.get(key);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${key} is not a number: ${raw}`);
  return n;
}

function list(key: string, fallback: string[]): string[] {
  const raw = Deno.env.get(key);
  if (!raw) return fallback;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  const stage = optional("WS_STAGE", "dev") as Config["stage"];
  const stagePrefix = stage === "prod" ? "" : `${stage}.`;
  const authMode = optional("FILEDGR_AUTH_MODE", "apikey") as FiledgrAuthMode;

  cached = {
    stage,
    filedgr: {
      authMode,
      apiBaseUrl: optional("FILEDGR_API_URL", `https://api.${stagePrefix}filedgr.network`),
      webappBaseUrl: optional(
        "FILEDGR_WEBAPP_API_URL",
        `https://webapp-api.${stagePrefix}filedgr.network`,
      ),
      // Only required in apikey mode, so the server can still boot for local UI
      // work before the bot credential has been provisioned.
      apiKey: authMode === "apikey" ? env("FILEDGR_API_KEY") : optional("FILEDGR_API_KEY"),
      apiSecret: authMode === "apikey" ? env("FILEDGR_API_SECRET") : optional("FILEDGR_API_SECRET"),
      rootTemplateId: env("WS_ROOT_TEMPLATE_ID"),
      claimTemplateId: env("WS_CLAIM_TEMPLATE_ID"),
      sessionTemplateId: env("WS_SESSION_TEMPLATE_ID"),
      ledger: optional("FILEDGR_LEDGER", "POLYGON_ZKEVM"),
    },
    openai: {
      apiKey: env("OPENAI_API_KEY"),
      frontierModel: optional("OPENAI_FRONTIER_MODEL", "gpt-5"),
      cheapModel: optional("OPENAI_CHEAP_MODEL", "gpt-5-mini"),
      maxInputTokens: int("OPENAI_MAX_INPUT_TOKENS", 120_000),
    },
    email: {
      enabled: optional("RESEND_API_KEY") !== "",
      apiKey: optional("RESEND_API_KEY"),
      from: optional("WS_EMAIL_FROM", "Woodshed <woodshed@mail.example.com>"),
      replyTo: optional("WS_EMAIL_REPLY_TO", "auditor@example.com"),
    },
    publicBaseUrl: optional("WS_PUBLIC_BASE_URL", "http://localhost:8000"),
    allowedOrigins: list("WS_ALLOWED_ORIGINS", [
      "http://localhost:5173",
      "https://app.example.com",
    ]),
    sessionSecret: env("WS_SESSION_SECRET"),
  };

  return cached;
}

/** Test seam — lets a suite install a config without touching the environment. */
export function setConfigForTesting(config: Config | null): void {
  cached = config;
}
