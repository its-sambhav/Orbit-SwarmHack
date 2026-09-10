"""Stage 4: Group A detectors. Pure rule checks over the lifecycle spine.

10 finding-type IDs from 8 logical detectors (TEMPORAL_IMPOSSIBLE is split into
3 - see docs/SCHEMA.md / the plan's C3 - to avoid colliding finding_ids when a
work trips more than one sub-check). confidence is always "rule" and
peer_benchmark is always null in this slice - every detector here is a
deterministic guideline check, none are peer-relative.
"""
import yaml
import pandas as pd

from engine.paths import CONFIG_DIR, DATA_PROCESSED

WORK_KEY = ["WORK_RECOMMENDATION_DTL_ID", "SCOPE_HOUSE", "SCOPE_TENURE"]


def load_config() -> dict:
    with open(CONFIG_DIR / "detectors.yaml") as f:
        return yaml.safe_load(f)


def prepare_spine(spine: pd.DataFrame, cfg: dict) -> pd.DataFrame:
    as_of = pd.Timestamp(cfg["as_of_date"])
    # NaT arithmetic -> NaN, and NaN > threshold is False, so every mask below
    # self-excludes rows missing the dates it needs with no special-casing.
    spine["age_since_recommendation"] = (as_of - spine["rec_RECOMMENDATION_DATE"]).dt.days
    spine["age_since_sanction"] = (as_of - spine["SANCTION_DATE"]).dt.days
    spine["sanction_delay_days"] = (spine["SANCTION_DATE"] - spine["rec_RECOMMENDATION_DATE"]).dt.days
    spine["execution_delay_days"] = (spine["comp_ACTUAL_END_DATE"] - spine["SANCTION_DATE"]).dt.days
    return spine


def bucket_severity(value: float, buckets: list[dict]) -> str:
    for b in buckets:
        if b["max_days"] is None or value <= b["max_days"]:
            return b["severity"]
    return buckets[-1]["severity"]


def iso(ts) -> str | None:
    return ts.date().isoformat() if pd.notna(ts) else None


def build_finding(row, detector_id, tag, severity, financial_exposure,
                   observed, threshold, deviation, stage, peer_benchmark=None) -> dict:
    return {
        "finding_id": f"{detector_id}:{int(row.WORK_RECOMMENDATION_DTL_ID)}:{row.SCOPE_HOUSE}:{row.SCOPE_TENURE}",
        "work_number": str(int(row.WORK_RECOMMENDATION_DTL_ID)),
        "detector": detector_id,
        "tag": tag,
        "severity": severity,
        "confidence": "rule",
        "financial_exposure": float(financial_exposure) if pd.notna(financial_exposure) else 0.0,
        "evidence": {
            "observed": observed,
            "threshold": threshold,
            "peer_benchmark": peer_benchmark,
            "deviation": deviation,
        },
        "entities": {
            "state": row.STATE_NAME if pd.notna(row.STATE_NAME) else None,
            "constituency": row.CONSTITUENCY if pd.notna(row.CONSTITUENCY) else None,
            "constituency_id": int(row.CONSTITUENCY_ID) if pd.notna(row.CONSTITUENCY_ID) else None,
            "district": None,
            "lgd_code": None,
            "mp_name": row.MP_NAME if pd.notna(row.MP_NAME) else None,
            "implementing_agency": row.IDA_NAME_CLEAN if pd.notna(row.IDA_NAME_CLEAN) else None,
            "vendor": row.exp_top_vendor if row.has_expenditure and pd.notna(row.exp_top_vendor) else None,
            "vendor_count": int(row.exp_vendor_count) if row.has_expenditure and pd.notna(row.exp_vendor_count) else 0,
            "scope_house": row.SCOPE_HOUSE,
            "scope_tenure": row.SCOPE_TENURE,
        },
        "suppressed": False,
        "suppression_reason": None,
        "routed_to": None,   # filled by score.py
        "stage": stage,
    }


def _emit(spine: pd.DataFrame, mask: pd.Series, **kwargs_per_row) -> list[dict]:
    """Build one finding per masked row. kwargs_per_row values are either
    constants or callables(row) -> value."""
    findings = []
    for row in spine.loc[mask.fillna(False)].itertuples():
        resolved = {k: (v(row) if callable(v) else v) for k, v in kwargs_per_row.items()}
        findings.append(build_finding(row, **resolved))
    return findings


