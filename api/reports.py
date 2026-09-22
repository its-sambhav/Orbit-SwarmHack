"""Generated-report store for the "Generate report" button on the Overview
and Map (India/State/District) pages.

A report is a frozen snapshot - the numbers on the page at the moment the
user clicked "Generate report", for a given scope/date-range/entity - not a
live link that changes later. This is a single-demo-instance prototype with
no auth/multi-tenant concerns, so a flat JSON file is the right amount of
persistence: durable across server restarts (unlike an in-memory list),
with no database setup for what will realistically be a handful of records.
"""
import json
import uuid
from datetime import datetime, timezone

from engine.paths import ROOT

REPORTS_PATH = ROOT / "data" / "reports.json"
REPORTS_DIR = ROOT / "data" / "reports"


def _load() -> list[dict]:
    if not REPORTS_PATH.exists():
        return []
    return json.loads(REPORTS_PATH.read_text(encoding="utf-8"))


def _save(reports: list[dict]) -> None:
    REPORTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORTS_PATH.write_text(json.dumps(reports, indent=2), encoding="utf-8")


def pdf_path(report_id: str):
    return REPORTS_DIR / f"{report_id}.pdf"


def list_reports() -> list[dict]:
    return sorted(_load(), key=lambda r: r["created_at"], reverse=True)


def get_report(report_id: str) -> dict | None:
    return next((r for r in _load() if r["id"] == report_id), None)


def create_report(fields: dict, pdf_bytes: bytes | None = None) -> dict:
    record = {
        "id": uuid.uuid4().hex[:12],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "has_pdf": bool(pdf_bytes),
        **fields,
    }
    if pdf_bytes:
        REPORTS_DIR.mkdir(parents=True, exist_ok=True)
        pdf_path(record["id"]).write_bytes(pdf_bytes)
    reports = _load()
    reports.append(record)
    _save(reports)
    return record


def delete_report(report_id: str) -> bool:
    reports = _load()
    kept = [r for r in reports if r["id"] != report_id]
    if len(kept) == len(reports):
        return False
    _save(kept)
    pdf_path(report_id).unlink(missing_ok=True)
    return True
