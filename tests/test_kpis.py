"""The dashboard KPI cards (api/kpis.py compute_kpis) on a five-work example
whose every expected number is worked out by hand in the comments."""
import pandas as pd
import pytest

from api.kpis import compute_kpis

AS_OF = pd.Timestamp("2026-09-10")
ago = lambda days: AS_OF - pd.Timedelta(days=days)  # noqa: E731
NaT = pd.NaT
HOUSE, TENURE = "Lok Sabha", "18th Lok Sabha"


def work(n, state, rec_days, san_days=None, comp_days=None, rec_amt=10.0, san_amt=None, comp_amt=None, agency=None):
    return {
        "work_number": str(n), "SCOPE_HOUSE": HOUSE, "SCOPE_TENURE": TENURE, "STATE_NAME": state, "DISTRICT": state + "-d",
        "has_recommended": True, "has_sanctioned": san_days is not None, "has_completed": comp_days is not None,
        "rec_RECOMMENDATION_DATE": ago(rec_days), "SANCTION_DATE": ago(san_days) if san_days is not None else NaT,
        "comp_ACTUAL_END_DATE": ago(comp_days) if comp_days is not None else NaT,
        "rec_RECOMMENDED_AMOUNT": rec_amt, "SANCTION_AMOUNT": san_amt, "comp_ACTUAL_AMOUNT": comp_amt, "exp_top_ia": agency,
    }


SP = pd.DataFrame([
    work(1, "A", rec_days=100),                                   # waiting 100 days for sanction: past the 75-day limit
    work(2, "A", rec_days=65),                                    # reaches the limit within 15 days: due soon
    work(3, "B", rec_days=400, san_days=380, san_amt=30.0, agency="X"),   # sanctioned on time (20 d), unfinished after 380 d
    work(4, "B", rec_days=200, san_days=100, comp_days=50, san_amt=10.0, comp_amt=9.0, agency="Y"),  # late sanction (100 d), done on time
    work(5, "B", rec_days=30, rec_amt=7.0),                       # within its window - the model's early warning
])
WR = pd.DataFrame([
    {"work_number": "3", "scope_house": HOUSE, "scope_tenure": TENURE, "is_substantive": True, "max_severity": "high",
     "total_exposure": 30.0, "STATE_NAME": "B", "DISTRICT": "B-d"},
    {"work_number": "4", "scope_house": HOUSE, "scope_tenure": TENURE, "is_substantive": True, "max_severity": "medium",
     "total_exposure": 5.0, "STATE_NAME": "B", "DISTRICT": "B-d"},
    {"work_number": "1", "scope_house": HOUSE, "scope_tenure": TENURE, "is_substantive": False, "max_severity": "low",
     "total_exposure": 0.0, "STATE_NAME": "A", "DISTRICT": "A-d"},
])


def finding(n, tag, exposure=0.0, evidence=None, state="B"):
    return {"work_number": str(n), "scope_house": HOUSE, "scope_tenure": TENURE, "tag": tag,
            "financial_exposure": exposure, "evidence": evidence or {}, "state": state, "district": state + "-d"}


FINDINGS = pd.DataFrame([
    finding(4, "Unusual Cost", 10.0, {"observed": {"sanction_amount": 10.0, "ratio_to_peer_median": 5.0}}),
    finding(4, "Completion Evidence Not Attached", 10.0),
    finding(3, "Duplicate Work", 30.0),
    finding(9, "Duplicate Work", 99.0),   # a work outside the slice: must not count
])
EARLY = pd.DataFrame([{"work_number": "5", "SCOPE_HOUSE": HOUSE, "SCOPE_TENURE": TENURE}])


@pytest.fixture(scope="module")
def k():
    return compute_kpis(SP, WR, FINDINGS, EARLY, AS_OF, sanction_days=75, completion_days=365,
                        group=("STATE_NAME", "state"))


def test_delays_against_the_guideline_limits(k):
    assert k["delayed"]["awaiting_sanction"] == 1 and k["delayed"]["unfinished"] == 1 and k["delayed"]["works"] == 2
    assert k["delayed"]["on_time_sanction_rate"] == 0.5          # work 3 in 20 days, work 4 in 100
    assert k["sanction_backlog"] == {"works": 1, "amount": 10.0, "oldest_days": 100}
    assert k["sanction_due_soon"]["works"] == 1                  # work 2, 65 days in
    assert k["overdue"] == {"works": 1, "amount": 30.0}
    assert k["days_to_sanction"]["median"] == 60.0              # median of 20 and 100
    assert k["on_time_completion"] == {"share": 1.0, "on_time": 1, "completed": 1}


def test_risk_cards(k):
    # flagged exposure 30 + 5 against sanctioned money 30 + 10
    assert k["money_at_risk"] == {"amount": 35.0, "works": 2, "share_of_sanctioned": 0.875,
                                  "top": {"name": "B", "amount": 35.0}}
    assert k["high_severity"]["works"] == 1 and k["high_severity"]["amount"] == 30.0
    assert k["flagged_share"]["share"] == 0.4                    # 2 of 5 works


def test_cost_overruns_count_rupees_above_the_peer_median(k):
    # sanctioned 10 at 5x its peers' median of 2 -> 8 above
    assert k["cost_overruns"]["works"] == 1
    assert k["cost_overruns"]["above_peer"] == pytest.approx(8.0)
    assert k["cost_overruns"]["typical_ratio"] == 5.0


def test_tagged_cards_stay_inside_the_slice(k):
    assert k["duplicates"]["works"] == 1 and k["duplicates"]["amount"] == 30.0   # work 9 excluded
    assert k["evidence_missing"]["works"] == 1 and k["evidence_missing"]["share_of_completed"] == 1.0
    assert k["payment_without_completion"]["works"] == 0
    assert k["cost_or_duplicate"]["works"] == 2                  # work 4 (cost) + work 3 (duplicate)


def test_early_warning_assets_and_concentration(k):
    assert k["early_warning"]["works"] == 1 and k["early_warning"]["amount"] == 7.0
    assert k["assets_delivered"] == {"works": 1, "amount": 9.0}
    assert k["agency_concentration"] == {"agency": "X", "share": 0.75}        # 30 of 40 sanctioned


def test_no_group_means_no_top_lines():
    k = compute_kpis(SP, WR, FINDINGS, EARLY, AS_OF, 75, 365)
    assert "top" not in k["money_at_risk"] and k["delayed"]["top"] is None
