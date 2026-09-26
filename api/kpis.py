"""The dashboard KPI cards, built for what SIH26102 asks the platform to
surface - cost overruns, duplicate works, delayed projects, deviations from
the guideline limits, missing completion evidence and early warning of
delays - for any slice of works: national, a state, district, MP or agency.

Each endpoint passes the same scope- and date-filtered spine / work_risk
slice it already builds its page from, so a card always agrees with the rest
of that page. Only real data: a value that can't be computed is None, never a
stand-in number. The guideline limits come from config/detectors.yaml
(guidelines para 3.12: sanction within 75 days; para 3.13: completion within
one year).
"""
import threading

import numpy as np
import pandas as pd

from api.data import get_store
from engine import predictive

COST_TAG = "Unusual Cost"
DUPLICATE_TAGS = ("Duplicate Work", "Same Work Recommended by Multiple MPs")
EVIDENCE_TAG = "Completion Evidence Not Attached"
PAYMENT_TAG = "Payment Without Completion"
# "sanctions due soon": works that reach the sanction limit within this many days
DUE_SOON_DAYS = 15

SPINE_KEY = ["work_number", "SCOPE_HOUSE", "SCOPE_TENURE"]
RISK_KEY = ["work_number", "scope_house", "scope_tenure"]


def _ratio(num, den):
    return round(float(num) / float(den), 4) if den else None


def _top(values: pd.Series, by: pd.Series):
    """The group with the largest total - "most in <state/district>"."""
    if values.empty:
        return None
    totals = values.groupby(by.values).sum()
    totals = totals[totals > 0]
    if totals.empty:
        return None
    name = totals.idxmax()
    return {"name": name, "value": float(totals[name])}


def _observed(evidence) -> dict:
    return (evidence.get("observed") or {}) if isinstance(evidence, dict) else {}


def compute_kpis(sp: pd.DataFrame, wr: pd.DataFrame, findings: pd.DataFrame, early: pd.DataFrame,
                 as_of: pd.Timestamp, sanction_days: int, completion_days: int,
                 group: tuple[str, str] | None = None) -> dict:
    """Every card's numbers for one slice. `sp`/`wr` are the slice's spine and
    work_risk rows, `findings` all findings (narrowed here to the slice's
    works), `early` the (work key) rows the delay model rates high risk.
    `group` is (spine/work_risk column, findings column) naming the next
    level down - STATE_NAME/state nationally, DISTRICT/district in a state -
    for each card's "most in ..." line; None elsewhere."""
    g_sp, g_f = group or (None, None)
    works = len(sp)
    has_rec, has_san, has_comp = sp["has_recommended"], sp["has_sanctioned"], sp["has_completed"]
    rec = pd.to_datetime(sp["rec_RECOMMENDATION_DATE"], errors="coerce")
    san = pd.to_datetime(sp["SANCTION_DATE"], errors="coerce")
    comp = pd.to_datetime(sp["comp_ACTUAL_END_DATE"], errors="coerce")
    sanctioned_amount = float(sp.loc[has_san, "SANCTION_AMOUNT"].sum())

    keys = sp[SPINE_KEY].rename(columns=dict(zip(SPINE_KEY, RISK_KEY))).astype({"work_number": str})
    f = findings.astype({"work_number": str}).merge(keys, on=RISK_KEY)

    def tagged(*tags):
        sub = f[f["tag"].isin(tags)].drop_duplicates(RISK_KEY)
        out = {"works": int(len(sub)), "amount": float(sub["financial_exposure"].fillna(0).sum())}
        if g_f:
            top = _top(pd.Series(1, index=sub.index), sub[g_f])
            out["top"] = top and {"name": top["name"], "works": int(top["value"])}
        return out

    def top_works(mask):
        if not g_sp:
            return None
        top = _top(pd.Series(1, index=sp.index)[mask], sp.loc[mask, g_sp])
        return top and {"name": top["name"], "works": int(top["value"])}

    # risk and alerts
    flagged = wr[wr["is_substantive"].astype(bool)]
    money = {"amount": float(flagged["total_exposure"].sum()), "works": int(len(flagged)),
             "share_of_sanctioned": _ratio(flagged["total_exposure"].sum(), sanctioned_amount)}
    if g_sp:
        top = _top(flagged["total_exposure"], flagged[g_sp])
        money["top"] = top and {"name": top["name"], "amount": top["value"]}
    high = wr[wr["max_severity"] == "high"]
    high_sev = {"works": int(len(high)), "amount": float(high["total_exposure"].sum())}
    if g_sp:
        top = _top(pd.Series(1, index=high.index), high[g_sp])
        high_sev["top"] = top and {"name": top["name"], "works": int(top["value"])}

    cost = f[f["tag"] == COST_TAG].drop_duplicates(RISK_KEY)
    obs = cost["evidence"].apply(_observed)
    amt = pd.to_numeric(obs.apply(lambda o: o.get("sanction_amount")), errors="coerce")
    ratio = pd.to_numeric(obs.apply(lambda o: o.get("ratio_to_peer_median")), errors="coerce")
    above = (amt - amt / ratio).where(ratio > 1)
    cost_overruns = {"works": int(len(cost)), "above_peer": float(above.sum()),
                     "typical_ratio": round(float(ratio.median()), 1) if ratio.notna().any() else None}
    if g_f:
        top = _top(pd.Series(1, index=cost.index), cost[g_f])
        cost_overruns["top"] = top and {"name": top["name"], "works": int(top["value"])}

    # delays against the guideline limits
    age_rec = (as_of - rec).dt.days
    age_san = (as_of - san).dt.days
    awaiting = has_rec & ~has_san & (age_rec > sanction_days)
    unfinished = has_san & ~has_comp & (age_san > completion_days)
    due_soon = has_rec & ~has_san & (age_rec > sanction_days - DUE_SOON_DAYS) & (age_rec <= sanction_days)
    lag_san = (san - rec).dt.days
    both = has_rec & has_san & lag_san.notna() & (lag_san >= 0)
    lag_comp = (comp - san).dt.days
    done = has_san & has_comp & lag_comp.notna() & (lag_comp >= 0)
    delayed = {"works": int((awaiting | unfinished).sum()),
               "awaiting_sanction": int(awaiting.sum()), "unfinished": int(unfinished.sum()),
               "on_time_sanction_rate": _ratio((lag_san[both] <= sanction_days).sum(), both.sum()),
               "top": top_works(awaiting | unfinished)}

    early_rows = sp.merge(early, on=SPINE_KEY)
    early_warning = {"works": int(len(early_rows)),
                     "amount": float(early_rows["SANCTION_AMOUNT"].fillna(early_rows["rec_RECOMMENDED_AMOUNT"]).sum())}
    if g_sp:
        top = _top(pd.Series(1, index=early_rows.index), early_rows[g_sp])
        early_warning["top"] = top and {"name": top["name"], "works": int(top["value"])}

    evidence = tagged(EVIDENCE_TAG)
    evidence["share_of_completed"] = _ratio(evidence["works"], has_comp.sum())

    agency_money = sp[has_san & sp["exp_top_ia"].notna()].groupby("exp_top_ia")["SANCTION_AMOUNT"].sum()
    return {
        "guideline": {"sanction_days": sanction_days, "completion_days": completion_days,
                      "due_soon_days": DUE_SOON_DAYS},
        "money_at_risk": money,
        "high_severity": high_sev,
        "cost_overruns": cost_overruns,
        "duplicates": tagged(*DUPLICATE_TAGS),
        # distinct works with either - a work can be both, so never the sum
        "cost_or_duplicate": tagged(COST_TAG, *DUPLICATE_TAGS),
        "early_warning": early_warning,
        "delayed": delayed,
        "evidence_missing": evidence,
        "payment_without_completion": tagged(PAYMENT_TAG),
        "sanction_backlog": {"works": int(awaiting.sum()),
                             "amount": float(sp.loc[awaiting, "rec_RECOMMENDED_AMOUNT"].sum()),
                             "oldest_days": int(age_rec[awaiting].max()) if awaiting.any() else None},
        "sanction_due_soon": {"works": int(due_soon.sum()),
                              "amount": float(sp.loc[due_soon, "rec_RECOMMENDED_AMOUNT"].sum())},
        "overdue": {"works": int(unfinished.sum()), "amount": float(sp.loc[unfinished, "SANCTION_AMOUNT"].sum())},
        "assets_delivered": {"works": int(has_comp.sum()), "amount": float(sp.loc[has_comp, "comp_ACTUAL_AMOUNT"].sum())},
        "days_to_sanction": {"median": float(lag_san[both].median()) if both.any() else None},
        "flagged_share": {"share": _ratio(len(flagged), works)},
        "on_time_completion": {"share": _ratio((lag_comp[done] <= completion_days).sum(), done.sum()),
                               "on_time": int((lag_comp[done] <= completion_days).sum()), "completed": int(done.sum())},
        "agency_concentration": ({"agency": agency_money.idxmax(),
                                  "share": _ratio(agency_money.max(), agency_money.sum())}
                                 if agency_money.sum() > 0 else {"agency": None, "share": None}),
    }


