"""Post-pipeline alert digest - the "generate risk-based alerts" half of
SIH26102's ask that no endpoint in this codebase covers on its own: every
other route is pull-based (an official has to think to open the
dashboard). This writes a digest of newly-surfaced high-severity findings
after every pipeline run - the one push-shaped artifact here, even though
"push" today means "a file a scheduled job could email/webhook from"
rather than an actual send, since no SMTP/webhook credentials exist for
this prototype.

"New" = severity=="high" this run AND not present in the *previous* run's
finding_id set. Severity is a percentile-gated, recomputed-every-run
quantity (engine/detectors.py's dynamic_gate), so a work can technically
flip in/out of "high" between runs even with no real change to that work
if the surrounding population shifted - "new" here means "newly present in
this run's high-severity set," a reasonable proxy, not a perfectly stable
ground truth.
"""
import json
from datetime import datetime, timezone
from pathlib import Path

from engine.paths import DATA_ALERTS, DATA_FINDINGS

NATIONAL_TOP_N = 50
STATE_TOP_N = 10


def load_previous_finding_ids() -> set[str] | None:
    """Reads the findings.jsonl this run's own export.write_findings() is
    about to overwrite - MUST be called before that happens. Returns None
    on the very first-ever pipeline run (no prior file to diff against)."""
    path = DATA_FINDINGS / "findings.jsonl"
    if not path.exists():
        return None
    ids = set()
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                ids.add(json.loads(line)["finding_id"])
    return ids


def _tag_counts(findings: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for f in findings:
        counts[f["tag"]] = counts.get(f["tag"], 0) + 1
    return counts


def _top_findings(findings: list[dict], n: int) -> list[dict]:
    ranked = sorted(findings, key=lambda f: f["financial_exposure"], reverse=True)[:n]
    return [{
        "finding_id": f["finding_id"], "work_number": f["work_number"], "detector": f["detector"],
        "tag": f["tag"], "severity": f["severity"], "financial_exposure": f["financial_exposure"],
        "state": f["entities"].get("state"), "district": f["entities"].get("district"),
        "mp_name": f["entities"].get("mp_name"),
    } for f in ranked]


def build_digest(findings: list[dict], previous_ids: set[str] | None, as_of_date: str) -> dict:
    is_first_run = previous_ids is None
    prev = previous_ids or set()
    new_high = [f for f in findings if f["severity"] == "high" and f["finding_id"] not in prev]

    by_state: dict[str, list[dict]] = {}
    for f in new_high:
        state = f["entities"].get("state")
        if state:
            by_state.setdefault(state, []).append(f)

    state_sections = [{
        "state": state,
        "new_high_severity_count": len(items),
        "total_financial_exposure": sum(i["financial_exposure"] for i in items),
        "tag_counts": _tag_counts(items),
        "top_findings": _top_findings(items, STATE_TOP_N),
    } for state, items in by_state.items()]
    state_sections.sort(key=lambda s: s["total_financial_exposure"], reverse=True)

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "as_of_date": as_of_date,
        "is_first_run": is_first_run,
        "total_findings_this_run": len(findings),
        "national": {
            "new_high_severity_count": len(new_high),
            "total_financial_exposure": sum(f["financial_exposure"] for f in new_high),
            "tag_counts": _tag_counts(new_high),
            "top_findings": _top_findings(new_high, NATIONAL_TOP_N),
        },
        "by_state": state_sections,
    }


def write_digest(digest: dict) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = DATA_ALERTS / f"digest_{stamp}.json"
    text = json.dumps(digest, indent=2, default=str)
    path.write_text(text, encoding="utf-8")
    (DATA_ALERTS / "latest.json").write_text(text, encoding="utf-8")
    print(f"  wrote alert digest ({digest['national']['new_high_severity_count']:,} new high-severity findings) -> {path.name}")
    return path


def run(findings: list[dict], previous_ids: set[str] | None, as_of_date: str) -> dict:
    digest = build_digest(findings, previous_ids, as_of_date)
    write_digest(digest)
    return digest
