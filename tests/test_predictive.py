"""Delay predictor: labels and features must never read the future."""
import numpy as np
import pandas as pd

from engine import predictive as P

AS_OF = pd.Timestamp("2026-09-10")
NaT = pd.NaT


def _works(rows):
    base = dict(rec_RECOMMENDATION_DATE=NaT, san_SANCTION_DATE=NaT, comp_ACTUAL_END_DATE=NaT,
                has_sanctioned=False, has_completed=False)
    return pd.DataFrame([{**base, **r} for r in rows])


def test_labels_leave_too_young_works_out():
    d = lambda days: AS_OF - pd.Timedelta(days=days)
    df = _works([
        dict(rec_RECOMMENDATION_DATE=d(400), san_SANCTION_DATE=d(390), comp_ACTUAL_END_DATE=d(300),
             has_sanctioned=True, has_completed=True),                                  # fast, done: on time
        dict(rec_RECOMMENDATION_DATE=d(900), san_SANCTION_DATE=d(300), has_sanctioned=True),   # 600-day sanction: late
        dict(rec_RECOMMENDATION_DATE=d(40), san_SANCTION_DATE=d(30), has_sanctioned=True),     # 30 days open: unknown
        dict(rec_RECOMMENDATION_DATE=d(50)),                                                   # 50 days unsanctioned: unknown
        dict(rec_RECOMMENDATION_DATE=d(500)),                                                  # 500 days unsanctioned: late
    ])
    y, _ = P.delay_labels(df, AS_OF, gates=(100, 200))
    assert y.iloc[0] == 0 and y.iloc[1] == 1 and y.iloc[4] == 1
    assert np.isnan(y.iloc[2]) and np.isnan(y.iloc[3])


def test_recommendation_context_counts_only_earlier_recommendations():
    t = pd.Timestamp("2024-06-15")
    hist = pd.DataFrame({
        "MP_NAME": ["A"] * 5 + ["B"],
        "IDA_NAME_CLEAN": ["X"] * 6,
        "rec_LETTER_NO": ["L1", "L1", "L1", "L2", "L3", "L4"],
        "rec_RECOMMENDATION_DATE": [t - pd.Timedelta(days=d) for d in (5, 20, 45)] + [t, t + pd.Timedelta(days=3), t - pd.Timedelta(days=1)],
    })
    row = pd.DataFrame({"MP_NAME": ["A"], "IDA_NAME_CLEAN": ["X"], "rec_LETTER_NO": ["L1"], "rec_RECOMMENDATION_DATE": [t]})
    ctx = P.recommendation_context(row, hist).iloc[0]
    assert ctx["letter_batch_size"] == 3
    assert ctx["mp_recs_prev_30d"] == 2          # 5 and 20 days before; not 45 days, not the same day, not later
    assert ctx["ida_recs_prev_90d"] == 4         # 5, 20, 45 days and B's 1 day before; nothing on or after t


def test_relative_cost_falls_back_from_group_to_state_to_overall():
    la = pd.Series([5.0] * 5 + [6.0])
    st = pd.Series(["S"] * 5 + ["T"])
    ac = pd.Series(["roads"] * 5 + ["wells"])
    table = P._cost_table(la, st, ac)
    out = P._relative_cost(pd.Series([5.3, 6.3, 7.0]), pd.Series(["S", "T", "Z"]),
                           pd.Series(["roads", "wells", "roads"]), table)
    assert out.round(2).tolist() == [0.3, 0.3, round(7.0 - table["overall"], 2)]
