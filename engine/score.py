"""Stage 5: final severity, priority_score and routed_to (spec section 5).

Severity policy, in order:
1. a statistical finding is capped at `statistical_max_severity` (medium)
2. corroboration: if a work has work-level findings in >= 2 families
   (data_integrity never counts), its highest statistical finding goes up
   one step. MP-, district- and calamity-level findings are hung off one
   representative work, so they don't count toward that work's
   corroboration - that agreement would be an artefact of the anchoring.
3. reviewer feedback: a tag without enough validated precision can't be
   high; (tag, agency/state) patterns reviewers keep dismissing are
   suppressed (engine/validation.py)
A rule finding keeps the severity its detector gave it.

priority_score per finding = 100 * s * (0.5 + 0.5 * E), where
  s = severity_weight * confidence_factor (data_integrity capped at 0.05)
  E = clip(log10(exposure / 1e5) / 2, 0, 1)
engine/rollup.py combines a work's findings across families into its Risk.
"""
import math
from collections import defaultdict

import yaml

from engine.paths import CONFIG_DIR
from engine import validation

SEV_RANK = {"low": 0, "medium": 1, "high": 2}
SEVERITIES = ["low", "medium", "high"]


def load_routing() -> dict:
    with open(CONFIG_DIR / "routing.yaml", encoding="utf-8") as f:
        return yaml.safe_load(f)


def strength(severity: str, confidence: str, family: str, sc: dict) -> float:
    s = sc["severity_weight"][severity] * sc["confidence_factor"][confidence]
    if family == "data_integrity":
        s = min(s, sc["data_integrity_max_weight"])
    return s


def exposure_factor(exposure, sc: dict) -> float:
    if not exposure or exposure <= 0:
        return 0.0
    return min(1.0, max(0.0, math.log10(exposure / sc["exposure_base"]) / sc["exposure_decades"]))


def priority_score(finding: dict, sc: dict) -> float:
    s = strength(finding["severity"], finding["confidence"], finding["evidence"]["family"], sc)
    return round(100 * s * (0.5 + 0.5 * exposure_factor(finding["financial_exposure"], sc)), 3)


def work_key(f: dict) -> tuple:
    return f["work_number"], f["entities"]["scope_house"], f["entities"]["scope_tenure"]


def apply_severity_policy(findings: list[dict], cfg: dict, statuses: list[dict] | None = None) -> dict:
    sc, fb = cfg["scoring"], cfg["feedback"]
    cap = sc["statistical_max_severity"]
    excluded = set(sc["corroboration_excluded_families"])
    stats = {"capped": 0, "raised": 0, "feedback_capped": 0, "suppressed": 0}

    # 1. cap statistical findings
    for f in findings:
        if f["confidence"] == "statistical" and SEV_RANK[f["severity"]] > SEV_RANK[cap]:
            f["severity"] = cap
            stats["capped"] += 1

    # 2. corroboration across families on the same work
    by_work = defaultdict(list)
    for f in findings:
        by_work[work_key(f)].append(f)
    for fs in by_work.values():
        own = [f for f in fs if f["evidence"]["scope"] == "work" and f["evidence"]["family"] not in excluded]
        families = {f["evidence"]["family"] for f in own}
        if len(families) < sc["corroboration_min_families"]:
            continue
        candidates = [f for f in own if f["confidence"] == "statistical"]
        if not candidates:
            continue
        top = max(candidates, key=lambda f: (SEV_RANK[f["severity"]], f["financial_exposure"]))
        if top["severity"] != "high":
            top["severity"] = SEVERITIES[SEV_RANK[top["severity"]] + 1]
            top["evidence"]["corroborated_by"] = sorted(families - {top["evidence"]["family"]})
            stats["raised"] += 1

    # 3. reviewer feedback
    summary = validation.feedback_summary(findings, statuses or [])
    for f in findings:
        if f["severity"] == "high" and not validation.tag_may_be_high(f["tag"], summary, fb):
            f["severity"] = "medium"
            f["evidence"]["severity_capped_by"] = "reviewer feedback: tag precision not yet validated"
            stats["feedback_capped"] += 1
        reason = validation.suppression_reason(f, summary, fb)
        if reason:
            f["suppressed"] = True
            f["suppression_reason"] = reason
            stats["suppressed"] += 1
    stats["reviewed_tags"] = {t: s["reviewed"] for t, s in summary["tags"].items()}
    return stats


def route(finding: dict, routing_cfg: dict) -> dict:
    finding["routed_to"] = routing_cfg["routes"].get(finding["stage"], routing_cfg["default"])
    return finding


def run(findings: list[dict], cfg: dict) -> list[dict]:
    routing_cfg = load_routing()
    stats = apply_severity_policy(findings, cfg, validation.load_statuses())
    for f in findings:
        f["priority_score"] = priority_score(f, cfg["scoring"])
        route(f, routing_cfg)
    print(f"  severity policy: {stats['capped']:,} statistical capped at {cfg['scoring']['statistical_max_severity']}, "
          f"{stats['raised']:,} raised by corroboration, {stats['feedback_capped']:,} capped by feedback, "
          f"{stats['suppressed']:,} suppressed")
    print(f"  reviewed findings per tag: {stats['reviewed_tags'] or 'none yet'}")
    print(f"  scored + routed {len(findings):,} findings")
    return findings


if __name__ == "__main__":
    print(__doc__)
