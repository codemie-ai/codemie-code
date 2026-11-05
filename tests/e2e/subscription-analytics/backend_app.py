"""E2E backend harness for the subscription-analytics CLI connect flow (EPMCDME-16849).

REAL: the backend's cli_analytics router, publication-contract check, evidence/consent gates, ingestor, SQL on a
Postgres 17 container, and the analytics reader (queried through /_e2e/visible).
STUBBED (labelled, never hidden): the authentication dependency (the email is read from the CLI's own JWT cookie,
unverified), the application directory the project gate reads (an in-memory dict, no application database), the
customer-config feature flags, and the unavailable `pyroscope` import.

Run:  E2E_PG_URL=postgresql://... E2E_PORT=8765 <backend .venv python> backend_app.py
"""

import base64
import json
import os
import sys
import types
from contextlib import asynccontextmanager
from types import SimpleNamespace

sys.modules.setdefault("pyroscope", types.ModuleType("pyroscope"))  # not installable here; unrelated to analytics
os.environ["CLI_ANALYTICS_PG_URL"] = os.environ["E2E_PG_URL"]
os.environ["ENV"] = "dev"  # ENV=local would make every user a super admin
os.environ["ADMIN_USER_ID"] = "admin@example.invalid"
os.environ.setdefault("ENABLE_USER_MANAGEMENT", "false")

import asyncpg  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import FastAPI, Request  # noqa: E402

from codemie.configs import config  # noqa: E402
from codemie.configs.customer_config import customer_config  # noqa: E402
from codemie.core.models import Application  # noqa: E402
from codemie.repository.cli_analytics.factory import get_cli_analytics_storage  # noqa: E402
from codemie.repository.cli_analytics.filters import LocalAnalyticsFilter  # noqa: E402
from codemie.repository.cli_analytics.scope import ViewerScope  # noqa: E402
from codemie.rest_api.routers import cli_analytics  # noqa: E402
from codemie.rest_api.security.authentication import authenticate  # noqa: E402
from codemie.rest_api.security.user import User  # noqa: E402
from codemie.service.analytics import cli_analytics_project_gate as gate  # noqa: E402

PG_URL = os.environ["E2E_PG_URL"]
WORK_PROJECT = "work-proj"
ORGS = "Acme Corp"

# ---- stubs: the application directory the project gate reads -------------------------------------------------
_apps: dict[str, SimpleNamespace] = {
    WORK_PROJECT: SimpleNamespace(
        name=WORK_PROJECT, project_type=Application.ProjectType.SHARED, created_by="someone", deleted_at=None, cli_analytics_enabled=True
    ),
}


def _personal(email: str) -> SimpleNamespace:
    return SimpleNamespace(name=email, project_type=Application.ProjectType.PERSONAL, created_by=email, deleted_at=None, cli_analytics_enabled=True)


async def _get_app(_session, name: str):
    app = _apps.get(name) or next((a for k, a in _apps.items() if k.lower() == name.lower()), None)
    return app


async def _ensure_personal(user_id: str, email: str) -> bool:
    _apps[email] = _personal(email)
    return True


@asynccontextmanager
async def _fake_session():
    yield object()


gate.application_repository = SimpleNamespace(aget_active_by_name_case_insensitive=_get_app)
gate.personal_project_service = SimpleNamespace(ensure_personal_project_async=_ensure_personal)
gate.get_async_session = _fake_session
gate._registrations = lambda remote: []

# ---- stubs: feature flags --------------------------------------------------------------------------------------
type(customer_config).is_feature_enabled = lambda self, name, *a, **k: True
type(customer_config).get_feature_setting = (
    lambda self, feature, key, default=None: ORGS if key == "corporateOrganizations" else default
)


def _email_of(request: Request) -> str:
    raw = request.cookies.get("codemie_access_token") or (request.headers.get("authorization") or "")[7:]
    if request.headers.get("x-e2e-user"):
        return request.headers["x-e2e-user"]
    payload = raw.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["email"]


async def _authenticate(request: Request) -> User:
    email = _email_of(request)
    user = User(id=email, username=email, name=email, email=email, project_names=[WORK_PROJECT], user_type="regular")
    request.state.user = user
    return user


app = FastAPI()
app.dependency_overrides[authenticate] = _authenticate

REQUEST_LOG: list[dict] = []  # X-CodeMie-* request headers of every ingest call (what the CLI actually put on the wire)
FAULTS: list[dict] = []  # SYNTHETIC canned responses for the next ingest calls (injected, never produced by the backend)