def detect_stalled_at_sanction(spine, cfg):
    c = cfg["detectors"]["STALLED_AT_SANCTION"]
    mask = spine.has_recommended & ~spine.has_sanctioned & (spine.age_since_recommendation > c["guideline_days"])
    return _emit(spine, mask,
        detector_id="STALLED_AT_SANCTION", tag=c["tag"], stage="sanction",
        severity=lambda r: bucket_severity(r.age_since_recommendation, c["severity_buckets"]),
        financial_exposure=lambda r: r.rec_RECOMMENDED_AMOUNT,
        observed=lambda r: {"days_since_recommendation": int(r.age_since_recommendation)},
        threshold=lambda r: {"guideline_days": c["guideline_days"], "source": c["guideline_source"]},
        deviation=lambda r: f"{int(r.age_since_recommendation)} days since recommendation, "
                             f"never sanctioned (guideline: {c['guideline_days']} days)")


def detect_sanction_delay(spine, cfg):
    c = cfg["detectors"]["SANCTION_DELAY"]
    mask = spine.has_sanctioned & spine.has_recommended & (spine.sanction_delay_days > c["guideline_days"])
    return _emit(spine, mask,
        detector_id="SANCTION_DELAY", tag=c["tag"], stage="sanction",
        severity=lambda r: bucket_severity(r.sanction_delay_days, c["severity_buckets"]),
        financial_exposure=lambda r: r.SANCTION_AMOUNT,
        observed=lambda r: {"sanction_delay_days": int(r.sanction_delay_days)},
        threshold=lambda r: {"guideline_days": c["guideline_days"], "source": c["guideline_source"]},
        deviation=lambda r: f"sanctioned {int(r.sanction_delay_days)} days after recommendation "
                             f"(guideline: {c['guideline_days']} days)")


def detect_stalled_at_execution(spine, cfg):
    c = cfg["detectors"]["STALLED_AT_EXECUTION"]
    mask = spine.has_sanctioned & ~spine.has_completed & (spine.age_since_sanction > c["guideline_days"])
    return _emit(spine, mask,
        detector_id="STALLED_AT_EXECUTION", tag=c["tag"], stage="execution",
        severity=lambda r: bucket_severity(r.age_since_sanction, c["severity_buckets"]),
        financial_exposure=lambda r: r.SANCTION_AMOUNT,
        observed=lambda r: {"days_since_sanction": int(r.age_since_sanction)},
        threshold=lambda r: {"guideline_days": c["guideline_days"], "source": c["guideline_source"]},
        deviation=lambda r: f"{int(r.age_since_sanction)} days since sanction, never completed "
                             f"(guideline: {c['guideline_days']} days)")


def detect_execution_delay(spine, cfg):
    c = cfg["detectors"]["EXECUTION_DELAY"]
    mask = spine.has_completed & spine.has_sanctioned & (spine.execution_delay_days > c["guideline_days"])
    return _emit(spine, mask,
        detector_id="EXECUTION_DELAY", tag=c["tag"], stage="execution",
        severity=lambda r: bucket_severity(r.execution_delay_days, c["severity_buckets"]),
        financial_exposure=lambda r: r.comp_ACTUAL_AMOUNT,
        observed=lambda r: {"execution_delay_days": int(r.execution_delay_days)},
        threshold=lambda r: {"guideline_days": c["guideline_days"], "source": c["guideline_source"]},
        deviation=lambda r: f"completed {int(r.execution_delay_days)} days after sanction "
                             f"(guideline: {c['guideline_days']} days)")


