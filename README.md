# Woodshed API

Backend service for the Woodshed claim-review workflow: hierarchy navigation, session numbering,
AI-assisted document drafting, action-item distribution and deadline reminders.

Runs on Deno. Deploys to Deno Deploy — KV and Cron are built in, so there is no database or
scheduler to host separately.

```
main.ts            entry point + route registration
config.ts          environment, read once at boot
http.ts            router, CORS, session auth, error mapping
kv.ts              Deno KV store — the live system of record
domain/mod.ts      shared domain model, published to JSR
filedgr/
  client.ts        API client for the document platform
  hierarchy.ts     Client → Claim → Session tree
routes/
  hierarchy.ts     tree browsing + session numbering
```

## Running locally

```sh
deno task dev      # watch mode on :8000
deno task test     # 49 tests
deno task check    # typecheck + lint + fmt
```

## Deploying

Point a Deno Deploy project at this repository with `main.ts` as the entry point and set the
environment variables below. Nothing else is required — KV and Cron are provisioned automatically.

## Environment

| Variable                  | Required       | Default                     | Notes                                                                                                                                       |
| ------------------------- | -------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `WS_APP_KEY`              | **yes**        |                             | Public key the web app presents as `x-ws-app-key`. Ships in the frontend bundle, so it is NOT a secret — it only keeps drive-by traffic out |
| `WS_STAGE`                |                | `dev`                       | `dev` \| `test` \| `prod` — selects default API hosts                                                                                       |
| `WS_PUBLIC_BASE_URL`      |                | `http://localhost:8000`     | Public origin, used to build SME upload links                                                                                               |
| `WS_ALLOWED_ORIGINS`      |                | `http://localhost:5173`     | Comma-separated CORS allowlist                                                                                                              |
| `FILEDGR_AUTH_MODE`       |                | `apikey`                    | `apikey` for unattended work; `jwt` relays the caller's own token                                                                           |
| `FILEDGR_API_KEY`         | in apikey mode |                             | Machine credential, provisioned by the platform operator                                                                                    |
| `FILEDGR_API_SECRET`      | in apikey mode |                             |                                                                                                                                             |
| `FILEDGR_API_URL`         |                | derived from stage          | Machine API base                                                                                                                            |
| `FILEDGR_WEBAPP_API_URL`  |                | derived from stage          | Web API base, used in jwt mode                                                                                                              |
| `FILEDGR_LEDGER`          |                | `POLYGON_ZKEVM`             | Ledger new attachments mint on                                                                                                              |
| `WS_ROOT_TEMPLATE_ID`     | **yes**        |                             | Template identifying client vaults                                                                                                          |
| `WS_CLAIM_TEMPLATE_ID`    | **yes**        |                             | Template identifying claim vaults                                                                                                           |
| `WS_SESSION_TEMPLATE_ID`  | **yes**        |                             | Template identifying session vaults; carries the seven required streams                                                                     |
| `OPENAI_API_KEY`          | **yes**        |                             |                                                                                                                                             |
| `OPENAI_FRONTIER_MODEL`   |                | `gpt-5`                     | Prose synthesis, findings, action items                                                                                                     |
| `OPENAI_CHEAP_MODEL`      |                | `gpt-5-mini`                | Tabular extraction                                                                                                                          |
| `OPENAI_MAX_INPUT_TOKENS` |                | `120000`                    | Hard ceiling — a run above it is refused rather than billed                                                                                 |
| `RESEND_API_KEY`          |                |                             | Absent disables email entirely                                                                                                              |
| `WS_EMAIL_FROM`           |                | `woodshed@mail.example.com` | Must be a verified sending domain                                                                                                           |
| `WS_EMAIL_REPLY_TO`       |                |                             |                                                                                                                                             |

## Authentication

Two modes, chosen with `FILEDGR_AUTH_MODE`:

- **`apikey`** — a long-lived machine credential against the platform's machine API. Required for
  anything unattended: scheduled reminders, inbound SME uploads, webhook processing. The credential
  is provisioned by the platform operator; it cannot be self-served.
- **`jwt`** — relays the calling user's own token. Attended requests only. The platform issues no
  refresh grant, so a stored token eventually expires and background work silently starts failing
  with 401s.

Callers must also present `WS_APP_KEY` as an `x-ws-session` header on every non-public route.

## Data handling

This service stores workflow state only: session status and numbering, participants as
`{role, email}`, action items, deadlines, draft findings, and single-use upload tokens.

It does **not** store document bytes, extracted document text, or claimant personal data. Documents
remain in the document platform; text is fetched, used within the request that needs it, and
discarded.

## Domain package

`domain/mod.ts` is published to JSR as `@3rdstage/woodshed-domain` so the web app and this service
share one definition of the model — roles, status machine, deadline arithmetic, hierarchy encoding,
controlled vocabulary and currency formatting.

```sh
deno task publish:dry   # validate before publishing
deno publish
```

Consumers install it with `npx jsr add @3rdstage/woodshed-domain`.
