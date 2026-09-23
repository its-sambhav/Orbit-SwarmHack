"""Severity policy, priority, rollup and validation - spec sections 5 and 7."""
import json

import pandas as pd
import pytest

from engine import rollup, score, validation


def finding(work="1", severity="medium", confidence="statistical", family="timing", exposure=5e5,
            tag="Delay in Sanction", scope="work", fid=None, agency=None, state="Bihar"):
    return {
        "finding_id": fid or f"{tag}:{work}:{severity}:{family}", "work_number": work, "detector": tag.upper(),
        "tag": tag, "severity": severity, "confidence": confidence, "financial_exposure": exposure,
        "evidence": {"family": family, "scope": scope, "raw_severity": severity, "deviation": "x"},
        "entities": {"scope_house": "Lok Sabha", "scope_tenure": "18th Lok Sabha", "implementing_agency": agency,
                     "state": state, "district": "PATNA"},
        "suppressed": False, "suppression_reason": None, "stage": "sanction",
    }


def test_statistical_capped_at_medium(cfg):
    f = [finding(severity="high")]
    score.apply_severity_policy(f, cfg)
    assert f[0]["severity"] == "medium"


def test_rule_high_is_kept(cfg):
    f = [finding(severity="high", confidence="rule", family="money", tag="Excess Expenditure")]
    score.apply_severity_policy(f, cfg)
    assert f[0]["severity"] == "high"


def test_two_families_raise_the_top_statistical_finding_one_step(cfg):
    f = [finding(severity="high", family="timing"), finding(severity="low", family="money", tag="Unusual Cost")]
    score.apply_severity_policy(f, cfg)
    assert f[0]["severity"] == "high"                   # capped to medium, then raised back by corroboration
    assert f[0]["evidence"]["corroborated_by"] == ["money"]
    assert f[1]["severity"] == "low"                    # only the top one moves


def test_same_family_does_not_corroborate(cfg):
    f = [finding(severity="medium", family="timing"), finding(severity="medium", family="timing", tag="Work Not Completed")]
    score.apply_severity_policy(f, cfg)
    assert {x["severity"] for x in f} == {"medium"}


def test_data_integrity_never_corroborates(cfg):
    f = [finding(severity="medium", family="timing"),
         finding(severity="low", confidence="rule", family="data_integrity", tag="Record Date Discrepancy")]
    score.apply_severity_policy(f, cfg)
    assert f[0]["severity"] == "medium"


def test_portfolio_findings_do_not_corroborate_their_anchor_work(cfg):
    f = [finding(severity="medium", family="timing"),
         finding(severity="medium", family="guideline", tag="Allocation Limit Exceeded", scope="mp_portfolio")]
    score.apply_severity_policy(f, cfg)
    assert f[0]["severity"] == "medium"


def test_priority_formula_and_data_integrity_cap(cfg):
    sc = cfg["scoring"]
    assert score.exposure_factor(1e5, sc) == 0 and score.exposure_factor(1e7, sc) == 1
    assert score.exposure_factor(1e6, sc) == pytest.approx(0.5)
    f = finding(severity="high", confidence="rule", family="money", exposure=1e7)
    assert score.priority_score(f, sc) == pytest.approx(100 * 0.6 * 1.0 * 1.0)
    di = finding(severity="high", confidence="rule", family="data_integrity", exposure=1e7)
    assert score.priority_score(di, sc) == pytest.approx(100 * 0.05)
    assert score.priority_score(finding(exposure=0), sc) == pytest.approx(100 * 0.35 * 0.6 * 0.5)


def test_wilson_lower_bound():
    assert validation.wilson_lower_bound(0, 0) is None
    assert validation.wilson_lower_bound(50, 50) == pytest.approx(0.9287, abs=1e-3)
    assert validation.wilson_lower_bound(40, 50) < 0.7


def test_feedback_caps_unvalidated_tag_and_suppresses_dismissed_pattern(cfg):
    fs = [finding(work=str(i), severity="high", confidence="rule", family="money", tag="Excess Expenditure",
                  fid=f"E:{i}", agency="AGENCY X") for i in range(60)]
    # 60 reviews, 40 verified: Wilson lower bound ~0.54 < 0.7 -> tag loses high
    statuses = [{"finding_id": f"E:{i}", "status": "verified" if i < 40 else "dismissed"} for i in range(60)]
    stats = score.apply_severity_policy(fs, cfg, statuses)
    assert {f["severity"] for f in fs} == {"medium"} and stats["feedback_capped"] == 60

    gs = [finding(work=str(i), tag="Unusual Cost", family="money", fid=f"U:{i}", agency="AGENCY Y") for i in range(12)]
    statuses = [{"finding_id": f"U:{i}", "status": "dismissed" if i < 10 else "verified"} for i in range(12)]
    score.apply_severity_policy(gs, cfg, statuses)
    assert all(g["suppressed"] for g in gs) and "AGENCY Y" in gs[0]["suppression_reason"]


