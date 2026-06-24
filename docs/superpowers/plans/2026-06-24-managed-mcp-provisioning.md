# Managed MCP Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision internal EPAM MCP servers (e.g. `radar`) into Claude Desktop during `codemie proxy connect desktop`, fetched at runtime from a client-neutral CodeMie backend endpoint, with the internal MCP list stored only in a K8s ConfigMap (never committed to either open-source repo).

**Architecture:** The `codemie` backend exposes `GET /v1/mcp/managed-servers?client=<id>` returning a client-neutral catalog loaded from `managed-mcp-servers.yaml` (a key in the existing `codemie-customer-config` ConfigMap). The `codemie-code` CLI fetches this list during connect, maps it to Claude Desktop's `managedMcpServers` shape, and reconciles it into the Desktop config with a marker-based mechanism that supports add/update/**remove** while preserving user-added MCPs.

**Tech Stack:** Backend — Python 3.12, FastAPI, pydantic v2, pytest (`tests/`, run with `--import-mode=importlib`). CLI — TypeScript ES modules, Vitest, `codemie-sdk` (cookie-based SSO auth).

**Conventions for this plan:**
- **No per-task git commits** (per the repo owner's standing preference). Produce a single summary `.md` at the end (final task). Commit only if the user explicitly asks.
- **TDD per task**: write the failing test, run it red, implement minimally, run it green.
- Two repos. Each task header states the repo and the absolute working directory.

---

## File Structure

`codemie` backend (`/Users/Vadym_Vlasenko/AI/codemie/codemie`):
- Create `src/codemie/configs/managed_mcp_config.py` — `ManagedMcpServer` model + `load_managed_mcp_servers()` loader (missing-file-safe).
- Create `src/codemie/rest_api/routers/mcp_managed.py` — `GET /v1/mcp/managed-servers`.
- Modify `src/codemie/rest_api/main.py:47` (router import block) and `:516` area (`include_router`).
- Create `config/customer/managed-mcp-servers.example.yaml` — documented example (real file lives in the ConfigMap).
- Create `tests/codemie/configs/test_managed_mcp_config.py`, `tests/codemie/rest_api/routers/test_mcp_managed.py`.

`codemie-code` CLI (`/Users/Vadym_Vlasenko/AI/projects/codemie-code`):
- Create `src/cli/commands/proxy/connectors/managed-mcp-remote.ts` — `CanonicalMcpEntry` type, validator, `fetchManagedMcpServers()`.
- Modify `src/cli/commands/proxy/connectors/desktop.ts` — `mapCanonicalToDesktop()`, `reconcileManagedMcpServers()` (replaces `mergeManagedMcpServers`), managed-state sidecar helpers, `writeDesktopConfig()` gains `orgMcpServers` + `managedStatePath` params.
- Modify `src/cli/commands/proxy/index.ts` — fetch + map + pass into `writeDesktopConfig` in the `connect desktop` action.
- Create `src/cli/commands/proxy/connectors/__tests__/managed-mcp-remote.test.ts`; extend `__tests__/desktop.test.ts`.

---

# Phase A — Backend (`codemie` repo)

All Phase A steps run from: `/Users/Vadym_Vlasenko/AI/codemie/codemie`

## Task A1: Managed MCP config loader

**Files:**
- Create: `src/codemie/configs/managed_mcp_config.py`
- Test: `tests/codemie/configs/test_managed_mcp_config.py`

- [ ] **Step 1: Write the failing test**

Create `tests/codemie/configs/test_managed_mcp_config.py`:

```python
# Copyright 2026 EPAM Systems, Inc. ("EPAM")
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from pathlib import Path

from codemie.configs.managed_mcp_config import (
    ManagedMcpServer,
    load_managed_mcp_servers,
)

RADAR_YAML = """
servers:
  - name: radar
    transport: http
    url: https://mcp.epam.com/mcp/radar
    auth: oauth
    clients: [claude-desktop, codex]
  - name: globalmcp
    transport: http
    url: https://mcp.epam.com/mcp/global
    auth: oauth
"""


def _write(dir_path: Path, text: str) -> Path:
    (dir_path / "managed-mcp-servers.yaml").write_text(text)
    return dir_path


def test_missing_file_returns_empty(tmp_path: Path):
    assert load_managed_mcp_servers(base_dir=tmp_path) == []


def test_loads_and_parses_entries(tmp_path: Path):
    _write(tmp_path, RADAR_YAML)
    servers = load_managed_mcp_servers(base_dir=tmp_path)
    assert [s.name for s in servers] == ["radar", "globalmcp"]
    assert servers[0].url == "https://mcp.epam.com/mcp/radar"
    assert servers[0].auth == "oauth"


def test_skips_malformed_entries(tmp_path: Path):
    _write(tmp_path, "servers:\n  - {name: ok, transport: http, url: https://a}\n  - {name: bad, transport: ftp, url: https://b}\n")
    servers = load_managed_mcp_servers(base_dir=tmp_path)
    assert [s.name for s in servers] == ["ok"]


def test_filters_by_client(tmp_path: Path):
    _write(tmp_path, RADAR_YAML)
    # globalmcp has no `clients` → applies to all; radar lists codex too
    codex = load_managed_mcp_servers(client="codex", base_dir=tmp_path)
    assert {s.name for s in codex} == {"radar", "globalmcp"}
    # an entry restricted to claude-desktop only must not appear for another client
    _write(tmp_path, "servers:\n  - {name: only_cd, transport: http, url: https://x, clients: [claude-desktop]}\n")
    assert load_managed_mcp_servers(client="codex", base_dir=tmp_path) == []
    assert [s.name for s in load_managed_mcp_servers(client="claude-desktop", base_dir=tmp_path)] == ["only_cd"]


def test_corrupt_yaml_returns_empty(tmp_path: Path):
    _write(tmp_path, "servers: [unclosed")
    assert load_managed_mcp_servers(base_dir=tmp_path) == []


def test_returns_typed_models(tmp_path: Path):
    _write(tmp_path, RADAR_YAML)
    servers = load_managed_mcp_servers(base_dir=tmp_path)
    assert all(isinstance(s, ManagedMcpServer) for s in servers)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/codemie/configs/test_managed_mcp_config.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'codemie.configs.managed_mcp_config'`

- [ ] **Step 3: Write minimal implementation**

Create `src/codemie/configs/managed_mcp_config.py`:

```python
# Copyright 2026 EPAM Systems, Inc. ("EPAM")
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
Loader for the client-neutral managed MCP server catalog.

The catalog file (`managed-mcp-servers.yaml`) is NOT committed to this
repository — it is supplied per deployment as a key in the
`codemie-customer-config` ConfigMap, mounted at `CUSTOMER_CONFIG_DIR`. This
loader is intentionally resilient: a missing or malformed file yields an empty
list rather than raising, so the endpoint degrades to "no managed MCPs".
"""

from __future__ import annotations

from pathlib import Path
from typing import List, Literal, Optional

import yaml
from pydantic import BaseModel, ConfigDict, ValidationError

from codemie.configs.config import config
from codemie.configs.logger import logger

MANAGED_MCP_FILENAME = "managed-mcp-servers.yaml"


class ManagedMcpServer(BaseModel):
    """A client-neutral managed MCP server entry. Remote-only in v1."""

    name: str
    transport: Literal["http", "sse"]
    url: str
    auth: Literal["oauth", "none"] = "none"
    description: Optional[str] = None
    clients: Optional[List[str]] = None

    model_config = ConfigDict(extra="ignore")


def load_managed_mcp_servers(
    client: Optional[str] = None,
    base_dir: Optional[Path] = None,
) -> List[ManagedMcpServer]:
    """
    Load managed MCP servers from the customer ConfigMap directory.

    Args:
        client: optional client id; entries are kept when they have no
            `clients` targeting (apply to all) or include this client.
        base_dir: override the config directory (defaults to CUSTOMER_CONFIG_DIR).

    Returns:
        Validated entries; never raises (missing/corrupt file → []).
    """
    directory = Path(base_dir) if base_dir is not None else Path(config.CUSTOMER_CONFIG_DIR)
    path = directory / MANAGED_MCP_FILENAME
    if not path.exists():
        return []

    try:
        data = yaml.safe_load(path.read_text())
    except yaml.YAMLError as exc:
        logger.warning(f"Failed to parse {MANAGED_MCP_FILENAME}: {exc}")
        return []

    raw = data.get("servers", []) if isinstance(data, dict) else []
    if not isinstance(raw, list):
        return []

    servers: List[ManagedMcpServer] = []
    for item in raw:
        try:
            servers.append(ManagedMcpServer(**item))
        except (ValidationError, TypeError) as exc:
            logger.warning(f"Skipping invalid managed MCP entry {item!r}: {exc}")

    if client:
        servers = [s for s in servers if not s.clients or client in s.clients]
    return servers
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/codemie/configs/test_managed_mcp_config.py -v`
Expected: PASS (6 passed)

## Task A2: REST endpoint + router registration

**Files:**
- Create: `src/codemie/rest_api/routers/mcp_managed.py`
- Modify: `src/codemie/rest_api/main.py:47` (router import block), `:516` area (`include_router`)
- Test: `tests/codemie/rest_api/routers/test_mcp_managed.py`

- [ ] **Step 1: Write the failing test**

Create `tests/codemie/rest_api/routers/test_mcp_managed.py`:

```python
# Copyright 2026 EPAM Systems, Inc. ("EPAM")
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from unittest.mock import patch

import pytest
from fastapi import status
from httpx import AsyncClient, ASGITransport

from codemie.rest_api.main import app
from codemie.rest_api.security.user import User
from codemie.configs.managed_mcp_config import ManagedMcpServer


@pytest.fixture
def user():
    return User(id="123", username="testuser", name="Test User")


@pytest.fixture(autouse=True)
def override_dependency(user):
    from codemie.rest_api.routers import mcp_managed as mcp_managed_router

    app.dependency_overrides[mcp_managed_router.authenticate] = lambda: user
    yield
    app.dependency_overrides = {}


@pytest.mark.asyncio
async def test_list_managed_servers_returns_loaded_entries():
    entries = [ManagedMcpServer(name="radar", transport="http", url="https://mcp.epam.com/mcp/radar", auth="oauth")]
    with patch(
        "codemie.rest_api.routers.mcp_managed.load_managed_mcp_servers", return_value=entries
    ) as mock_load:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
            response = await ac.get(
                "/v1/mcp/managed-servers?client=claude-desktop",
                headers={"Authorization": "Bearer testtoken"},
            )

        mock_load.assert_called_once_with(client="claude-desktop")
        assert response.status_code == status.HTTP_200_OK
        assert response.json() == [
            {
                "name": "radar",
                "transport": "http",
                "url": "https://mcp.epam.com/mcp/radar",
                "auth": "oauth",
                "description": None,
                "clients": None,
            }
        ]


@pytest.mark.asyncio
async def test_list_managed_servers_without_client_param():
    with patch(
        "codemie.rest_api.routers.mcp_managed.load_managed_mcp_servers", return_value=[]
    ) as mock_load:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
            response = await ac.get("/v1/mcp/managed-servers", headers={"Authorization": "Bearer t"})

        mock_load.assert_called_once_with(client=None)
        assert response.status_code == status.HTTP_200_OK
        assert response.json() == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/codemie/rest_api/routers/test_mcp_managed.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'codemie.rest_api.routers.mcp_managed'`

- [ ] **Step 3: Write minimal implementation**

Create `src/codemie/rest_api/routers/mcp_managed.py`:

```python
# Copyright 2026 EPAM Systems, Inc. ("EPAM")
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Client-neutral managed MCP catalog endpoint."""

from typing import List, Optional

from fastapi import APIRouter, Depends, Query

from codemie.configs.managed_mcp_config import ManagedMcpServer, load_managed_mcp_servers
from codemie.rest_api.security.authentication import authenticate

router = APIRouter(prefix="/v1/mcp", tags=["MCP"], dependencies=[Depends(authenticate)])


@router.get("/managed-servers", response_model=List[ManagedMcpServer])
def list_managed_mcp_servers(
    client: Optional[str] = Query(default=None, description="Agent client id, e.g. claude-desktop"),
) -> List[ManagedMcpServer]:
    """Return managed MCP servers, optionally filtered to the given client."""
    return load_managed_mcp_servers(client=client)
```

- [ ] **Step 4: Register the router in main.py**

In `src/codemie/rest_api/main.py`, add `mcp_managed` to the router import block at line 47 (the `from codemie.rest_api.routers import ( ... )` group — insert alphabetically near the other names):

```python
    mcp_managed,
```

Then near line 516 (with the other `app.include_router(...)` calls), add:

```python
app.include_router(mcp_managed.router)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pytest tests/codemie/rest_api/routers/test_mcp_managed.py -v`
Expected: PASS (2 passed)

## Task A3: Example ConfigMap file

**Files:**
- Create: `config/customer/managed-mcp-servers.example.yaml`
- Test: `tests/codemie/configs/test_managed_mcp_config.py` (add one case)

- [ ] **Step 1: Write the failing test**

Append to `tests/codemie/configs/test_managed_mcp_config.py`:

```python
def test_example_file_is_valid():
    from pathlib import Path

    import codemie

    repo_root = Path(codemie.__file__).resolve().parents[2]
    example = repo_root / "config" / "customer" / "managed-mcp-servers.example.yaml"
    assert example.exists(), f"example file missing at {example}"
    servers = load_managed_mcp_servers(base_dir=example.parent)
    # The example file is named .example.yaml, so the loader (which reads
    # managed-mcp-servers.yaml) returns []; assert the example itself parses.
    import yaml

    data = yaml.safe_load(example.read_text())
    assert isinstance(data, dict) and isinstance(data.get("servers"), list)
    for item in data["servers"]:
        ManagedMcpServer(**item)
    assert servers == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/codemie/configs/test_managed_mcp_config.py::test_example_file_is_valid -v`
Expected: FAIL — assertion error, example file missing

- [ ] **Step 3: Create the example file**

Create `config/customer/managed-mcp-servers.example.yaml`:

```yaml
# Example managed MCP catalog. Copy this content into the
# `managed-mcp-servers.yaml` key of the `codemie-customer-config` ConfigMap.
# This .example.yaml file is documentation only and is never read at runtime.
#
# Schema (remote-only in v1):
#   name:        unique server name [a-zA-Z0-9_-]
#   transport:   http | sse
#   url:         server URL
#   auth:        oauth | none        (default: none)
#   description: optional human label
#   clients:     optional list; omit = all clients (e.g. claude-desktop, codex)
servers:
  - name: radar
    transport: http
    url: https://mcp.epam.com/mcp/radar
    auth: oauth
    description: EPAM Radar
    clients: [claude-desktop]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/codemie/configs/test_managed_mcp_config.py::test_example_file_is_valid -v`
Expected: PASS

- [ ] **Step 5: Run the full backend test module**

Run: `pytest tests/codemie/configs/test_managed_mcp_config.py tests/codemie/rest_api/routers/test_mcp_managed.py -v`
Expected: PASS (all)

---

# Phase B — CLI (`codemie-code` repo)

All Phase B steps run from: `/Users/Vadym_Vlasenko/AI/projects/codemie-code`
Run a single test file with: `npx vitest run <path>`

## Task B1: Canonical type + remote fetch

**Files:**
- Create: `src/cli/commands/proxy/connectors/managed-mcp-remote.ts`
- Test: `src/cli/commands/proxy/connectors/__tests__/managed-mcp-remote.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/cli/commands/proxy/connectors/__tests__/managed-mcp-remote.test.ts`:

```typescript
/**
 * Managed MCP remote-fetch tests
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodeMieSSO } from '@/providers/plugins/sso/sso.auth.js';
import { fetchManagedMcpServers } from '../managed-mcp-remote.js';

const CREDS = { apiUrl: 'https://api.codemie.test', cookies: { codemie_access_token: 'abc', sid: 'xyz' } };

describe('fetchManagedMcpServers', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.spyOn(CodeMieSSO.prototype, 'getStoredCredentials').mockResolvedValue(CREDS as any);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('requests the client-scoped endpoint with a cookie header and returns valid entries', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { name: 'radar', transport: 'http', url: 'https://mcp.epam.com/mcp/radar', auth: 'oauth' },
        { name: 'bad name', transport: 'http', url: 'https://x' }, // invalid name → dropped
        { name: 'noturl', transport: 'http' },                      // missing url → dropped
      ],
    });
    globalThis.fetch = fetchMock as any;

    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');

    expect(result).toEqual([
      { name: 'radar', transport: 'http', url: 'https://mcp.epam.com/mcp/radar', auth: 'oauth' },
    ]);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toBe('https://api.codemie.test/v1/mcp/managed-servers?client=claude-desktop');
    expect((init.headers as Record<string, string>).cookie).toBe('codemie_access_token=abc;sid=xyz');
  });

  it('returns [] when credentials are missing', async () => {
    (CodeMieSSO.prototype.getStoredCredentials as any).mockResolvedValue(null);
    globalThis.fetch = vi.fn() as any;
    expect(await fetchManagedMcpServers('claude-desktop', 'https://codemie.test')).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns [] on non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' }) as any;
    expect(await fetchManagedMcpServers('claude-desktop', 'https://codemie.test')).toEqual([]);
  });

  it('returns [] when fetch throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network')) as any;
    expect(await fetchManagedMcpServers('claude-desktop', 'https://codemie.test')).toEqual([]);
  });

  it('returns [] when body is not an array', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ servers: [] }) }) as any;
    expect(await fetchManagedMcpServers('claude-desktop', 'https://codemie.test')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/managed-mcp-remote.test.ts`
Expected: FAIL — cannot resolve `../managed-mcp-remote.js`

- [ ] **Step 3: Write minimal implementation**

Create `src/cli/commands/proxy/connectors/managed-mcp-remote.ts`:

```typescript
import { CodeMieSSO } from '@/providers/plugins/sso/sso.auth.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';

const VALID_NAME = /^[a-zA-Z0-9_-]+$/;
const CANONICAL_TRANSPORTS = new Set(['http', 'sse', 'stdio']);
const CANONICAL_AUTH = new Set(['oauth', 'none']);

/** Client-neutral MCP entry returned by GET /v1/mcp/managed-servers. */
export interface CanonicalMcpEntry {
  name: string;
  transport: 'http' | 'sse' | 'stdio';
  url?: string;
  auth?: 'oauth' | 'none';
  description?: string;
  clients?: string[];
}

function isValidCanonicalEntry(value: unknown): value is CanonicalMcpEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  if (typeof e.name !== 'string' || !VALID_NAME.test(e.name)) return false;
  if (typeof e.transport !== 'string' || !CANONICAL_TRANSPORTS.has(e.transport)) return false;
  if (e.url !== undefined && typeof e.url !== 'string') return false;
  if (e.auth !== undefined && (typeof e.auth !== 'string' || !CANONICAL_AUTH.has(e.auth))) return false;
  return true;
}

function pickCanonicalFields(e: CanonicalMcpEntry): CanonicalMcpEntry {
  const out: CanonicalMcpEntry = { name: e.name, transport: e.transport };
  if (e.url !== undefined) out.url = e.url;
  if (e.auth !== undefined) out.auth = e.auth;
  if (e.description !== undefined) out.description = e.description;
  if (Array.isArray(e.clients)) out.clients = e.clients;
  return out;
}

/**
 * Fetch the client-neutral managed MCP catalog from CodeMie.
 *
 * Best-effort: any failure (missing creds, network, non-2xx, bad body) returns
 * an empty list so `connect` never breaks. Auth mirrors the SDK's cookie scheme.
 */
export async function fetchManagedMcpServers(
  client: string,
  codeMieUrl: string,
): Promise<CanonicalMcpEntry[]> {
  try {
    if (!codeMieUrl) return [];
    const sso = new CodeMieSSO();
    const creds = await sso.getStoredCredentials(codeMieUrl);
    if (!creds?.cookies || !creds.apiUrl) {
      logger.warn('[proxy] Managed MCP fetch skipped: no SSO credentials');
      return [];
    }
    const cookie = Object.entries(creds.cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join(';');
    const endpoint = new URL('/v1/mcp/managed-servers', creds.apiUrl);
    endpoint.searchParams.set('client', client);

    const response = await fetch(endpoint, { headers: { cookie } });
    if (!response.ok) {
      logger.warn(
        '[proxy] Managed MCP fetch failed',
        ...sanitizeLogArgs({ status: response.status, statusText: response.statusText }),
      );
      return [];
    }
    const json = (await response.json()) as unknown;
    if (!Array.isArray(json)) return [];
    return json.filter(isValidCanonicalEntry).map(pickCanonicalFields);
  } catch (error) {
    logger.warn(
      '[proxy] Managed MCP fetch threw',
      ...sanitizeLogArgs({ error: error instanceof Error ? error.message : String(error) }),
    );
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/managed-mcp-remote.test.ts`
Expected: PASS (5 passed)

## Task B2: Canonical → Claude Desktop mapping

**Files:**
- Modify: `src/cli/commands/proxy/connectors/desktop.ts`
- Test: `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the imports in `__tests__/desktop.test.ts` (the `from '../desktop.js'` block):

```typescript
  mapCanonicalToDesktop,
```

Add a new describe block at the end of `__tests__/desktop.test.ts`:

```typescript
describe('mapCanonicalToDesktop', () => {
  it('maps remote oauth/none entries and sets the oauth boolean', () => {
    const result = mapCanonicalToDesktop([
      { name: 'radar', transport: 'http', url: 'https://mcp.epam.com/mcp/radar', auth: 'oauth' },
      { name: 'plain', transport: 'sse', url: 'https://x/sse', auth: 'none' },
    ]);
    expect(result).toEqual([
      { name: 'radar', url: 'https://mcp.epam.com/mcp/radar', transport: 'http', oauth: true },
      { name: 'plain', url: 'https://x/sse', transport: 'sse', oauth: false },
    ]);
  });

  it('drops entries Claude Desktop cannot represent (stdio / missing url / bad name)', () => {
    const result = mapCanonicalToDesktop([
      { name: 'local', transport: 'stdio' },
      { name: 'nourl', transport: 'http' },
      { name: 'bad name', transport: 'http', url: 'https://x' },
      { name: 'ok', transport: 'http', url: 'https://ok' },
    ]);
    expect(result).toEqual([{ name: 'ok', url: 'https://ok', transport: 'http', oauth: false }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/desktop.test.ts -t mapCanonicalToDesktop`
Expected: FAIL — `mapCanonicalToDesktop is not a function` / import error

- [ ] **Step 3: Write minimal implementation**

In `src/cli/commands/proxy/connectors/desktop.ts`, add the import near the top (after the existing `import managedMcpServers ...` line):

```typescript
import type { CanonicalMcpEntry } from './managed-mcp-remote.js';
```

Then add this function (place it just above `mergeManagedMcpServers`):

```typescript
const DESKTOP_SUPPORTED_TRANSPORTS = new Set(['http', 'sse']);

/**
 * Map client-neutral canonical entries to Claude Desktop's managedMcpServers
 * shape. Drops entries Desktop cannot represent (non-http/sse transports,
 * missing URL, or invalid name).
 */
export function mapCanonicalToDesktop(entries: CanonicalMcpEntry[]): ManagedMcpServerEntry[] {
  const result: ManagedMcpServerEntry[] = [];
  for (const entry of entries) {
    if (!DESKTOP_SUPPORTED_TRANSPORTS.has(entry.transport)) continue;
    if (!entry.url || !isValidMcpServerName(entry.name)) continue;
    result.push({
      name: entry.name,
      url: entry.url,
      transport: entry.transport as 'http' | 'sse',
      oauth: entry.auth === 'oauth',
    });
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/desktop.test.ts -t mapCanonicalToDesktop`
Expected: PASS

## Task B3: Reconcile with revocation marker

**Files:**
- Modify: `src/cli/commands/proxy/connectors/desktop.ts`
- Test: `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the `from '../desktop.js'` import block in `__tests__/desktop.test.ts`:

```typescript
  reconcileManagedMcpServers,
```

Add a new describe block at the end of `__tests__/desktop.test.ts`:

```typescript
describe('reconcileManagedMcpServers', () => {
  const managed = [
    { name: 'radar', url: 'https://mcp.epam.com/mcp/radar', transport: 'http' as const, oauth: true },
  ];

  it('adds managed entries and preserves unrelated user entries', () => {
    const existing = [{ name: 'mine', url: 'https://mine', transport: 'http', oauth: true }];
    const { servers, managedNames } = reconcileManagedMcpServers(existing, managed, []);
    expect(managedNames).toEqual(['radar']);
    expect(servers).toEqual([
      { name: 'radar', url: 'https://mcp.epam.com/mcp/radar', transport: 'http', oauth: true },
      { name: 'mine', url: 'https://mine', transport: 'http', oauth: true },
    ]);
  });

  it('supersedes a colliding user entry (by name or url)', () => {
    const existing = [
      { name: 'radar', url: 'https://old-radar', transport: 'http', oauth: true, source: 'user' },
    ];
    const { servers } = reconcileManagedMcpServers(existing, managed, []);
    expect(servers).toEqual([
      { name: 'radar', url: 'https://mcp.epam.com/mcp/radar', transport: 'http', oauth: true },
    ]);
  });

  it('revokes a previously-managed entry that is no longer managed', () => {
    // radar was managed last run (in previouslyManagedNames) and Desktop re-stamped it source:user;
    // it is absent from the current managed set, so it must be dropped.
    const existing = [
      { name: 'radar', url: 'https://mcp.epam.com/mcp/radar', transport: 'http', oauth: true, source: 'user' },
      { name: 'mine', url: 'https://mine', transport: 'http', oauth: true },
    ];
    const { servers, managedNames } = reconcileManagedMcpServers(existing, [], ['radar']);
    expect(managedNames).toEqual([]);
    expect(servers).toEqual([{ name: 'mine', url: 'https://mine', transport: 'http', oauth: true }]);
  });

  it('drops entries with invalid names', () => {
    const existing = [{ name: 'bad name', url: 'https://b', transport: 'http' }];
    const { servers } = reconcileManagedMcpServers(existing, [], []);
    expect(servers).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/desktop.test.ts -t reconcileManagedMcpServers`
Expected: FAIL — `reconcileManagedMcpServers is not a function`

- [ ] **Step 3: Write minimal implementation**

In `src/cli/commands/proxy/connectors/desktop.ts`, replace the existing `mergeManagedMcpServers` function (lines ~209-225) with the reconcile implementation below. Keep the existing helpers `isRecord`, `getManagedMcpServerName`, `parseJsonArray`, `isValidMcpServerName`.

```typescript
export interface ReconcileResult {
  servers: unknown[];
  managedNames: string[];
}

/**
 * Reconcile the managed MCP set into an existing managedMcpServers array.
 *
 * - `managed`: the entries CodeMie owns this run (public defaults + fetched
 *   internal), already in Desktop shape.
 * - `previouslyManagedNames`: names CodeMie wrote on the prior run. Required so
 *   that an entry removed from the managed set is dropped even though Claude
 *   Desktop re-stamps entries it persists (we cannot rely on a custom marker
 *   field surviving Desktop's rewrite).
 *
 * Genuine user-added entries (never managed by us) are preserved.
 */
export function reconcileManagedMcpServers(
  existingServers: unknown,
  managed: ManagedMcpServerEntry[],
  previouslyManagedNames: string[] = [],
): ReconcileResult {
  const managedNames = managed.map((s) => s.name);
  const ownedLower = new Set(
    [...previouslyManagedNames, ...managedNames].map((n) => n.toLowerCase()),
  );
  const managedUrls = new Set(managed.map((s) => s.url));

  const filtered = parseJsonArray(existingServers).filter((server) => {
    const name = getManagedMcpServerName(server);
    if (!name) return true;
    if (!isValidMcpServerName(name)) return false;
    if (ownedLower.has(name.toLowerCase())) return false;
    const url = isRecord(server) && typeof server.url === 'string' ? server.url : undefined;
    if (url && managedUrls.has(url)) return false;
    return true;
  });

  return {
    servers: [...managed.map((s) => ({ ...s })), ...filtered],
    managedNames,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/desktop.test.ts -t reconcileManagedMcpServers`
Expected: PASS

- [ ] **Step 5: Verify no other importers of the removed `mergeManagedMcpServers`**

Run: `grep -rn "mergeManagedMcpServers" src/`
Expected: no matches (function fully replaced). If any appear, update them to `reconcileManagedMcpServers`.

## Task B4: writeDesktopConfig — org list + managed-state sidecar

**Files:**
- Modify: `src/cli/commands/proxy/connectors/desktop.ts`
- Test: `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the `from '../desktop.js'` import block in `__tests__/desktop.test.ts`:

```typescript
  getManagedMcpStatePath,
```

Add these tests inside the existing `describe('writeDesktopConfig', ...)` block (after the current tests). They rely on the existing `baseDir`/`libDir`/`metaPath` fixtures; they add a temp `statePath`:

```typescript
  it('writes org MCP servers and persists managed-state for revocation', async () => {
    const statePath = join(baseDir, 'managed-state.json');
    const org = [
      { name: 'radar', url: 'https://mcp.epam.com/mcp/radar', transport: 'http' as const, oauth: true },
    ];
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    expect(servers.some((s: any) => s.name === 'radar')).toBe(true);
    // public defaults still present
    expect(servers.some((s: any) => s.name === 'Notion')).toBe(true);

    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(state.managedNames).toContain('radar');
    expect(state.managedNames).toContain('Notion');
  });

  it('revokes a managed server removed from the org list on the next run', async () => {
    const statePath = join(baseDir, 'managed-state.json');
    const org = [
      { name: 'radar', url: 'https://mcp.epam.com/mcp/radar', transport: 'http' as const, oauth: true },
    ];
    // Run 1: radar present
    await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);
    // Run 2: radar removed from org list
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, [], statePath);

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    expect(servers.some((s: any) => s.name === 'radar')).toBe(false);
    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(state.managedNames).not.toContain('radar');
  });

  it('exposes a default managed-state path under the codemie home', () => {
    expect(getManagedMcpStatePath()).toMatch(/desktop-managed-mcp-state\.json$/);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/desktop.test.ts -t "writeDesktopConfig"`
Expected: FAIL — `getManagedMcpStatePath` not exported / `writeDesktopConfig` ignores the new args

- [ ] **Step 3: Write minimal implementation**

In `src/cli/commands/proxy/connectors/desktop.ts`:

(a) Add imports at the top (extend the existing `node:fs/promises` import and add the paths util):

```typescript
import { getCodemiePath } from '@/utils/paths.js';
```

(b) Add the managed-state helpers (place near `getDesktopConfigPath`):

```typescript
interface ManagedMcpState {
  managedNames: string[];
}

/** Default location of the CLI-owned managed-MCP marker state. */
export function getManagedMcpStatePath(): string {
  return getCodemiePath('proxy', 'desktop-managed-mcp-state.json');
}

async function readManagedMcpState(statePath: string): Promise<string[]> {
  if (!existsSync(statePath)) return [];
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf-8')) as ManagedMcpState;
    return Array.isArray(parsed.managedNames) ? parsed.managedNames : [];
  } catch {
    return [];
  }
}

async function writeManagedMcpState(statePath: string, managedNames: string[]): Promise<void> {
  const dir = join(statePath, '..');
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(statePath, JSON.stringify({ managedNames }, null, 2), 'utf-8');
}
```

(c) Change the `writeDesktopConfig` signature to accept the org list and state path:

```typescript
export async function writeDesktopConfig(
  proxyUrl: string,
  gatewayKey: string,
  baseDir: string = getDesktopBaseDir(),
  orgMcpServers: ManagedMcpServerEntry[] = [],
  managedStatePath: string = getManagedMcpStatePath()
): Promise<string> {
```

(d) Replace the line `const managedMcpServers = mergeManagedMcpServers(existing.managedMcpServers);` with:

```typescript
  const managedSet = [...DEFAULT_MANAGED_MCP_SERVERS.map((s) => ({ ...s })), ...orgMcpServers];
  const previouslyManagedNames = await readManagedMcpState(managedStatePath);
  const { servers: managedMcpServers, managedNames } = reconcileManagedMcpServers(
    existing.managedMcpServers,
    managedSet,
    previouslyManagedNames
  );
```

(e) After the existing `await writeFile(configPath, ...)` that writes the merged config, persist the marker state:

```typescript
  await writeManagedMcpState(managedStatePath, managedNames);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/proxy/connectors/__tests__/desktop.test.ts`
Expected: PASS (all describe blocks, including the pre-existing ones)

## Task B5: Wire fetch + map into `connect desktop`

**Files:**
- Modify: `src/cli/commands/proxy/index.ts`
- Verify: typecheck + build + manual run

- [ ] **Step 1: Update imports in `index.ts`**

Add to the connector imports near line 20:

```typescript
import { writeDesktopConfig, getDesktopBaseDir, mapCanonicalToDesktop } from './connectors/desktop.js';
import { fetchManagedMcpServers } from './connectors/managed-mcp-remote.js';
```

(Replace the existing `import { writeDesktopConfig } from './connectors/desktop.js';` line.)

- [ ] **Step 2: Fetch, map, and pass the org list into the Desktop write**

In the `connect desktop` action, replace the existing single line
`const configPath = await writeDesktopConfig(state!.url, state!.gatewayKey);` (around line 367) with:

```typescript
        const canonical = state!.syncCodeMieUrl
          ? await fetchManagedMcpServers('claude-desktop', state!.syncCodeMieUrl)
          : [];
        const orgMcpServers = mapCanonicalToDesktop(canonical);
        logger.info(
          '[proxy] Resolved managed MCP servers for Claude Desktop',
          ...sanitizeLogArgs({
            codeMieUrl: state!.syncCodeMieUrl,
            canonicalCount: canonical.length,
            mappedCount: orgMcpServers.length,
            mappedNames: orgMcpServers.map((s) => s.name),
          })
        );
        const configPath = await writeDesktopConfig(
          state!.url,
          state!.gatewayKey,
          getDesktopBaseDir(),
          orgMcpServers
        );
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: zero warnings (repo policy). Fix with `npm run lint:fix` if needed.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: builds to `dist/` with no errors.

- [ ] **Step 6: Run the full proxy connector test suite**

Run: `npx vitest run src/cli/commands/proxy`
Expected: PASS (all).

- [ ] **Step 7: Manual verification (records evidence for the summary)**

With a backend serving the endpoint (or a stubbed `managed-mcp-servers.yaml` in the ConfigMap), run:

```bash
codemie proxy connect desktop --verbose
```

Then inspect the applied Desktop config:

```bash
cat "$HOME/Library/Application Support/Claude-3p/configLibrary/$(jq -r .appliedId "$HOME/Library/Application Support/Claude-3p/configLibrary/_meta.json").json" | jq '.managedMcpServers | fromjson | map(.name)'
```

Expected: the list includes the public defaults plus any internal MCPs the backend returned (e.g. `radar`). Confirm `~/.codemie/proxy/desktop-managed-mcp-state.json` lists the managed names.

> **Open item to verify here (from the spec §11):** confirm whether Claude Desktop, after restart, rewrites managed entries and stamps `source: "user"`. The sidecar-based revocation in Task B3/B4 does not depend on a custom field surviving, so it is robust either way — but record the observed behavior in the summary.

---

# Phase C — Wrap-up

## Task C1: Cross-repo verification + summary

- [ ] **Step 1: Backend full check**

From `/Users/Vadym_Vlasenko/AI/codemie/codemie`:
Run: `pytest tests/codemie/configs/test_managed_mcp_config.py tests/codemie/rest_api/routers/test_mcp_managed.py -v`
Expected: PASS.

- [ ] **Step 2: CLI full quality gates**

From `/Users/Vadym_Vlasenko/AI/projects/codemie-code`:
Run: `npm run typecheck && npm run lint && npx vitest run src/cli/commands/proxy && npm run build`
Expected: all green.

- [ ] **Step 3: Write the single summary doc**

Create `docs/superpowers/summaries/2026-06-24-managed-mcp-provisioning-summary.md` describing: what changed in each repo (file list), the canonical schema, the endpoint, the revocation/sidecar mechanism, the manual-verification result (including the observed Claude Desktop `source`-field behavior), and the ConfigMap operator steps (add `managed-mcp-servers.yaml` key to `codemie-customer-config`). Do **not** commit unless the user asks.

---

## Self-Review notes (coverage map)

- Spec §5 canonical schema → Task A1 (`ManagedMcpServer`), Task B1 (`CanonicalMcpEntry`).
- Spec §6 backend loader (missing-file-safe) + endpoint + registration → Tasks A1, A2; example file → A3.
- Spec §7 CLI fetch via SDK cookie auth → Task B1; canonical→Desktop mapping → B2; reconcile+merge → B3; writeDesktopConfig + sidecar → B4; index wiring → B5.
- Spec §7 revocation (D6) → Tasks B3, B4 (sidecar marker), B5 manual evidence.
- Spec §7 failure non-fatal → Task B1 (returns `[]`) + B5 (`syncCodeMieUrl` guard).
- Spec §8 security: authenticated endpoint → A2; no secrets on disk (oauth boolean only) → B2.
- Spec §11 open items → flagged in B5 Step 7 and C1 Step 3.
- Spec §12 out-of-scope (Codex connector, stdio, headers, per-project, caching) → intentionally not in any task.
