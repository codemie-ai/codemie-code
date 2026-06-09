# Local Claude Desktop Conversation Sync — Dev Setup

## Specification Summary

**Last Updated**: 2026-06-09

**Goal**: Route Claude Desktop conversation sync to a local backend (`localhost:8080`) instead of the production/preview environment, so developers can reproduce, debug, and fix bugs in conversation history storage without affecting shared environments.

**Key Decision**: Thread an `apiKey` from the CLI profile config through the proxy daemon chain, and send it as a `user-id` header to the backend, enabling the backend's dev-header authentication bypass (`ENV=local`).

---

## Overview

CodeMie CLI's `codemie proxy connect desktop` command starts a local proxy daemon that:
1. Intercepts Claude Desktop's LLM traffic and forwards it to the configured provider.
2. Polls Claude Desktop session files every 10 s, parses transcripts, and syncs conversation history to the CodeMie backend via `PUT /v1/conversations/{id}/history`.

By default, both the LLM traffic and the conversation sync go to the same backend URL (`baseUrl`). To debug locally, we want:
- **LLM traffic** → preview backend (keeps real model access)
- **Conversation sync** → `localhost:8080` (local backend for debugging)

### Architecture of the fix

```
Claude Desktop
    ↓ (LLM requests)
codemie proxy (port 4001)
    ↓ LLM → preview baseUrl
    ↓ sync → ssoConfig.apiUrl (localhost:8080) + user-id header (apiKey)
Local backend (uvicorn :8080)
    ↓ ENV=local → accepts user-id header
    ↓ aget_by_id(uuid) → finds existing user
PostgreSQL (docker compose)
```

---

## Prerequisites

Three repositories must be cloned and running:

| Repo | Role | Path (example) |
|------|------|----------------|
| `codemie-code` | CLI (this repo) | `~/WebstormProjects/codemie-code` |
| `codemie` | Backend (FastAPI/uvicorn) | `~/WebstormProjects/codemie` |
| `codemie-ui` | Frontend (optional for UI verification) | `~/WebstormProjects/codemie-ui` |

Claude Desktop (3P) must be installed and running on macOS.

---

## Step 1 — Backend setup (`codemie` repo)

### 1.1 Set `ENV=local` in `.env`

Open `codemie/.env` and ensure:

```env
ENV=local
IDP_PROVIDER=local
```

`ENV=local` activates the dev-header auth bypass in:
`src/codemie/rest_api/security/user_providers/persistent.py`

```python
if config.ENV == "local":
    dev_user_id = request.headers.get("user-id")
    if dev_user_id:
        return await authentication_service.authenticate_dev_header(dev_user_id)
```

Without `ENV=local` (e.g. `ENV=development`), the `user-id` header is silently ignored and all requests return **401**.

### 1.2 Start infrastructure

```bash
cd ~/WebstormProjects/codemie
docker compose up postgres elasticsearch -d
```

### 1.3 Port-forward preview Elasticsearch (for analytics queries)

```bash
KUBECONFIG=~/Downloads/kubeconfig kubectl port-forward \
  -n preview-elastic svc/elasticsearch-master 9200:9200
```

### 1.4 Start uvicorn

```bash
cd ~/WebstormProjects/codemie
poetry run uvicorn codemie.rest_api.main:app \
  --host=0.0.0.0 --port=8080 --reload
```

### 1.5 Find your user UUID

The `user-id` header must be the user's **UUID** (not email), because `authenticate_dev_header` looks up by the `id` column in the `users` table. There are three ways to find it:

**Option A — query local postgres (if user already exists):**

```bash
docker exec -it $(docker ps --filter "name=postgres" -q) \
  psql -U postgres -d postgres -c \
  "SELECT id, email FROM users WHERE email = 'your_email@epam.com';"
```

**Option B — call the local API after logging in via the UI:**

1. Open `http://localhost:3000` (codemie-ui).
2. Log in with your credentials.
3. Then call:

```bash
curl -s http://localhost:8080/v1/users/me \
  -H "Cookie: <paste cookie from browser DevTools>" | python3 -m json.tool | grep '"id"'
```

**Option C — from the preview environment (fastest):**

The UUID is the same across environments if the account was created from the same source. Call preview's `/v1/users/me`:

```bash
curl -s https://codemie-preview.lab.epam.com/v1/users/me \
  -H "Cookie: <paste cookie from browser after preview login>" | python3 -m json.tool | grep '"id"'
```

> **If no user exists locally at all:** create one directly in postgres with a known UUID, then use that UUID as `apiKey`:
>
> ```bash
> docker exec -it $(docker ps --filter "name=postgres" -q) \
>   psql -U postgres -d postgres -c "
> INSERT INTO users (id, date, update_date, username, email, name,
>                    user_type, is_active, is_admin, is_maintainer,
>                    auth_source, email_verified)
> VALUES (
>   gen_random_uuid(),
>   now(), now(),
>   'your_email@epam.com',
>   'your_email@epam.com',
>   'Your Name',
>   'regular', true, true, false,
>   'dev_header', true
> ) RETURNING id, email;
> "
> ```
>
> Copy the returned `id` UUID — use it as `apiKey` in Step 2.

Note the UUID — you will need it in Step 2.

---

## Step 2 — CLI config (`~/.codemie/codemie-cli.config.json`)

The global CLI config file is always at `~/.codemie/codemie-cli.config.json` (i.e. `$HOME/.codemie/codemie-cli.config.json`). Edit it directly:

```bash
# Verify the file exists
cat ~/.codemie/codemie-cli.config.json
```

Add the `local` profile to the `profiles` object and set `"activeProfile": "local"`. If the file already has other profiles, keep them — only add the `local` entry and change `activeProfile`.

Add a `local` profile and set it as active. The key fields:

| Field | Value | Purpose |
|-------|-------|---------|
| `codeMieUrl` | `http://localhost:8080` | CodeMie org URL (credential lookup key) |
| `ssoConfig.apiUrl` | `http://localhost:8080` | Conversation sync target |
| `baseUrl` | `https://codemie-preview.lab.epam.com/code-assistant-api` | LLM traffic (keep on preview) |
| `apiKey` | `<user UUID from Step 1.5>` (e.g. `a1b2c3d4-0000-0000-0000-000000000000`) | Sent as `user-id` header to local backend |
| `codeMieProject` | `your_email@epam.com` | Project name in local backend |

Example profile:

```json
{
  "version": 2,
  "activeProfile": "local",
  "profiles": {
    "local": {
      "provider": "ai-run-sso",
      "codeMieUrl": "http://localhost:8080",
      "codeMieProject": "your_email@epam.com",
      "apiKey": "<user-uuid-from-step-1.5>",
      "baseUrl": "https://codemie-preview.lab.epam.com/code-assistant-api",
      "ssoConfig": {
        "apiUrl": "http://localhost:8080"
      },
      "model": "claude-sonnet-4-6",
      "haikuModel": "claude-haiku-4-5-20251001",
      "sonnetModel": "claude-sonnet-4-6",
      "opusModel": "claude-opus-4-7",
      "name": "local"
    }
  }
}
```

> **Why UUID not email?** `authenticate_dev_header(user_id)` calls `aget_by_id(session, user_id)`. If you pass email, no user is found by ID, and the INSERT attempt fails with a unique constraint violation on the `email` column (user already exists). Passing the UUID finds the existing user directly.

---

## Step 3 — CLI build (`codemie-code` repo)

The `feat/proxy-api-key-auth` branch adds `apiKey` support. Ensure you are on it:

```bash
cd ~/WebstormProjects/codemie-code
git checkout feat/proxy-api-key-auth
npm install
npm run build
npm link
```

### What the branch changes

The `apiKey` field travels through this chain:

```
~/.codemie/codemie-cli.config.json  (apiKey: "<uuid>")
    ↓
src/cli/commands/proxy/index.ts     (reads config.apiKey, passes to spawnDaemon)
    ↓
src/cli/commands/proxy/daemon-manager.ts  (adds --api-key <uuid> to daemon args)
    ↓
src/bin/proxy-daemon.ts             (parses --api-key, puts in ProxyConfig)
    ↓
src/providers/plugins/sso/proxy/proxy-types.ts  (apiKey?: string in ProxyConfig)
    ↓
src/telemetry/runtime/DesktopTelemetryRuntime.ts  (buildProcessingContext → apiKey)
    ↓
src/telemetry/runtime/types.ts      (apiKey?: string in DesktopTelemetryRuntimeConfig)
    ↓
HTTP header: user-id: <uuid>  →  localhost:8080
```

`apiKey` is only forwarded when it differs from `'sso-provided'` (the default for normal SSO profiles), so existing SSO profiles are not affected.

---

## Step 4 — SSO login for LLM traffic

LLM traffic goes to preview, so you need valid SSO credentials for preview:

```bash
codemie profile login --url https://codemie-preview.lab.epam.com
```

Follow the browser flow. Credentials are stored in the system keychain keyed by the base URL.

---

## Step 5 — Connect Claude Desktop

```bash
codemie proxy connect desktop
```

Expected output:
```
Starting proxy...
Using profile: local
✓ Proxy started
✓ Claude Desktop configured
  Restart Claude Desktop to apply changes.
```

Restart Claude Desktop.

---

## Step 6 — Verify

Have a short conversation in Claude Desktop. Then check backend logs for:

```
PUT /v1/conversations/<id>/history HTTP/1.1" 201 Created
```

And log lines like:
```
Upserting conversation history for conversation_id=..., user_id=<uuid>, messages_in_request=N
Created new conversation <id> with N messages
```

If you still see `401 Unauthorized`, verify:
- `ENV=local` is set in `codemie/.env` (not `development`)
- `apiKey` in config is the UUID (not email)
- uvicorn was restarted after `.env` change
- CLI was rebuilt after branch checkout (`npm run build && npm link`)
- Proxy was restarted after config change (`codemie proxy stop && codemie proxy connect desktop`)

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `401` on all sync requests | `ENV` not `local` in backend | Change `.env`, restart uvicorn |
| `401` + `UniqueViolationError` on email | `apiKey` is email, not UUID | Use UUID from `SELECT id FROM users WHERE email=...` |
| `No SSO credentials found` | Not logged into preview | `codemie profile login --url https://codemie-preview.lab.epam.com` |
| Proxy sends to production not localhost | `ssoConfig.apiUrl` missing or wrong | Add `"ssoConfig": {"apiUrl": "http://localhost:8080"}` to profile |
| Daemon has old config | Proxy not restarted | `codemie proxy stop && codemie proxy connect desktop` |
| `user-id` header not sent | Old build without branch changes | `npm run build && npm link` from `feat/proxy-api-key-auth` |

---

## Key File Locations

| File | Purpose |
|------|---------|
| `~/.codemie/codemie-cli.config.json` | Global CLI config with profiles |
| `~/WebstormProjects/codemie/.env` | Backend environment (`ENV=local`) |
| `src/cli/commands/proxy/index.ts` | Reads apiKey from config, passes to daemon |
| `src/cli/commands/proxy/daemon-manager.ts` | Adds `--api-key` CLI arg to daemon process |
| `src/bin/proxy-daemon.ts` | Parses args, builds ProxyConfig |
| `src/telemetry/runtime/DesktopTelemetryRuntime.ts` | Puts apiKey into ProcessingContext |
| `src/codemie/rest_api/security/user_providers/persistent.py` | Backend: `user-id` header auth (ENV=local gate) |
| `src/codemie/service/user/authentication_service.py` | `authenticate_dev_header` — looks up user by UUID |
