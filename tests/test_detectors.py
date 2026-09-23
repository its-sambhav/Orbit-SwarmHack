"""One test per detector on a tiny hand-made table, each with at least one
case that must NOT flag."""
import numpy as np
import pandas as pd

from conftest import ago, work, sanctioned, paid, run_one, ids
from engine import detectors as d


def peers(n=40, start=1000, **kw):
    """n comparable works so a peer group clears min_peers."""
    return [sanctioned(start + i, **kw) for i in range(n)]


# ---------------------------------------------------------------- A. sanction
def test_delay_in_sanction_flags_peer_outlier_above_floor(cfg, ctx):
    rows = peers(lag=100) + [sanctioned(1, lag=400), sanctioned(2, lag=150)]
    out = run_one(d.detect_delay_in_sanction, rows, cfg, ctx)
    assert 1 in ids(out)
    # 150 days is slower than every peer but under the 180-day floor
    assert 2 not in ids(out)
    f = next(x for x in out if x["work_number"] == "1")
    assert f["tag"] == "Delay in Sanction" and f["confidence"] == "statistical"
    assert f["evidence"]["peer_benchmark"]["peer_group"] == "state x activity x tenure"


def test_delay_in_sanction_slow_state_does_not_flag_typical_work(cfg, ctx):
    # everyone in this state takes ~300 days; a 290-day work is normal here
    rows = [sanctioned(1000 + i, lag=300 + i % 5) for i in range(40)] + [sanctioned(1, lag=290)]
    assert 1 not in ids(run_one(d.detect_delay_in_sanction, rows, cfg, ctx))


def test_delay_gate_falls_back_to_broader_peer_group(cfg, ctx):
    # only 5 works share the activity - the state x tenure group is used instead
    rows = peers(lag=100, rec_ACTIVITY_NAME_CLEAN="Roads") + \
        [sanctioned(2000 + i, lag=100, rec_ACTIVITY_NAME_CLEAN="Rare") for i in range(4)] + \
        [sanctioned(1, lag=500, rec_ACTIVITY_NAME_CLEAN="Rare")]
    f = run_one(d.detect_delay_in_sanction, rows, cfg, ctx)
    hit = next(x for x in f if x["work_number"] == "1")
    assert hit["evidence"]["peer_benchmark"]["peer_group"] == "state x tenure"


def test_recommendation_pending_sanction_skips_cancelled(cfg, ctx):
    rows = [work(1000 + i, rec_RECOMMENDATION_DATE=ago(100)) for i in range(40)]
    rows += [work(1, rec_RECOMMENDATION_DATE=ago(500)),
             work(2, rec_RECOMMENDATION_DATE=ago(500), rec_FLAG=2.0),     # cancelled/rejected
             work(3, rec_RECOMMENDATION_DATE=ago(150))]                   # under the floor
    out = ids(run_one(d.detect_recommendation_pending_sanction, rows, cfg, ctx))
    assert out == {1}


def test_sanctioned_work_not_taken_up(cfg, ctx):
    stage = {"WORK_STAGE_RESOLVED": "Vendor Identification"}
    rows = [sanctioned(1000 + i, lag=30, rec_days_ago=130, **stage) for i in range(40)]
    rows += [sanctioned(1, lag=30, rec_days_ago=530, **stage),
             sanctioned(2, lag=30, rec_days_ago=530, **stage, **paid(1e5, 400, 380))]   # has a payment
    assert ids(run_one(d.detect_sanctioned_not_taken_up, rows, cfg, ctx)) == {1}


# --------------------------------------------------------------- B. execution
def test_delay_in_completion(cfg, ctx):
    def done(i, lag):
        return sanctioned(i, lag=20, rec_days_ago=900, comp_ACTUAL_END_DATE=ago(880 - lag),
                          comp_ACTUAL_AMOUNT=5e5, WORK_STAGE_RESOLVED="Work Completed")
    rows = [done(1000 + i, 100) for i in range(40)] + [done(1, 600), done(2, 300)]
    assert ids(run_one(d.detect_delay_in_completion, rows, cfg, ctx)) == {1}