def test_unreviewed_tag_keeps_high_unless_strict_mode(cfg):
    f = [finding(severity="high", confidence="rule", family="money", tag="Excess Expenditure")]
    score.apply_severity_policy(f, cfg, [])
    assert f[0]["severity"] == "high"
    cfg["feedback"]["require_validation_for_high"] = True
    f = [finding(severity="high", confidence="rule", family="money", tag="Excess Expenditure")]
    score.apply_severity_policy(f, cfg, [])
    assert f[0]["severity"] == "medium"


def _spine(n_works, flagged_by=None):
    rows = []
    for i in range(n_works):
        rows.append(dict(WORK_RECOMMENDATION_DTL_ID=i, SCOPE_HOUSE="Lok Sabha", SCOPE_TENURE="18th Lok Sabha",
                         STATE_NAME="Bihar", CONSTITUENCY="C1" if i < n_works // 2 else "C2",
                         CONSTITUENCY_ID=1 if i < n_works // 2 else 2, MP_NAME="M", DISTRICT="D",
                         IDA_NAME_CLEAN="I", WORK_STAGE_RESOLVED="Sanction", SANCTION_AMOUNT=1e6,
                         rec_RECOMMENDED_AMOUNT=1e6, exp_top_ia=None, exp_top_vendor=None, exp_vendor_count=None))
    return pd.DataFrame(rows)


def test_work_risk_combines_families_but_not_within_one(cfg):
    fs = [finding(work="0", severity="medium", family="timing"),
          finding(work="0", severity="medium", family="timing", tag="Work Not Completed"),
          finding(work="1", severity="medium", family="timing"),
          finding(work="1", severity="medium", family="money", tag="Unusual Cost")]
    df = pd.DataFrame(fs)
    df["scope_house"], df["scope_tenure"] = "Lok Sabha", "18th Lok Sabha"
    wr = rollup.build_work_risk(df, _spine(4), ["18th Lok Sabha"], cfg).set_index("work_number")
    s = 0.35 * 0.6
    assert wr.loc["0", "risk"] == pytest.approx(100 * s, abs=0.01)                # one family: no stacking
    assert wr.loc["1", "risk"] == pytest.approx(100 * (1 - (1 - s) ** 2), abs=0.01)


def test_region_rollup_uses_shrunk_rate_not_sum_of_priority(cfg):
    sp = _spine(200)
    fs = [finding(work=str(i), severity="medium") for i in [0, 1, 100, 101, 102, 103, 104, 105]]
    df = pd.DataFrame(fs)
    df["scope_house"], df["scope_tenure"] = "Lok Sabha", "18th Lok Sabha"
    wr = rollup.build_work_risk(df, sp, ["18th Lok Sabha"], cfg)
    cr = rollup.build_constituency_risk(wr, sp, ["18th Lok Sabha"], cfg).set_index("CONSTITUENCY_ID")
    p0 = 8 / 200
    a, b = p0 * 50, (1 - p0) * 50
    assert cr.loc[1, "shrunk_rate"] == pytest.approx((2 + a) / (100 + a + b))
    assert cr.loc[2, "risk_score"] > cr.loc[1, "risk_score"]
    assert json.loads(cr.loc[2, "tag_counts"]) == {"Delay in Sanction": 6}


def test_regression_check(tmp_path, monkeypatch):
    monkeypatch.setattr(validation, "SNAPSHOT_PATH", tmp_path / "snap.json")
    validation.regression_check([finding()] * 100, 0.2)
    validation.regression_check([finding()] * 110, 0.2)          # +10%: fine
    with pytest.raises(RuntimeError):
        validation.regression_check([finding()] * 150, 0.2)      # +36%, same config: fail


def test_hand_check_sheet_and_precision(tmp_path, cfg):
    fs = [finding(work=str(i), severity="high" if i % 2 else "medium", fid=f"F{i}") for i in range(20)]
    path = tmp_path / "sheet.csv"
    validation.export_hand_check_sheet(fs, cfg, path)
    rows = path.read_text(encoding="utf-8").splitlines()
    assert rows[0].startswith("finding_id") and len(rows) == 21
    labelled = rows[0] + "\n" + "\n".join(r.replace(",,", ",yes,", 1) if i < 5 else r for i, r in enumerate(rows[1:]))
    path.write_text(labelled, encoding="utf-8")
    assert validation.precision_at_k(path)["Delay in Sanction"]["labelled"] == 5
