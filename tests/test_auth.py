"""Access control: every data route needs a session, national routes need
MoSPI, the entity-picker token reads only its role's pick list, and repeated
wrong passwords lock out. None of these need the data store - every refusal
here happens in the auth dependency, before an endpoint body runs."""
import re

import pytest
from fastapi.testclient import TestClient

from api import auth
from api import main
from api.main import app, allowed_states, _owns_report, _scoped_digest

client = TestClient(app)  # no `with`: skips lifespan, so the store never loads

MOSPI = {"role": "mospi", "entity": None}
STATE = {"role": "state", "entity": "Bihar"}
DISTRICT = {"role": "district", "entity": "Bihar|Patna"}
AGENCY = {"role": "agency", "entity": "PWD"}


@pytest.fixture(autouse=True)
def fresh_limiter():
    auth._failures.clear()
    auth._hits.clear()
    yield
    auth._failures.clear()
    auth._hits.clear()


def bearer(claims: dict, purpose: str = "session") -> dict:
    return {"Authorization": f"Bearer {auth.issue_token(claims['role'], claims['entity'], purpose)}"}


def data_routes():
    """(method, path) for every API route but sign-in and the health check,
    path parameters filled with a placeholder."""
    for r in app.routes:
        path = getattr(r, "path", "")
        if not path.startswith("/api/") or path == "/api/auth/login":
            continue
        for method in r.methods - {"HEAD", "OPTIONS"}:
            yield method, re.sub(r"\{[^}]+\}", "x", path)


@pytest.mark.parametrize("method,path", sorted(data_routes()))
def test_every_data_route_needs_a_session(method, path):
    assert client.request(method, path).status_code == 401


@pytest.mark.parametrize("method,path", sorted(data_routes()))
def test_a_picker_token_is_not_a_session(method, path):
    picker = bearer(STATE, purpose="picker")
    status = client.request(method, path, headers=picker).status_code
    # the pick lists answer it (or refuse it by list) - nothing else lets it in
    if path in ("/api/states", "/api/districts", "/api/mps", "/api/agencies"):
        assert status != 401
    else:
        assert status == 401


def test_forged_and_expired_tokens_are_refused(monkeypatch):
    token = auth.issue_token("mospi", None)
    payload, sig = token.split(".")
    assert client.get("/api/meta", headers={"Authorization": f"Bearer {payload}.{'0' * len(sig)}"}).status_code == 401
    monkeypatch.setattr(auth, "TOKEN_TTL_SECONDS", -1)
    assert client.get("/api/meta", headers=bearer(MOSPI)).status_code == 401


def test_a_non_mospi_session_must_name_its_entity():
    assert client.get("/api/meta", headers=bearer({"role": "state", "entity": None})).status_code == 401


@pytest.mark.parametrize("path", ["/api/funnel", "/api/analytics", "/api/queue"])
def test_national_routes_are_mospi_only(path):
    for claims in (STATE, DISTRICT, AGENCY):
        assert client.get(path, headers=bearer(claims)).status_code == 403


@pytest.mark.parametrize("path", ["/api/states", "/api/mps", "/api/agencies"])
def test_national_pick_lists_refuse_other_sessions(path):
    assert client.get(path, headers=bearer(STATE)).status_code == 403


def test_a_picker_reads_only_its_own_roles_list():
    assert client.get("/api/mps", headers=bearer(STATE, purpose="picker")).status_code == 403
    assert client.get("/api/agencies", headers=bearer({"role": "mp", "entity": None}, "picker")).status_code == 403


def test_districts_are_limited_to_the_callers_state():
    assert client.get("/api/districts?state=Kerala", headers=bearer(STATE)).status_code == 403
    assert client.get("/api/districts?state=Kerala", headers=bearer(DISTRICT)).status_code == 403
    assert client.get("/api/districts?state=Kerala", headers=bearer(AGENCY)).status_code == 403


def test_login_issues_a_picker_token_until_an_entity_is_picked():
    res = client.post("/api/auth/login", json={"role": "state", "password": "state-2026"}).json()
    assert res["needs_entity"] and "token" not in res
    assert auth._decode_token(res["picker_token"])["purpose"] == "picker"
    res = client.post("/api/auth/login", json={"role": "state", "password": "state-2026", "entity": "Bihar"}).json()
    assert auth._decode_token(res["token"])["entity"] == "Bihar"