def test_work_not_completed_needs_no_recent_payment(cfg, ctx):
    rows = [sanctioned(1000 + i, lag=20, rec_days_ago=200, **paid(1e5, 150, 100)) for i in range(40)]
    rows += [sanctioned(1, lag=20, rec_days_ago=800, **paid(1e5, 700, 600)),
             sanctioned(2, lag=20, rec_days_ago=800, **paid(1e5, 700, 30))]   # paid 30 days ago
    assert ids(run_one(d.detect_work_not_completed, rows, cfg, ctx)) == {1}


def test_payment_without_completion(cfg, ctx):
    rows = [sanctioned(1000 + i, lag=20, rec_days_ago=200, **paid(1e5, 150, 100)) for i in range(40)]
    rows += [sanctioned(1, lag=20, rec_days_ago=900, **paid(3e5, 800, 700)),
             sanctioned(2, lag=20, rec_days_ago=900, **paid(3e5, 800, 700, success=False))]  # in-progress only
    assert ids(run_one(d.detect_payment_without_completion, rows, cfg, ctx)) == {1}


def test_prolonged_delay_rule_lane(cfg, ctx):
    rows = [sanctioned(1, lag=400, rec_days_ago=450, amount=5e7),     # 1.1x the 365-day limit, expensive
            sanctioned(2, lag=600, rec_days_ago=650, amount=2e5),     # 1.6x the limit, small
            sanctioned(3, lag=300, rec_days_ago=350),                 # under the limit
            work(4, rec_RECOMMENDATION_DATE=ago(400))]                # unsanctioned > 365
    out = {int(f["work_number"]): f for f in run_one(d.detect_prolonged_delay, rows, cfg, ctx)}
    assert set(out) == {1, 2, 4}
    # severity is how late, never how expensive - money counts once, in priority
    assert out[1]["severity"] == "medium" and out[2]["severity"] == "high"
    assert out[2]["severity_score"] > out[1]["severity_score"]
    assert all(f["confidence"] == "rule" and f["tag"] == "Prolonged Delay Beyond Guideline" for f in out.values())


def test_severity_score_orders_findings_inside_one_band(cfg, ctx):
    # both are "medium" (between 1x and 1.5x the limit), the later one scores higher
    rows = [sanctioned(1, lag=380, rec_days_ago=450), sanctioned(2, lag=520, rec_days_ago=600)]
    out = {int(f["work_number"]): f for f in run_one(d.detect_prolonged_delay, rows, cfg, ctx)}
    assert out[1]["severity"] == out[2]["severity"] == "medium"
    assert 1 / 3 <= out[1]["severity_score"] < out[2]["severity_score"] < 2 / 3


def test_merge_delay_lanes_keeps_one_finding_per_delay(cfg, ctx):
    # 40 peers sanctioned in 30 days; work 1 took 500 days: both the peer gate
    # and the 365-day fixed limit fire on the same sanction lag
    rows = peers(lag=30, rec_days_ago=700) + [sanctioned(1, lag=500, rec_days_ago=700)]
    prepared = d.prepare_spine(__import__("conftest").spine(rows), cfg)
    stat = d.detect_delay_in_sanction(prepared, cfg, ctx)
    rule = d.detect_prolonged_delay(prepared, cfg, ctx)
    assert 1 in ids(stat) and 1 in ids(rule)
    merged, n = d.merge_delay_lanes(stat + rule, cfg)
    mine = [f for f in merged if f["work_number"] == "1"]
    assert n == 1 and len(mine) == 1
    f = mine[0]
    assert f["detector"] == "DELAY_IN_SANCTION" and f["confidence"] == "rule"
    assert f["evidence"]["merged_from"] == ["PROLONGED_DELAY_SANCTION_LAG:1:Lok Sabha:18th Lok Sabha"]
    assert f["evidence"]["threshold"]["limit_days"] == 365.0 and f["evidence"]["threshold"]["gate_days"] is not None


def test_hard_breach_without_statistical_sibling_is_kept(cfg, ctx):
    # everyone is equally slow, so the peer gate doesn't fire - the fixed limit still does
    rows = peers(lag=500, rec_days_ago=700) + [sanctioned(1, lag=500, rec_days_ago=700)]
    prepared = d.prepare_spine(__import__("conftest").spine(rows), cfg)
    stat = d.detect_delay_in_sanction(prepared, cfg, ctx)
    rule = d.detect_prolonged_delay(prepared, cfg, ctx)
    merged, _ = d.merge_delay_lanes(stat + rule, cfg)
    assert 1 not in ids(stat)
    assert any(f["work_number"] == "1" and f["detector"] == "PROLONGED_DELAY_SANCTION_LAG" for f in merged)