_early = None
_early_lock = threading.Lock()


def early_warning_works() -> pd.DataFrame:
    """Open works still within their guideline deadline that the delay model
    (engine/predictive.py) rates high risk of missing it. Scored once - under
    a second for ~50k works - and kept, since the data snapshot is fixed."""
    global _early
    with _early_lock:
        if _early is None:
            s = get_store()
            as_of = pd.Timestamp(s.cfg["as_of_date"])
            limits = s.cfg["guideline"]
            sp = s.spine
            rec = pd.to_datetime(sp["rec_RECOMMENDATION_DATE"], errors="coerce")
            san = pd.to_datetime(sp["SANCTION_DATE"], errors="coerce")
            open_ = ((sp["has_recommended"] & ~sp["has_sanctioned"]
                      & ((as_of - rec).dt.days <= limits["sanction_days"]["value"]))
                     | (sp["has_sanctioned"] & ~sp["has_completed"]
                        & ((as_of - san).dt.days <= limits["completion_days"]["value"])))
            rows = sp[open_].assign(rec_RECOMMENDATION_DATE=rec[open_])
            bundle = predictive.get_model()
            X, _ = predictive.build_features(rows, history=sp.assign(rec_RECOMMENDATION_DATE=rec),
                                             tables=bundle["tables"])
            p = bundle["model"].predict_proba(X)[:, 1]
            if bundle.get("calibrator") is not None:
                p = bundle["calibrator"].predict(p)
            high = np.asarray(p) >= bundle.get("tiers", {"high": 0.70})["high"]
            _early = rows.loc[high, SPINE_KEY].reset_index(drop=True)
    return _early


def kpi_cards(sp: pd.DataFrame, wr: pd.DataFrame, group: tuple[str, str] | None = None) -> dict:
    """compute_kpis() over the store's own findings, limits and early-warning list."""
    s = get_store()
    limits = s.cfg["guideline"]
    return compute_kpis(sp, wr, s.findings, early_warning_works(), pd.Timestamp(s.cfg["as_of_date"]),
                        limits["sanction_days"]["value"], limits["completion_days"]["value"], group)