@app.middleware("http")
async def wire_log(request: Request, call_next):
    from fastapi.responses import JSONResponse, Response

    path = request.url.path
    if request.method == "POST" and "/cli-analytics/" in path and "/_e2e/" not in path:
        REQUEST_LOG.append(
            {
                "path": path.rsplit("/", 1)[-1],
                "session": request.headers.get("x-codemie-session-id"),
                "headers": {k: v for k, v in request.headers.items() if k.startswith("x-codemie-")},
            }
        )
        if FAULTS:
            fault = FAULTS.pop(0)
            if fault.get("sid") in (None, request.headers.get("x-codemie-session-id")):
                if fault.get("body") is None:
                    return Response(status_code=fault["status"], headers=fault.get("headers", {}))
                return JSONResponse(fault["body"], status_code=fault["status"], headers=fault.get("headers", {}))
            FAULTS.insert(0, fault)
    return await call_next(request)


@app.post("/_e2e/fault")
async def add_fault(request: Request) -> dict:
    FAULTS.append(await request.json())
    return {"queued": len(FAULTS)}


@app.get("/_e2e/requests")
async def requests_log(sid: str | None = None) -> list[dict]:
    return [r for r in REQUEST_LOG if sid is None or r["session"] == sid]


async def prefixed(scope, receive, send):
    """The deployment serves the API under /code-assistant-api (ingress strips it); do the same."""
    prefix = "/code-assistant-api"
    if scope["type"] == "http" and scope["path"].startswith(prefix):
        scope = dict(scope, path=scope["path"][len(prefix) :], raw_path=scope.get("raw_path", b"")[len(prefix) :])
    await app(scope, receive, send)
app.include_router(cli_analytics.router)


@app.get("/v1/user")
async def v1_user(request: Request) -> dict:
    return {"userId": _email_of(request), "name": _email_of(request)}


@app.post("/_e2e/contracts/{state}")
async def set_contracts(state: str) -> dict:
    config.CLI_ANALYTICS_PUBLICATION_CONTRACTS_ENABLED = state == "on"
    return {"contracts": config.CLI_ANALYTICS_PUBLICATION_CONTRACTS_ENABLED}


async def _rows(sql: str, *args):
    conn = await asyncpg.connect(PG_URL)
    try:
        await conn.execute(f"SET search_path TO {os.environ.get('CLI_ANALYTICS_PG_SCHEMA', 'codemie_analytics')}")
        return [dict(r) for r in await conn.fetch(sql, *args)]
    finally:
        await conn.close()


@app.get("/_e2e/session/{sid}")
async def session_row(sid: str) -> dict:
    """Stored facts of one session (direct SQL) plus row counts of what ingest wrote."""
    dims = await _rows(
        "SELECT session_id, jwt_email, owner_email, project_name, project_origin, subscription_type FROM session_dims "
        "WHERE session_id = $1",
        sid,
    )
    counts = {}
    for table in ("hook_events", "usage_requests", "log_events"):
        counts[table] = (await _rows(f"SELECT count(*) AS n FROM {table} WHERE session_id = $1", sid))[0]["n"]
    return {"dims": dims, "counts": counts, "log_events": sum(counts.values())}  # log_events: rows in all event tables


@app.get("/_e2e/visible/{sid}")
async def visible(sid: str, viewer: str, role: str = "owner", project: str = WORK_PROJECT) -> dict:
    """Whether the REAL reader lets `viewer` (owner | super | project_admin | other_admin) read the session."""
    reader = get_cli_analytics_storage().reader
    if role == "super":
        scope = ViewerScope(viewer_email=viewer, unrestricted=True, admin_projects=frozenset(), mode="detail")
    elif role == "project_admin":
        scope = ViewerScope(viewer_email=viewer, unrestricted=False, admin_projects=frozenset({project}), mode="detail")
    elif role == "other_admin":
        scope = ViewerScope(viewer_email=viewer, unrestricted=False, admin_projects=frozenset({"elsewhere"}), mode="detail")
    else:
        scope = ViewerScope(viewer_email=viewer, unrestricted=False, admin_projects=frozenset(), mode="detail")
    allowed = bool(await reader.authorize_session(sid, scope))
    return {"allowed": allowed}


@app.get("/_e2e/health")
async def health() -> dict:
    return {"ok": True}


@app.on_event("startup")
async def startup() -> None:
    """The backend's own startup: migrations plus the partitions ingest needs (never raises, logs on failure)."""
    await get_cli_analytics_storage().runtime.start()


if __name__ == "__main__":
    uvicorn.run(prefixed, host="127.0.0.1", port=int(os.environ.get("E2E_PORT", "8765")), log_level="warning")