# ------------------------------------------------------------- C. expenditure
def test_excess_expenditure(cfg, ctx):
    rows = [sanctioned(1, lag=30, **paid(5.25e5, 300, 200)),     # 1.05x
            sanctioned(2, lag=30, **paid(5.02e5, 300, 200))]     # 1.004x - rounding
    out = run_one(d.detect_excess_expenditure, rows, cfg, ctx)
    assert ids(out) == {1} and out[0]["severity"] == "high" and out[0]["financial_exposure"] == 25000


def test_sanction_exceeds_recommendation(cfg, ctx):
    rows = [sanctioned(1, lag=30), sanctioned(2, lag=30)]
    rows[0]["rec_RECOMMENDED_AMOUNT"] = 4e5        # sanctioned 5 lakh against a 4 lakh recommendation
    assert ids(run_one(d.detect_sanction_exceeds_recommendation, rows, cfg, ctx)) == {1}


def test_expenditure_without_sanction(cfg, ctx):
    rows = [work(1, **paid(1e5, 50, 40)),                                          # no sanction at all
            sanctioned(2, lag=100, rec_days_ago=300, **paid(1e5, 250, 150)),       # paid 50 days pre-sanction
            sanctioned(3, lag=100, rec_days_ago=300, **paid(1e5, 150, 100))]       # normal
    assert ids(run_one(d.detect_expenditure_without_sanction, rows, cfg, ctx)) == {1, 2}


def test_expenditure_after_completion(cfg, ctx):
    key = dict(SCOPE_HOUSE="Lok Sabha", SCOPE_TENURE="18th Lok Sabha")
    def done(i):
        return sanctioned(i, lag=20, rec_days_ago=600, comp_ACTUAL_END_DATE=ago(300), comp_ACTUAL_AMOUNT=5e5,
                          **paid(5e5, 450, 100))
    rows = [done(1), done(2)]
    ctx["payments"] = pd.DataFrame([
        dict(WORK_RECOMMENDATION_DTL_ID=1, EXPENDITURE_DATE=ago(450), FUND_DISBURSED_AMT=4e5, **key),
        dict(WORK_RECOMMENDATION_DTL_ID=1, EXPENDITURE_DATE=ago(100), FUND_DISBURSED_AMT=1e5, **key),    # 20% late
        dict(WORK_RECOMMENDATION_DTL_ID=2, EXPENDITURE_DATE=ago(450), FUND_DISBURSED_AMT=4.9e5, **key),
        dict(WORK_RECOMMENDATION_DTL_ID=2, EXPENDITURE_DATE=ago(100), FUND_DISBURSED_AMT=1e4, **key),    # 2% late
    ])
    out = run_one(d.detect_expenditure_after_completion, rows, cfg, ctx)
    assert ids(out) == {1}
    assert out[0]["severity"] == "medium"          # 200 days after completion


def test_unusual_cost_uses_mad_floor(cfg, ctx):
    rng = np.random.default_rng(0)
    rows = [sanctioned(1000 + i, lag=30, amount=float(rng.integers(400_000, 600_000))) for i in range(40)]
    rows += [sanctioned(1, lag=30, amount=5_000_000.0)]
    assert 1 in ids(run_one(d.detect_unusual_cost, rows, cfg, ctx))

    # a group where most works cost nearly the same: the MAD is tiny but not
    # zero, and a work 1% above the median must not become a z = 17 "outlier"
    hp = dict(rec_ACTIVITY_NAME_CLEAN="Hand pumps")
    flat = [sanctioned(2000 + i, lag=30, amount=74_000.0, **hp) for i in range(20)]
    flat += [sanctioned(2100 + i, lag=30, amount=74_000.0 + 10 * i, **hp) for i in range(25)]
    flat += [sanctioned(2, lag=30, amount=74_800.0, **hp)]
    prepared = d.prepare_spine(__import__("conftest").spine(flat), cfg)
    raw_mad = d.robust_z(np.log10(prepared.SANCTION_AMOUNT))       # no floor
    assert raw_mad.max() > cfg["detectors"]["UNUSUAL_COST"]["z_low"]   # would have flagged without the floor
    assert 2 not in ids(d.detect_unusual_cost(prepared, cfg, ctx))
    # and a group whose MAD is exactly 0 is skipped outright
    zero = [sanctioned(3000 + i, lag=30, amount=74_000.0, **hp) for i in range(40)] + \
        [sanctioned(3, lag=30, amount=900_000.0, **hp)]
    assert run_one(d.detect_unusual_cost, zero, cfg, ctx) == []