def detect_temporal_impossible(spine, cfg):
    """3 independent sub-checks, each its own detector_id/finding - a work can
    trip more than one, and bundling them would collide finding_id and blur
    which specific rule was violated."""
    out = []

    c = cfg["detectors"]["TEMPORAL_SANCTION_BEFORE_RECOMMENDATION"]
    mask = spine.has_sanctioned & spine.has_recommended & (spine.SANCTION_DATE < spine.rec_RECOMMENDATION_DATE)
    out += _emit(spine, mask,
        detector_id="TEMPORAL_SANCTION_BEFORE_RECOMMENDATION", tag=c["tag"], severity=c["severity"],
        stage="sanction", financial_exposure=lambda r: r.SANCTION_AMOUNT,
        observed=lambda r: {"sanction_date": iso(r.SANCTION_DATE), "recommendation_date": iso(r.rec_RECOMMENDATION_DATE)},
        threshold=lambda r: {"source": c["guideline_source"]},
        deviation=lambda r: f"sanctioned {iso(r.SANCTION_DATE)} but recommended later, {iso(r.rec_RECOMMENDATION_DATE)}")

    c = cfg["detectors"]["TEMPORAL_COMPLETION_BEFORE_SANCTION"]
    mask = spine.has_completed & spine.has_sanctioned & (spine.comp_ACTUAL_END_DATE < spine.SANCTION_DATE)
    out += _emit(spine, mask,
        detector_id="TEMPORAL_COMPLETION_BEFORE_SANCTION", tag=c["tag"], severity=c["severity"],
        stage="execution", financial_exposure=lambda r: r.comp_ACTUAL_AMOUNT,
        observed=lambda r: {"actual_end_date": iso(r.comp_ACTUAL_END_DATE), "sanction_date": iso(r.SANCTION_DATE)},
        threshold=lambda r: {"source": c["guideline_source"]},
        deviation=lambda r: f"completed {iso(r.comp_ACTUAL_END_DATE)} but sanctioned later, {iso(r.SANCTION_DATE)}")

    c = cfg["detectors"]["TEMPORAL_PAYMENT_BEFORE_SANCTION"]
    mask = spine.has_expenditure & spine.has_sanctioned & (spine.exp_first_date < spine.SANCTION_DATE)
    out += _emit(spine, mask,
        detector_id="TEMPORAL_PAYMENT_BEFORE_SANCTION", tag=c["tag"], severity=c["severity"],
        stage="payment", financial_exposure=lambda r: r.exp_total_disbursed,
        observed=lambda r: {"first_expenditure_date": iso(r.exp_first_date), "sanction_date": iso(r.SANCTION_DATE)},
        threshold=lambda r: {"source": c["guideline_source"]},
        deviation=lambda r: f"first disbursement {iso(r.exp_first_date)} but sanctioned later, {iso(r.SANCTION_DATE)}")

    return out


def detect_ghost_asset(spine, cfg):
    c = cfg["detectors"]["GHOST_ASSET"]
    mask = spine.has_completed & spine.has_expenditure & spine.exp_any_success & spine.comp_ATTACH_ID.isna()
    return _emit(spine, mask,
        detector_id="GHOST_ASSET", tag=c["tag"], severity=c["severity"], stage="payment",
        financial_exposure=lambda r: r.exp_total_disbursed,
        observed=lambda r: {"completed": True, "actual_end_date": iso(r.comp_ACTUAL_END_DATE),
                             "actual_amount": r.comp_ACTUAL_AMOUNT, "total_disbursed": r.exp_total_disbursed,
                             "disbursement_rows": int(r.exp_row_count), "file_attached": False},
        threshold=lambda r: {"guideline_days": None, "source": c["guideline_source"]},
        deviation=lambda r: f"work marked complete with ₹{r.exp_total_disbursed:,.0f} paid across "
                             f"{int(r.exp_row_count)} disbursement(s), no supporting file attached to the completion record")


def detect_paid_not_complete(spine, cfg):
    c = cfg["detectors"]["PAID_NOT_COMPLETE"]
    mask = spine.has_expenditure & ~spine.has_completed & spine.has_sanctioned & (spine.age_since_sanction > c["guideline_days"])
    return _emit(spine, mask,
        detector_id="PAID_NOT_COMPLETE", tag=c["tag"], stage="payment",
        severity=lambda r: bucket_severity(r.age_since_sanction, c["severity_buckets"]),
        financial_exposure=lambda r: r.exp_total_disbursed,
        observed=lambda r: {"days_since_sanction": int(r.age_since_sanction), "total_disbursed": r.exp_total_disbursed,
                             "disbursement_rows": int(r.exp_row_count)},
        threshold=lambda r: {"guideline_days": c["guideline_days"], "source": c["guideline_source"]},
        deviation=lambda r: f"₹{r.exp_total_disbursed:,.0f} disbursed across {int(r.exp_row_count)} "
                             f"payment(s), {int(r.age_since_sanction)} days since sanction, no completion record")


