"""Validation and reviewer feedback (spec section 7).

- per-tag precision = verified / (verified + dismissed), from the officer
  verdicts api/finding_status.py stores in data/finding_status.json
- Wilson lower bound on that precision decides whether a tag may keep "high"
- (tag, agency) and (tag, state) patterns that reviewers keep dismissing get
  suppressed, with the reason on the finding
- a regression snapshot fails the run when the finding total moves > 20%
  with no config change
- a hand-check sheet of random findings with blank label columns, and
  precision@100 per tag once someone has filled it in

    python -m engine.validation precision reports/hand_check_sheet.csv
"""
import csv
import hashlib
import json
import math
import random
import sys
from collections import defaultdict

from engine.paths import CONFIG_DIR, DATA_FINDINGS, ROOT

FINDING_STATUS_PATH = ROOT / "data" / "finding_status.json"
SNAPSHOT_PATH = DATA_FINDINGS / "_regression_snapshot.json"
REPORTS_DIR = ROOT / "reports"


def wilson_lower_bound(k: int, n: int, z: float = 1.96) -> float | None:
    """Lower end of the Wilson score interval for k successes in n trials."""
    if n <= 0:
        return None
    p = k / n
    denom = 1 + z * z / n
    centre = p + z * z / (2 * n)
    spread = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (centre - spread) / denom


def load_statuses() -> list[dict]:
    if not FINDING_STATUS_PATH.exists():
        return []
    return json.loads(FINDING_STATUS_PATH.read_text(encoding="utf-8"))


def feedback_summary(findings: list[dict], statuses: list[dict]) -> dict:
    """Joins each verdict to the finding it was given on (by finding_id) and
    tallies per tag and per (tag, agency) / (tag, state). Verdicts on
    findings that no longer exist are ignored. `under_investigation` is not
    a verdict and doesn't count."""
    by_id = {f["finding_id"]: f for f in findings}
    per_tag = defaultdict(lambda: {"verified": 0, "dismissed": 0})
    per_pattern = defaultdict(lambda: {"verified": 0, "dismissed": 0})
    for s in statuses:
        f = by_id.get(s["finding_id"])
        if f is None or s["status"] not in ("verified", "dismissed"):
            continue
        per_tag[f["tag"]][s["status"]] += 1
        for kind, entity in (("agency", f["entities"].get("implementing_agency")),
                             ("state", f["entities"].get("state"))):
            if entity:
                per_pattern[(f["tag"], kind, entity)][s["status"]] += 1
    tags = {}
    for tag, c in per_tag.items():
        n = c["verified"] + c["dismissed"]
        tags[tag] = {**c, "reviewed": n, "precision": c["verified"] / n if n else None,
                     "wilson_lower_bound": wilson_lower_bound(c["verified"], n)}
    patterns = {}
    for key, c in per_pattern.items():
        n = c["verified"] + c["dismissed"]
        patterns[key] = {**c, "reviewed": n, "dismissal_rate": c["dismissed"] / n if n else None}
    return {"tags": tags, "patterns": patterns}


def tag_may_be_high(tag: str, summary: dict, fb_cfg: dict) -> bool:
    s = summary["tags"].get(tag)
    reviewed = s["reviewed"] if s else 0
    if reviewed >= fb_cfg["min_reviews_for_high"]:
        return s["wilson_lower_bound"] >= fb_cfg["min_wilson_lower_bound"]
    return not fb_cfg.get("require_validation_for_high", False)


def suppression_reason(finding: dict, summary: dict, fb_cfg: dict) -> str | None:
    for kind, entity in (("agency", finding["entities"].get("implementing_agency")),
                         ("state", finding["entities"].get("state"))):
        p = summary["patterns"].get((finding["tag"], kind, entity))
        if p and p["reviewed"] >= fb_cfg["suppression_min_reviews"] \
                and p["dismissal_rate"] >= fb_cfg["suppression_min_dismissal_rate"]:
            return (f"Reviewers dismissed {p['dismissed']} of {p['reviewed']} '{finding['tag']}' findings "
                    f"for {kind} {entity}")
    return None