def test_unusual_cost_skips_small_groups(cfg, ctx):
    rows = [sanctioned(1000 + i, lag=30, amount=5e5) for i in range(10)] + [sanctioned(1, lag=30, amount=5e7)]
    assert run_one(d.detect_unusual_cost, rows, cfg, ctx) == []


def test_payment_completion_mismatch(cfg, ctx):
    def done(i, paid_amt):
        return sanctioned(i, lag=20, rec_days_ago=600, comp_ACTUAL_END_DATE=ago(300), comp_ACTUAL_AMOUNT=5e5,
                          **paid(paid_amt, 450, 310))
    assert ids(run_one(d.detect_payment_completion_mismatch, [done(1, 4e5), done(2, 5.1e5)], cfg, ctx)) == {1}


# ------------------------------------------------------------- D. eligibility
def test_prohibited_work_phrase_and_exclusions(cfg, ctx):
    rows = [work(1, rec_WORK_DESCRIPTION="Construction of temple compound wall at village X"),
            work(2, rec_WORK_DESCRIPTION="CC road near Hanuman temple premises, ward 4"),        # location
            work(3, rec_WORK_DESCRIPTION="Construction of crematorium shed near mandir"),         # exception
            work(4, rec_WORK_DESCRIPTION="Road from Hanuman Mandir to Vitthal house"),            # no match
            work(5, rec_WORK_DESCRIPTION="Paver blocks in the masjid premises, Rampur")]
    out = run_one(d.detect_prohibited_work, rows, cfg, ctx)
    assert ids(out) == {1, 5}
    assert all(f["severity"] == "low" for f in out)


def test_trust_society_limit(cfg, ctx):
    t = dict(rec_WORK_CATEGORY="Trust and Society")
    rows = [work(1, rec_RECOMMENDED_AMOUNT=6e6, rec_RECOMMENDATION_DATE=pd.Timestamp("2025-05-01"), **t),
            work(2, rec_RECOMMENDED_AMOUNT=5e6, rec_RECOMMENDATION_DATE=pd.Timestamp("2026-02-01"), **t),   # same FY
            # another MP, same total split across two financial years
            work(3, MP_NAME="Smt Other", rec_RECOMMENDED_AMOUNT=6e6, rec_RECOMMENDATION_DATE=pd.Timestamp("2025-03-01"), **t),
            work(4, MP_NAME="Smt Other", rec_RECOMMENDED_AMOUNT=5e6, rec_RECOMMENDATION_DATE=pd.Timestamp("2025-05-01"), **t)]
    out = run_one(d.detect_trust_society_limit, rows, cfg, ctx)
    assert len(out) == 1 and out[0]["financial_exposure"] == 1e6
    assert out[0]["evidence"]["scope"] == "mp_portfolio"


def test_allocation_limit(cfg, ctx):
    rows = [work(1, rec_RECOMMENDED_AMOUNT=10.6e6), work(2, MP_NAME="Smt B", rec_RECOMMENDED_AMOUNT=10.3e6),
            work(3, MP_NAME="Smt C", rec_RECOMMENDED_AMOUNT=9e6), work(4, MP_NAME="Smt C", rec_RECOMMENDED_AMOUNT=5e6,
                                                                     rec_FLAG=2.0)]   # cancelled - ignored
    ctx["allocated"] = pd.DataFrame([
        dict(MP_NAME=m, SCOPE_TENURE="18th Lok Sabha", ALLOCATED_AMT=1e7) for m in ("Shri Ram Kumar", "Smt B", "Smt C")])
    out = run_one(d.detect_allocation_limit, rows, cfg, ctx)
    assert ids(out) == {1}          # 6% over; B is 3% over; C is under once the cancelled work is excluded