def detect_stuck_status(spine, cfg):
    c = cfg["detectors"]["STUCK_STATUS"]
    early_stages = c["early_stages"]
    mask = spine.WORK_STAGE_RESOLVED.isin(early_stages) & (spine.age_since_recommendation > c["guideline_days"])
    return _emit(spine, mask,
        detector_id="STUCK_STATUS", tag=c["tag"],
        severity=lambda r: bucket_severity(r.age_since_recommendation, c["severity_buckets"]),
        stage=lambda r: "sanction" if not r.has_sanctioned else "execution",
        financial_exposure=lambda r: r.SANCTION_AMOUNT if r.has_sanctioned else r.rec_RECOMMENDED_AMOUNT,
        observed=lambda r: {"work_stage": r.WORK_STAGE_RESOLVED, "days_since_recommendation": int(r.age_since_recommendation)},
        threshold=lambda r: {"guideline_days": c["guideline_days"], "early_stages": early_stages, "source": c["guideline_source"]},
        deviation=lambda r: f"parked at '{r.WORK_STAGE_RESOLVED}' for {int(r.age_since_recommendation)} days "
                             f"since recommendation (guideline: {c['guideline_days']} days)")


DETECTORS = [
    detect_stalled_at_sanction, detect_sanction_delay, detect_stalled_at_execution,
    detect_execution_delay, detect_temporal_impossible, detect_ghost_asset,
    detect_paid_not_complete, detect_stuck_status,
]


def run() -> list[dict]:
    spine = pd.read_parquet(DATA_PROCESSED / "spine.parquet")
    cfg = load_config()
    spine = prepare_spine(spine, cfg)

    findings = []
    for fn in DETECTORS:
        f = fn(spine, cfg)
        findings += f
        by_detector = {}
        for finding in f:
            by_detector.setdefault(finding["detector"], 0)
            by_detector[finding["detector"]] += 1
        for det, n in sorted(by_detector.items()):
            print(f"  {det:42} {n:>8,}")

    print(f"\n  total findings: {len(findings):,}")
    return findings


def demo():
    findings = run()

    required_top = {"finding_id", "work_number", "detector", "tag", "severity", "confidence",
                     "financial_exposure", "evidence", "entities", "suppressed",
                     "suppression_reason", "routed_to", "stage"}
    required_entities = {"state", "constituency", "constituency_id", "district", "lgd_code",
                          "mp_name", "implementing_agency", "vendor", "vendor_count",
                          "scope_house", "scope_tenure"}

    ghost_caveat_seen = False
    by_detector_scope: dict[tuple[str, str], int] = {}
    for f in findings:
        assert required_top <= f.keys(), f"finding missing keys: {required_top - f.keys()}"
        assert required_entities <= f["entities"].keys(), "entities missing keys"
        assert f["severity"] in ("low", "medium", "high"), f"bad severity {f['severity']}"
        assert f["confidence"] == "rule", f"expected confidence=rule, got {f['confidence']}"
        assert pd.notna(f["financial_exposure"]), "financial_exposure is NaN"
        assert f["entities"]["constituency_id"] is not None, (
            f"null constituency_id on {f['finding_id']} - every work in the spine "
            f"should resolve one (see link.py's coalesce), this should never happen"
        )
        if f["detector"] == "GHOST_ASSET":
            if "not verified to be photographic" in f["evidence"]["threshold"]["source"]:
                ghost_caveat_seen = True
        key = (f["detector"], f["entities"]["scope_tenure"])
        by_detector_scope[key] = by_detector_scope.get(key, 0) + 1

    assert ghost_caveat_seen or not any(f["detector"] == "GHOST_ASSET" for f in findings), \
        "GHOST_ASSET caveat text did not survive into evidence.threshold.source"

    print("\n  per-detector counts by SCOPE_TENURE:")
    for (det, tenure), n in sorted(by_detector_scope.items()):
        print(f"    {det:42} {tenure:16} {n:>8,}")

    print(f"\ndetectors self-check: PASS  ({len(findings):,} total findings, all required keys present)")


if __name__ == "__main__":
    demo()
