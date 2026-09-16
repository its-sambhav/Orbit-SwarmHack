"""Officer-set review status for a finding - the first mutable, reviewer-
driven annotation in this codebase. Every other field on a finding
(severity, routed_to, suppressed) is computed once by the offline pipeline
and read-only at serve time; this is deliberately separate from that data.

Same "flat JSON file" precedent as api/reports.py, for the same reason: a
single-demo-instance prototype with no auth/multi-tenant concerns, and
realistically a handful to a few hundred reviewed findings - a database is
more machinery than this needs.
"""
import json
from datetime import datetime, timezone

from engine.paths import ROOT

FINDING_STATUS_PATH = ROOT / "data" / "finding_status.json"

STATUSES = ("verified", "dismissed", "under_investigation")


def _load() -> list[dict]:
    if not FINDING_STATUS_PATH.exists():
        return []
    return json.loads(FINDING_STATUS_PATH.read_text())


def _save(statuses: list[dict]) -> None:
    FINDING_STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
    FINDING_STATUS_PATH.write_text(json.dumps(statuses, indent=2))


def list_statuses() -> list[dict]:
    return sorted(_load(), key=lambda r: r["updated_at"], reverse=True)


def get_status(finding_id: str) -> dict | None:
    return next((r for r in _load() if r["finding_id"] == finding_id), None)


def set_status(
    finding_id: str, work_number: str, scope_house: str, scope_tenure: str,
    status: str, reviewer_name: str, note: str | None = None,
) -> dict:
    record = {
        "finding_id": finding_id,
        "work_number": work_number,
        "scope_house": scope_house,
        "scope_tenure": scope_tenure,
        "status": status,
        "reviewer_name": reviewer_name,
        "note": note,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    statuses = _load()
    kept = [r for r in statuses if r["finding_id"] != finding_id]
    kept.append(record)
    _save(kept)
    return record