def test_sc_st_shortfall_phrases_only(cfg, ctx):
    cfg["detectors"]["SC_ST_EARMARK_SHORTFALL"]["enabled"] = True
    general = [work(i, rec_RECOMMENDED_AMOUNT=3e6, rec_WORK_DESCRIPTION="road near St. Mary school, ward 3")
               for i in range(1, 11)]
    reserved = [work(100 + i, MP_NAME="Smt Reserved", CONSTITUENCY="GAYA (SC)", rec_RECOMMENDED_AMOUNT=3e6,
                     rec_WORK_DESCRIPTION="tribal hostel repair" if i < 2 else "road work in ward")
                for i in range(10)]
    out = run_one(d.detect_sc_st_shortfall, general + reserved, cfg, ctx)
    by_mp = {f["entities"]["mp_name"]: f for f in out}
    assert "Shri Ram Kumar" in by_mp            # "St." did not count as ST
    assert by_mp["Shri Ram Kumar"]["evidence"]["observed"]["st_share_estimated"] == 0
    assert "Smt Reserved" not in by_mp           # SC seat, 20% to ST phrases
    assert all(f["severity"] != "high" for f in out)


def test_sc_st_shortfall_disabled_by_default(cfg, ctx):
    assert run_one(d.detect_sc_st_shortfall, [work(1, rec_RECOMMENDED_AMOUNT=5e7)], cfg, ctx) == []


def test_unspent_balance_only_completed_tenures(cfg, ctx):
    rows = [sanctioned(1, lag=30, SCOPE_TENURE="17th Lok Sabha", MP_NAME="Old MP", **paid(3e6, 900, 800)),
            sanctioned(2, lag=30, MP_NAME="New MP", **paid(1e6, 300, 200))]
    ctx["allocated"] = pd.DataFrame([
        dict(MP_NAME="Old MP", SCOPE_TENURE="17th Lok Sabha", ALLOCATED_AMT=1e7, TENURE_END_DATE="May 22, 2024 11:59:59 PM"),
        dict(MP_NAME="New MP", SCOPE_TENURE="18th Lok Sabha", ALLOCATED_AMT=1e7, TENURE_END_DATE="Jun 3, 2029 11:59:59 PM")])
    assert ids(run_one(d.detect_unspent_balance, rows, cfg, ctx)) == {1}


# ------------------------------------------------- E. duplication/concentration
def test_duplicate_work_pairs_not_bulk(cfg, ctx):
    text = "construction of community hall in village rampur near primary school"
    bulk = "supply of benches for the government primary school at village sitapur"
    rows = [work(1, rec_WORK_DESCRIPTION=text), work(2, rec_WORK_DESCRIPTION=text.upper() + "."),  # same after normalising
            *[work(10 + i, rec_WORK_DESCRIPTION=bulk) for i in range(5)],                         # bulk order
            work(20, rec_WORK_DESCRIPTION="cc road"), work(21, rec_WORK_DESCRIPTION="cc road")]    # too short
    out = run_one(d.detect_duplicate_work, rows, cfg, ctx)
    assert ids(out) == {1, 2}
    assert all(f["evidence"]["raw_severity"] == "high" for f in out)


def test_same_work_multiple_mps(cfg, ctx):
    text = "construction of shed in ramdasia dharamshala at village mansa kalan"
    rows = [work(1, MP_NAME="Smt Harsimrat Kaur Badal", rec_WORK_DESCRIPTION=text),
            work(2, MP_NAME="Smt Harsimrat Kaur Badal(17th Lok Sabha)", SCOPE_TENURE="17th Lok Sabha",
                 rec_WORK_DESCRIPTION=text),                                   # same MP, other tenure
            work(3, MP_NAME="Shri Other Member", rec_WORK_DESCRIPTION=text + " phase"),   # jaccard 0.91
            work(4, MP_NAME="Shri Third", rec_WORK_DESCRIPTION=text, rec_RECOMMENDED_AMOUNT=6e5)]  # amount 20% off
    out = run_one(d.detect_same_work_multiple_mps, rows, cfg, ctx)
    assert 3 in ids(out) and 4 not in ids(out)
    assert d.norm_person("Smt Harsimrat Kaur Badal(17th Lok Sabha)") == d.norm_person("HARSIMRAT KAUR BADAL")