def test_repeated_wrong_passwords_lock_the_role_out():
    for _ in range(auth.LOGIN_MAX_FAILURES):
        assert client.post("/api/auth/login", json={"role": "mospi", "password": "guess"}).status_code == 401
    locked = client.post("/api/auth/login", json={"role": "mospi", "password": "mospi-2026"})
    assert locked.status_code == 429 and int(locked.headers["Retry-After"]) > 0
    # a different role is counted separately
    assert client.post("/api/auth/login", json={"role": "mp", "password": "mp-2026"}).status_code == 200


def test_a_good_password_clears_earlier_failures():
    for _ in range(auth.LOGIN_MAX_FAILURES - 1):
        client.post("/api/auth/login", json={"role": "mospi", "password": "guess"})
    assert client.post("/api/auth/login", json={"role": "mospi", "password": "mospi-2026"}).status_code == 200
    assert client.post("/api/auth/login", json={"role": "mospi", "password": "guess"}).status_code == 401


def test_an_environment_password_replaces_the_demo_one(monkeypatch):
    monkeypatch.setenv("AUTH_PASSWORD_MOSPI", "a-real-secret")
    assert not auth.verify_password("mospi", "mospi-2026")
    assert auth.verify_password("mospi", "a-real-secret")


def test_allowed_states():
    assert allowed_states(MOSPI) is None
    assert allowed_states(STATE) == {"bihar"}
    assert allowed_states(DISTRICT) == {"bihar"}
    assert allowed_states(AGENCY) == set()


def test_reports_belong_to_their_creator():
    mine = {"created_by": {"role": "state", "entity": "Bihar"}}
    legacy = {}  # made before reports recorded a creator
    assert _owns_report(STATE, mine) and _owns_report(MOSPI, mine)
    assert not _owns_report({"role": "state", "entity": "Kerala"}, mine)
    assert not _owns_report(STATE, legacy) and _owns_report(MOSPI, legacy)


def test_alert_digest_is_cut_to_the_callers_jurisdiction():
    digest = {
        "total_findings_this_run": 9,
        "national": {"new_high_severity_count": 3, "total_financial_exposure": 5.0, "tag_counts": {"x": 3},
                     "top_findings": [{"finding_id": "a"}]},
        "by_state": [
            {"state": "Bihar", "new_high_severity_count": 2, "total_financial_exposure": 4.0, "tag_counts": {},
             "top_findings": [{"finding_id": "p", "district": "Patna"}, {"finding_id": "g", "district": "Gaya"}]},
            {"state": "Kerala", "new_high_severity_count": 1, "total_financial_exposure": 1.0, "tag_counts": {},
             "top_findings": [{"finding_id": "k", "district": "Kochi"}]},
        ],
    }
    assert _scoped_digest(digest, MOSPI) == digest
    state = _scoped_digest(digest, STATE)
    assert [s["state"] for s in state["by_state"]] == ["Bihar"] and state["national"]["top_findings"] == []
    district = _scoped_digest(digest, DISTRICT)
    assert [f["finding_id"] for f in district["by_state"][0]["top_findings"]] == ["p"]
    assert "total_financial_exposure" not in district["by_state"][0]
    assert _scoped_digest(digest, AGENCY)["by_state"] == []


def test_cors_allows_only_configured_origins():
    assert "*" not in main.CORS_ORIGINS


def test_rate_limit_is_per_client_and_per_bucket():
    from fastapi import HTTPException
    for _ in range(3):
        auth.check_rate("t", "1.2.3.4", limit=3, window=60)
    with pytest.raises(HTTPException) as err:
        auth.check_rate("t", "1.2.3.4", limit=3, window=60)
    assert err.value.status_code == 429 and int(err.value.headers["Retry-After"]) > 0
    auth.check_rate("t", "5.6.7.8", limit=3, window=60)       # another client: unaffected
    auth.check_rate("other", "1.2.3.4", limit=3, window=60)   # another bucket: unaffected


def test_translate_endpoint_is_rate_limited():
    # lang "en" returns at once without calling the LLM, so this is cheap
    headers = bearer(MOSPI)
    for _ in range(120):
        assert client.post("/api/translate", json={"lang": "en", "texts": ["x"]}, headers=headers).status_code == 200
    res = client.post("/api/translate", json={"lang": "en", "texts": ["x"]}, headers=headers)
    assert res.status_code == 429 and res.json()["detail"] == auth.TOO_MANY_REQUESTS
