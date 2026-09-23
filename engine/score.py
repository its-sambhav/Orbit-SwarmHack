"""Stage 5: final severity, strength, priority_score and routed_to (spec
section 5).

Each finding arrives with a label (low/medium/high) and a continuous
severity_score x in [0, 1] (engine/severity.py: the label is a band of x).
The policy below moves x, and the label is re-read from x, so the two never
disagree. In order:
1. a statistical finding is capped at `statistical_max_severity` (medium)
   by compressing, not clipping: everything above the medium band's centre
   is squeezed into the upper half of medium (compress_to). A P99.9 outlier
   still ends up above a P99 one, and a finding at the band centre keeps its
   old weight - clipping would have tied every capped finding on one value
2. corroboration: if a work has work-level findings in >= 2 families
   (data_integrity never counts), its strongest statistical finding goes up
   one band (x + 1/3). MP-, district- and calamity-level findings are hung
   off one representative work, so they don't count toward that work's
   corroboration - that agreement would be an artefact of the anchoring.
3. reviewer feedback: a tag without enough validated precision can't be
   high; (tag, agency/state) patterns reviewers keep dismissing are
   suppressed (engine/validation.py)
A rule finding keeps the severity its detector gave it.

strength s = severity_curve(x) * confidence_factor   (data_integrity capped)
E          = clip(log10(exposure / 1e5) / 2, 0, 1)
priority_score per finding = 100 * s * (0.5 + 0.5 * E)
Both s and priority_score are stored on the finding, so engine/rollup.py
reads s instead of recomputing it from the label.
"""
import math
from collections import defaultdict

import numpy as np
import yaml

from engine.paths import CONFIG_DIR
from engine import validation
from engine.severity import CENTRE, SEV_RANK, STEP, band_center, band_of, quantize, top_of


def load_routing() -> dict:
    with open(CONFIG_DIR / "routing.yaml", encoding="utf-8") as f:
        return yaml.safe_load(f)


def severity_score(finding: dict) -> float:
    """The finding's x; a finding built without one (older data, a test
    fixture) reads as the centre of its label's band."""
    x = finding.get("severity_score")
    return float(x) if x is not None and not (isinstance(x, float) and math.isnan(x)) else band_center(finding["severity"])


def curve_weight(x: float, sc: dict) -> float:
    """severity_curve: linear through (0, floor), the old fixed weight at
    each band's centre, and (1, ceiling). Without a curve in config, the old
    step weights."""
    curve = sc.get("severity_curve")
    w = sc["severity_weight"]
    if not curve:
        return w[band_of(x)]
    xs = [0.0, CENTRE["low"], CENTRE["medium"], CENTRE["high"], 1.0]
    ys = [curve["floor"], w["low"], w["medium"], w["high"], curve["ceiling"]]
    return float(np.interp(x, xs, ys))


def strength(severity, confidence: str, family: str, sc: dict) -> float:
    """`severity` is either a severity_score (float) or a label - a label is
    read as its band centre, which the curve maps to the old fixed weight."""
    x = band_center(severity) if isinstance(severity, str) else float(severity)
    s = curve_weight(x, sc) * sc["confidence_factor"][confidence]
    if family == "data_integrity":
        s = min(s, sc["data_integrity_max_weight"])
    return s


def exposure_factor(exposure, sc: dict) -> float:
    if not exposure or exposure <= 0:
        return 0.0
    return min(1.0, max(0.0, math.log10(exposure / sc["exposure_base"]) / sc["exposure_decades"]))


def finding_strength(finding: dict, sc: dict) -> float:
    return strength(severity_score(finding), finding["confidence"], finding["evidence"]["family"], sc)


def priority_score(finding: dict, sc: dict) -> float:
    s = finding_strength(finding, sc)
    return round(100 * s * (0.5 + 0.5 * exposure_factor(finding["financial_exposure"], sc)), 3)


def work_key(f: dict) -> tuple:
    return f["work_number"], f["entities"]["scope_house"], f["entities"]["scope_tenure"]


def compress_to(x: float, label: str) -> float:
    """Monotone map of [0, 1] into [0, top of `label`]: identity up to the
    band's centre, then the rest of [centre, 1] squeezed linearly into
    [centre, top of band]. Order is kept, nothing ties at the cap."""
    c, top = band_center(label), top_of(label)
    return x if x <= c else c + (x - c) * (top - c) / (1.0 - c)


def _set(f: dict, x: float) -> None:
    f["severity_score"] = quantize(x)
    f["severity"] = band_of(f["severity_score"])


def apply_severity_policy(findings: list[dict], cfg: dict, statuses: list[dict] | None = None) -> dict:
    sc, fb = cfg["scoring"], cfg["feedback"]
    cap_label = sc["statistical_max_severity"]
    excluded = set(sc["corroboration_excluded_families"])
    stats = {"capped": 0, "raised": 0, "feedback_capped": 0, "suppressed": 0}
    for f in findings:
        f["severity_score"] = severity_score(f)

    # 1. cap statistical findings (compress into the cap band, keep order)
    for f in findings:
        if f["confidence"] == "statistical" and f["severity_score"] > band_center(cap_label):
            if SEV_RANK[f["severity"]] > SEV_RANK[cap_label]:
                stats["capped"] += 1
            _set(f, compress_to(f["severity_score"], cap_label))

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
        top = max(candidates, key=lambda f: (f["severity_score"], f["financial_exposure"]))
        if top["severity"] != "high":
            _set(top, min(1.0, top["severity_score"] + STEP))
            top["evidence"]["corroborated_by"] = sorted(families - {top["evidence"]["family"]})
            stats["raised"] += 1

    # 3. reviewer feedback
    summary = validation.feedback_summary(findings, statuses or [])
    for f in findings:
        if f["severity"] == "high" and not validation.tag_may_be_high(f["tag"], summary, fb):
            _set(f, compress_to(f["severity_score"], "medium"))
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
    sc = cfg["scoring"]
    stats = apply_severity_policy(findings, cfg, validation.load_statuses())
    for f in findings:
        f["strength"] = round(finding_strength(f, sc), 5)
        f["priority_score"] = round(100 * f["strength"] * (0.5 + 0.5 * exposure_factor(f["financial_exposure"], sc)), 3)
        route(f, routing_cfg)
    print(f"  severity policy: {stats['capped']:,} statistical capped at {sc['statistical_max_severity']}, "
          f"{stats['raised']:,} raised by corroboration, {stats['feedback_capped']:,} capped by feedback, "
          f"{stats['suppressed']:,} suppressed")
    print(f"  reviewed findings per tag: {stats['reviewed_tags'] or 'none yet'}")
    print(f"  scored + routed {len(findings):,} findings")
    return findings


if __name__ == "__main__":
    print(__doc__)