def test_agency_concentration_from_payment_rows(cfg, ctx):
    key = dict(SCOPE_HOUSE="Lok Sabha", SCOPE_TENURE="18th Lok Sabha")
    rows, pays = [], []
    # district A: one agency takes 70% of 1 crore
    for i, (agency, amt) in enumerate([("BIG AGENCY", 7e6), ("AG2", 1e6), ("AG3", 1e6), ("AG4", 1e6)]):
        rows.append(sanctioned(i + 1, lag=30, DISTRICT="A", **paid(amt, 200, 100)))
        pays.append(dict(WORK_RECOMMENDATION_DTL_ID=i + 1, DISTRICT="A", IA_NAME_CLEAN=agency, FUND_DISBURSED_AMT=amt, **key))
    # district B: five agencies at 20% each - HHI 0.2, not concentrated
    for i in range(5):
        rows.append(sanctioned(10 + i, lag=30, DISTRICT="B", **paid(2e6, 200, 100)))
        pays.append(dict(WORK_RECOMMENDATION_DTL_ID=10 + i, DISTRICT="B", IA_NAME_CLEAN=f"B{i}", FUND_DISBURSED_AMT=2e6, **key))
    ctx["payments"] = pd.DataFrame(pays)
    out = run_one(d.detect_agency_concentration, rows, cfg, ctx)
    assert len(out) == 1 and out[0]["evidence"]["observed"]["agency"] == "BIG AGENCY"
    assert out[0]["evidence"]["observed"]["hhi"] > 0.25 and out[0]["evidence"]["scope"] == "district"


# ------------------------------------------------------ F. record integrity
def test_completion_evidence_not_attached(cfg, ctx):
    def done(i, attach):
        return sanctioned(i, lag=20, rec_days_ago=600, comp_ACTUAL_END_DATE=ago(300), comp_ACTUAL_AMOUNT=5e5,
                          comp_ATTACH_ID=attach, **paid(5e5, 450, 310))
    out = run_one(d.detect_completion_evidence, [done(1, None), done(2, 12345.0)], cfg, ctx)
    assert ids(out) == {1} and out[0]["severity"] == "low"
    assert "does not prove" in out[0]["evidence"]["deviation"]


def test_record_date_discrepancy(cfg, ctx):
    rows = [work(1, rec_RECOMMENDATION_DATE=ago(100), SANCTION_DATE=ago(200), SANCTION_AMOUNT=5e5),
            sanctioned(2, lag=30)]
    out = run_one(d.detect_record_date_discrepancy, rows, cfg, ctx)
    assert ids(out) == {1} and out[0]["evidence"]["family"] == "data_integrity"


def test_calamity_consent(cfg, ctx):
    rows = [sanctioned(1, lag=30, MP_NAME="SHAFI PARAMBIL"), sanctioned(2, lag=30, MP_NAME="Shri Big Giver"),
            sanctioned(3, lag=30, MP_NAME="Shri Normal")]
    base = dict(SCOPE_TENURE="18th Lok Sabha")
    ctx["calamity"] = pd.DataFrame([
        dict(CALAMITY_NAME="Wayanad landslides 2024", MP_NAME="SHAFI PARAMBIL", CONSENTED_AMOUNT=2.5e6, TYPE="National Calamity", **base),
        dict(CALAMITY_NAME="Wayanad Landslides 2024.", MP_NAME="Shri Normal", CONSENTED_AMOUNT=1e6, TYPE="State Calamity", **base),
        dict(CALAMITY_NAME="Flood 2025", MP_NAME="Big Giver", CONSENTED_AMOUNT=1.5e7, TYPE="National Calamity", **base)])
    out = run_one(d.detect_calamity_consent, rows, cfg, ctx)
    assert ids(out) == {1, 2, 3}      # 1 and 3: same event, two types; 2: over the ceiling
    ctx["calamity"] = ctx["calamity"].iloc[[0]]
    assert run_one(d.detect_calamity_consent, rows, cfg, ctx) == []


def test_every_detector_emits_registered_tags(cfg, ctx):
    names = {t["name"] for t in ctx["tags"].values()}
    rows = [sanctioned(1, lag=400, rec_days_ago=450, **paid(9e5, 300, 200))]
    for fn in d.DETECTORS:
        for f in fn(d.prepare_spine(__import__("conftest").spine(rows), cfg), cfg, ctx):
            assert f["tag"] in names
            assert f["severity"] in ("low", "medium", "high") and f["confidence"] in ("rule", "statistical")