# ---------------------------------------------------------------------------
# regression snapshot
# ---------------------------------------------------------------------------
def config_hash() -> str:
    h = hashlib.sha256()
    for name in ("detectors.yaml", "tags.yaml"):
        h.update((CONFIG_DIR / name).read_bytes())
    return h.hexdigest()[:16]


def per_tag_counts(findings: list[dict]) -> dict:
    counts: dict = defaultdict(int)
    for f in findings:
        counts[f["tag"]] += 1
    return dict(sorted(counts.items()))


def regression_check(findings: list[dict], max_change: float) -> dict:
    """Fails (RuntimeError) if the total moved more than max_change since the
    last run while the config stayed the same. A config change re-baselines."""
    current = {"config_hash": config_hash(), "total": len(findings), "per_tag": per_tag_counts(findings)}
    previous = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8")) if SNAPSHOT_PATH.exists() else None
    if previous and previous["config_hash"] == current["config_hash"] and previous["total"]:
        change = abs(current["total"] - previous["total"]) / previous["total"]
        if change > max_change:
            raise RuntimeError(
                f"regression check: findings moved {change:.0%} ({previous['total']:,} -> {current['total']:,}) "
                f"with no config change - investigate the data before trusting this run "
                f"(delete {SNAPSHOT_PATH.name} to accept the new baseline)")
        print(f"  regression check: total {previous['total']:,} -> {current['total']:,} ({change:.1%}), same config - ok")
    elif previous:
        print(f"  regression check: config changed - new baseline ({current['total']:,} findings)")
    else:
        print(f"  regression check: first snapshot ({current['total']:,} findings)")
    SNAPSHOT_PATH.write_text(json.dumps(current, indent=2), encoding="utf-8")
    return current


# ---------------------------------------------------------------------------
# hand-check sheet
# ---------------------------------------------------------------------------
SHEET_COLUMNS = ["finding_id", "tag", "severity", "confidence", "work_number", "scope_tenure", "state",
                 "district", "financial_exposure", "deviation", "label_correct", "reviewer_note"]


def export_hand_check_sheet(findings: list[dict], cfg: dict, path=None) -> str:
    v = cfg["validation"]
    rng = random.Random(v["hand_check_seed"])
    live = [f for f in findings if not f["suppressed"]]
    high = [f for f in live if f["severity"] == "high"]
    other = [f for f in live if f["severity"] != "high"]
    sample = (rng.sample(high, min(v["hand_check_n_high"], len(high)))
              + rng.sample(other, min(v["hand_check_n_other"], len(other))))
    REPORTS_DIR.mkdir(exist_ok=True)
    path = path or REPORTS_DIR / "hand_check_sheet.csv"
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=SHEET_COLUMNS)
        w.writeheader()
        for f in sample:
            w.writerow({
                "finding_id": f["finding_id"], "tag": f["tag"], "severity": f["severity"],
                "confidence": f["confidence"], "work_number": f["work_number"],
                "scope_tenure": f["entities"]["scope_tenure"], "state": f["entities"]["state"],
                "district": f["entities"]["district"], "financial_exposure": round(f["financial_exposure"], 2),
                "deviation": f["evidence"]["deviation"], "label_correct": "", "reviewer_note": "",
            })
    print(f"  hand-check sheet: {len(sample)} findings -> {path}")
    return str(path)


def precision_at_k(sheet_path) -> dict:
    """Per-tag precision over the rows someone has labelled (label_correct =
    yes/no, y/n, 1/0, true/false). Unlabelled rows are skipped."""
    yes, no = {"yes", "y", "1", "true"}, {"no", "n", "0", "false"}
    tally = defaultdict(lambda: [0, 0])
    with open(sheet_path, encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            label = (row.get("label_correct") or "").strip().lower()
            if label in yes:
                tally[row["tag"]][0] += 1
            elif label in no:
                tally[row["tag"]][1] += 1
    return {tag: {"correct": c, "wrong": w, "labelled": c + w, "precision": c / (c + w) if c + w else None}
            for tag, (c, w) in sorted(tally.items())}


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "precision":
        for tag, r in precision_at_k(sys.argv[2]).items():
            p = f"{r['precision']:.2f}" if r["precision"] is not None else "n/a"
            print(f"  {tag:45} precision {p}  ({r['correct']}/{r['labelled']} labelled)")
    else:
        print(__doc__)
