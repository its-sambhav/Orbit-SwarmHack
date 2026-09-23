"""Stage 4: detectors. Pure functions over the lifecycle spine.

Every detector has the signature `detect(spine, cfg, ctx) -> list[dict]`:
  spine - the prepared one-row-per-work table (see prepare_spine)
  cfg   - config/detectors.yaml
  ctx   - {"tags": config/tags.yaml tags, "payments": expenditure rows,
           "allocated": allocation table, "calamity": calamity table}
so tests can run each one on a tiny hand-made table (tests/).

Two lanes (config/detectors.yaml):
- rule: a hard fact read straight off the record (paid > sanction, a
  payment with no sanction, a delay past a fixed hard-breach limit).
- statistical: a work that is far from its peers, or a pattern that needs a
  person to judge. Its severity here is the RAW severity; engine/score.py
  caps statistical findings at medium unless another family corroborates.

`severity` stays low/medium/high and `confidence` rule/statistical - no new
tiers. Values that can't be computed are None, never a stand-in number.
"""
import re
import warnings

import numpy as np
import pandas as pd
import yaml

from engine.paths import CONFIG_DIR, DATA_INTERIM, DATA_PROCESSED

# config regexes use groups for readability; str.contains only needs a yes/no
warnings.filterwarnings("ignore", message="This pattern is interpreted as a regular expression, and has match groups")

WORK_KEY = ["WORK_RECOMMENDATION_DTL_ID", "SCOPE_HOUSE", "SCOPE_TENURE"]
SEVERITIES = ["low", "medium", "high"]


def load_config() -> dict:
    with open(CONFIG_DIR / "detectors.yaml", encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_tags() -> dict:
    with open(CONFIG_DIR / "tags.yaml", encoding="utf-8") as f:
        return yaml.safe_load(f)


def cfg_value(v):
    """Config values that carry a `verified` flag are {value, verified}."""
    return v["value"] if isinstance(v, dict) and "value" in v else v


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------
def val(x):
    """JSON-safe scalar: None for NaN/NaT, plain Python for numpy types."""
    if x is None:
        return None
    if isinstance(x, (np.bool_, bool)):
        return bool(x)
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, (np.floating, float)):
        return None if np.isnan(x) else float(x)
    try:
        if pd.isna(x):
            return None
    except (TypeError, ValueError):
        pass
    return x


def num(x):
    v = val(x)
    return float(v) if v is not None else None


def iso(ts) -> str | None:
    return ts.date().isoformat() if ts is not None and pd.notna(ts) else None


def rupees(x) -> str:
    return f"₹{x:,.0f}" if x is not None and pd.notna(x) else "an unknown amount"


def norm_text(s: pd.Series) -> pd.Series:
    """Spec 4.5: lowercase, punctuation to space, collapse spaces."""
    return (s.fillna("").astype(str).str.lower()
            .str.replace(r"[^\w\s]", " ", regex=True)
            .str.replace(r"\s+", " ", regex=True).str.strip())


_HONORIFICS = re.compile(r"\b(shri|shrimati|smt|sri|dr|adv|advocate|prof|kumari|km|mr|mrs|ms|col|capt|thiru|tmt)\b")


def norm_person(name) -> str:
    """17th Lok Sabha names carry a '(17th Lok Sabha)' suffix and honorifics
    vary between tables - both have to go before comparing two MP names, or
    one MP across two tenures reads as two MPs."""
    if name is None or (isinstance(name, float) and np.isnan(name)):
        return ""
    s = re.sub(r"\(.*?\)", " ", str(name).lower())
    s = re.sub(r"[^\w\s]", " ", s)
    s = _HONORIFICS.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()


def jaccard(a: frozenset, b: frozenset) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def robust_z(values: pd.Series, min_mad: float = 0.0) -> pd.Series:
    """Spec 4.3: z = 0.6745 * (x - median) / MAD. A group with MAD == 0 is
    skipped (NaN). min_mad floors a tiny-but-nonzero MAD (see UNUSUAL_COST)."""
    med = values.median()
    mad = (values - med).abs().median()
    if not mad or np.isnan(mad):
        return pd.Series(np.nan, index=values.index)
    return 0.6745 * (values - med) / max(mad, min_mad)


# ---------------------------------------------------------------------------
# spine preparation
# ---------------------------------------------------------------------------
def prepare_spine(spine: pd.DataFrame, cfg: dict) -> pd.DataFrame:
    spine = spine.copy()
    as_of = pd.Timestamp(cfg["as_of_date"])

    for col in ("has_recommended", "has_sanctioned", "has_completed", "has_expenditure"):
        spine[col] = spine[col].fillna(False).astype(bool)
    for col in ("exp_any_success", "exp_any_inprogress"):
        spine[col] = spine[col].fillna(False).astype(bool) if col in spine else False

    def coalesce(*cols):
        out = pd.Series(np.nan, index=spine.index, dtype=object)
        for c in cols:
            if c in spine:
                out = out.where(out.notna(), spine[c])
        return out

    spine["ACTIVITY"] = coalesce("san_ACTIVITY_NAME_CLEAN", "rec_ACTIVITY_NAME_CLEAN", "comp_ACTIVITY_NAME_CLEAN")
    spine["DESCRIPTION"] = coalesce("rec_WORK_DESCRIPTION", "san_WORK_DESCRIPTION", "comp_WORK_DESCRIPTION")
    spine["WORK_CATEGORY"] = coalesce("rec_WORK_CATEGORY", "san_WORK_CATEGORY", "comp_WORK_CATEGORY")
    spine["best_amount"] = spine["SANCTION_AMOUNT"].fillna(spine["rec_RECOMMENDED_AMOUNT"])

    spine["age_since_recommendation"] = (as_of - spine["rec_RECOMMENDATION_DATE"]).dt.days
    spine["age_since_sanction"] = (as_of - spine["SANCTION_DATE"]).dt.days
    spine["sanction_lag"] = (spine["SANCTION_DATE"] - spine["rec_RECOMMENDATION_DATE"]).dt.days
    spine["completion_lag"] = (spine["comp_ACTUAL_END_DATE"] - spine["SANCTION_DATE"]).dt.days
    spine["days_since_last_payment"] = (as_of - spine["exp_last_date"]).dt.days

    mcc = cfg["delay_gate"].get("mcc_adjustment", {})
    if mcc.get("enabled"):
        overlap = pd.Series(0, index=spine.index, dtype="float64")
        for start, end in mcc["windows"]:
            s, e = pd.Timestamp(start), pd.Timestamp(end)
            lo = spine["rec_RECOMMENDATION_DATE"].clip(lower=s)
            hi = spine["SANCTION_DATE"].clip(upper=e)
            overlap += (hi - lo).dt.days.clip(lower=0).fillna(0)
        spine["sanction_lag"] = spine["sanction_lag"] - overlap

    spine["payment_status"] = np.where(
        spine["exp_any_success"], "Payment Success",
        np.where(spine["exp_any_inprogress"], "Payment In-Progress", None))

    inactive = cfg_value(cfg["detectors"]["ALLOCATION_LIMIT_EXCEEDED"].get("inactive_rec_flags", [])) or []
    spine["is_inactive_rec"] = spine["rec_FLAG"].isin(inactive) if "rec_FLAG" in spine else False
    return spine


# ---------------------------------------------------------------------------
# finding construction
# ---------------------------------------------------------------------------
def _get(row, name):
    return val(getattr(row, name, None))


def build_finding(row, detector_id: str, c: dict, ctx: dict, *, severity: str, financial_exposure,
                  observed: dict, threshold: dict, deviation: str, stage: str | None = None,
                  peer_benchmark: dict | None = None, scope: str = "work", method: str | None = None) -> dict:
    tag = ctx["tags"][c["tag"]]
    wid = int(getattr(row, "WORK_RECOMMENDATION_DTL_ID"))
    house, tenure = _get(row, "SCOPE_HOUSE"), _get(row, "SCOPE_TENURE")
    has_exp = bool(_get(row, "has_expenditure"))
    exposure = num(financial_exposure)
    return {
        "finding_id": f"{detector_id}:{wid}:{house}:{tenure}",
        "work_number": str(wid),
        "detector": detector_id,
        "tag": tag["name"],
        "severity": severity,
        "confidence": c["confidence"],
        "financial_exposure": exposure if exposure is not None else 0.0,
        "evidence": {
            "observed": observed,
            "threshold": {**threshold, "source": tag["source"]},
            "peer_benchmark": peer_benchmark,
            "deviation": deviation,
            "family": tag["family"],
            "tag_key": c["tag"],
            "source_verified": bool(tag["verified"]),
            "raw_severity": severity,
            "scope": scope,          # work | mp_portfolio | district | calamity
            "method": method,
            "context": {
                "lifecycle_stage": _get(row, "WORK_STAGE_RESOLVED"),
                "payment_status": _get(row, "payment_status"),
                "category": _get(row, "WORK_CATEGORY"),
            },
        },
        "entities": {
            "state": _get(row, "STATE_NAME"),
            "constituency": _get(row, "CONSTITUENCY"),
            "constituency_id": int(_get(row, "CONSTITUENCY_ID")) if _get(row, "CONSTITUENCY_ID") is not None else None,
            "district": _get(row, "DISTRICT"),
            "lgd_code": None,
            "mp_name": _get(row, "MP_NAME"),
            "implementing_agency": _get(row, "exp_top_ia") if has_exp else None,
            "vendor": _get(row, "exp_top_vendor") if has_exp else None,
            "vendor_count": int(_get(row, "exp_vendor_count") or 0) if has_exp else 0,
            "scope_house": house,
            "scope_tenure": tenure,
        },
        "suppressed": False,
        "suppression_reason": None,
        "routed_to": None,   # filled by score.py
        "stage": stage or c.get("stage"),
    }


def _enabled(cfg, det_id) -> dict | None:
    c = cfg["detectors"].get(det_id)
    return c if c and c.get("enabled", True) else None


def _anchor(rows: pd.DataFrame):
    """An MP- or district-level finding has to hang off one work; use that
    group's largest work (evidence.scope says the finding is not about it)."""
    return rows.loc[rows["best_amount"].fillna(0).idxmax()]


# ---------------------------------------------------------------------------
# shared statistical delay gate (spec 4.1)
# ---------------------------------------------------------------------------
LEVEL_LABEL = {
    ("STATE_NAME", "ACTIVITY", "SCOPE_TENURE"): "state x activity x tenure",
    ("STATE_NAME", "SCOPE_TENURE"): "state x tenure",
    ("SCOPE_TENURE",): "tenure",
}


def peer_percentiles(pop: pd.DataFrame, metric: str, dg: dict) -> pd.DataFrame:
    """Per-row peer percentiles of `metric`, from the most specific peer level
    that has >= min_peers works (else the next level, else the last)."""
    pcts = dg["severity_percentiles"]
    qs = {"p_low": pcts["low"] / 100, "p_medium": pcts["medium"] / 100, "p_high": pcts["high"] / 100}
    out = pd.DataFrame(index=pop.index, columns=["p_low", "p_medium", "p_high", "p_median", "n_peers", "peer_level"],
                       dtype=object)
    todo = pd.Series(True, index=pop.index)
    levels = dg["peer_levels"]
    for i, keys in enumerate(levels):
        if not todo.any():
            break
        g = pop.groupby(keys, dropna=False)[metric]
        n = g.transform("count")
        take = todo & ((n >= dg["min_peers"]) | (i == len(levels) - 1))
        if not take.any():
            continue
        for col, q in qs.items():
            out.loc[take, col] = g.transform("quantile", q)[take]
        out.loc[take, "p_median"] = g.transform("median")[take]
        out.loc[take, "n_peers"] = n[take]
        out.loc[take, "peer_level"] = LEVEL_LABEL.get(tuple(keys), " x ".join(keys))
        todo &= ~take
    for col in ("p_low", "p_medium", "p_high", "p_median", "n_peers"):
        out[col] = pd.to_numeric(out[col])
    return out


def _delay(spine, cfg, ctx, det_id, base_mask, metric, exposure_fn, what, hit_filter=None,
           extra_observed=None):
    c = _enabled(cfg, det_id)
    if not c:
        return []
    dg = cfg["delay_gate"]
    pop = spine[base_mask & spine[metric].notna() & (spine["age_since_recommendation"] >= dg["min_age_days"])]
    if pop.empty:
        return []
    peers = peer_percentiles(pop, metric, dg)
    floor = dg["floors"][c["floor"]]
    gate = np.maximum(peers["p_low"], floor)
    hit = pop[metric] > gate
    if hit_filter is not None:
        hit &= hit_filter(pop)
    guideline = None
    if c["floor"] == "sanction_lag":
        guideline = cfg_value(cfg["guideline"]["sanction_days"])
    elif c["floor"] == "completion_lag":
        guideline = cfg_value(cfg["guideline"]["completion_days"])

    findings = []
    for row in pop[hit].itertuples():
        p = peers.loc[row.Index]
        v = float(getattr(row, metric))
        sev = "high" if v > p.p_high else "medium" if v > p.p_medium else "low"
        observed = {"days": v}
        if extra_observed:
            observed.update(extra_observed(row))
        findings.append(build_finding(
            row, det_id, c, ctx, severity=sev, financial_exposure=exposure_fn(row),
            observed=observed,
            threshold={"gate_days": round(float(gate[row.Index]), 1), "floor_days": float(floor),
                       "guideline_days": float(guideline) if guideline else None},
            peer_benchmark={"peer_group": p.peer_level, "n_peers": int(p.n_peers),
                            "peer_median_days": round(float(p.p_median), 1),
                            "p90_days": round(float(p.p_low), 1), "p95_days": round(float(p.p_medium), 1),
                            "p99_days": round(float(p.p_high), 1)},
            deviation=(f"{what}: {v:.0f} days - slower than {cfg['delay_gate']['severity_percentiles']['low']}% "
                       f"of {int(p.n_peers):,} comparable works ({p.peer_level}); their median is "
                       f"{p.p_median:.0f} days"
                       + (f"; guideline is {guideline} days" if guideline else "")),
            method="max(P90 of peers, floor)",
        ))
    return findings


# ---------------------------------------------------------------------------
# A. Sanction stage
# ---------------------------------------------------------------------------
def detect_delay_in_sanction(spine, cfg, ctx):
    base = spine.has_sanctioned & spine.has_recommended
    return _delay(spine, cfg, ctx, "DELAY_IN_SANCTION", base, "sanction_lag",
                  lambda r: r.SANCTION_AMOUNT, "Recommendation to sanction")


def detect_recommendation_pending_sanction(spine, cfg, ctx):
    base = spine.has_recommended & ~spine.has_sanctioned & ~spine.is_inactive_rec
    return _delay(spine, cfg, ctx, "RECOMMENDATION_PENDING_SANCTION", base, "age_since_recommendation",
                  lambda r: r.rec_RECOMMENDED_AMOUNT, "Waiting for sanction")


def detect_sanctioned_not_taken_up(spine, cfg, ctx):
    c = cfg["detectors"]["SANCTIONED_WORK_NOT_TAKEN_UP"]
    base = (spine.has_sanctioned & ~spine.has_completed & ~spine.has_expenditure
            & spine.WORK_STAGE_RESOLVED.isin(c["not_started_stages"]))
    return _delay(spine, cfg, ctx, "SANCTIONED_WORK_NOT_TAKEN_UP", base, "age_since_sanction",
                  lambda r: r.SANCTION_AMOUNT, "Sanctioned, not started, no payment")


# ---------------------------------------------------------------------------
# B. Execution stage
# ---------------------------------------------------------------------------
def detect_delay_in_completion(spine, cfg, ctx):
    base = spine.has_completed & spine.has_sanctioned
    return _delay(spine, cfg, ctx, "DELAY_IN_COMPLETION", base, "completion_lag",
                  lambda r: r.comp_ACTUAL_AMOUNT if pd.notna(r.comp_ACTUAL_AMOUNT) else r.SANCTION_AMOUNT,
                  "Sanction to completion")


def detect_work_not_completed(spine, cfg, ctx):
    c = cfg["detectors"]["WORK_NOT_COMPLETED"]
    not_started = cfg["detectors"]["SANCTIONED_WORK_NOT_TAKEN_UP"]["not_started_stages"]
    # disjoint from Sanctioned Work Not Taken Up: that one owns the
    # never-started, never-paid works
    base = (spine.has_sanctioned & ~spine.has_completed & (spine.WORK_STAGE_RESOLVED != "Work Completed")
            & ~(spine.WORK_STAGE_RESOLVED.isin(not_started) & ~spine.has_expenditure))
    quiet = c["no_payment_days"]
    return _delay(spine, cfg, ctx, "WORK_NOT_COMPLETED", base, "age_since_sanction",
                  lambda r: r.SANCTION_AMOUNT, "Open since sanction",
                  hit_filter=lambda p: ~p.has_expenditure | (p.days_since_last_payment > quiet),
                  extra_observed=lambda r: {"days_since_last_payment": num(r.days_since_last_payment)})


def detect_payment_without_completion(spine, cfg, ctx):
    base = spine.has_sanctioned & ~spine.has_completed & (spine.payment_status == "Payment Success")
    return _delay(spine, cfg, ctx, "PAYMENT_WITHOUT_COMPLETION", base, "age_since_sanction",
                  lambda r: r.exp_total_disbursed, "Paid but not completed, open since sanction",
                  extra_observed=lambda r: {"total_paid": num(r.exp_total_disbursed)})


def detect_prolonged_delay(spine, cfg, ctx):
    """Rule lane (spec 4.2): fixed hard-breach limits, whatever the peers do."""
    hb = cfg["hard_breach"]
    out = []
    lanes = [
        ("PROLONGED_DELAY_SANCTION_LAG", spine.has_sanctioned & spine.has_recommended
         & (spine.sanction_lag > hb["sanction_lag_days"]), "sanction_lag", hb["sanction_lag_days"],
         "SANCTION_AMOUNT", "Sanctioned {v:.0f} days after recommendation"),
        ("PROLONGED_DELAY_UNSANCTIONED", spine.has_recommended & ~spine.has_sanctioned & ~spine.is_inactive_rec
         & (spine.age_since_recommendation > hb["unsanctioned_age_days"]), "age_since_recommendation",
         hb["unsanctioned_age_days"], "rec_RECOMMENDED_AMOUNT", "Unsanctioned for {v:.0f} days"),
        ("PROLONGED_DELAY_OPEN", spine.has_sanctioned & ~spine.has_completed
         & (spine.age_since_sanction > hb["open_after_sanction_days"]), "age_since_sanction",
         hb["open_after_sanction_days"], "SANCTION_AMOUNT", "Still open {v:.0f} days after sanction"),
    ]
    for det_id, mask, metric, limit, amount_col, text in lanes:
        c = _enabled(cfg, det_id)
        if not c:
            continue
        for row in spine[mask].itertuples():
            v = float(getattr(row, metric))
            exposure = num(getattr(row, amount_col))
            ratio = v / limit
            sev = "high" if ratio >= hb["severity_high_ratio"] else "medium"
            out.append(build_finding(
                row, det_id, c, ctx, severity=sev, financial_exposure=exposure,
                observed={"days": v},
                threshold={"limit_days": float(limit), "severity_high_ratio": float(hb["severity_high_ratio"])},
                deviation=text.format(v=v) + f" - past the fixed {limit}-day limit "
                           f"({ratio:.1f}x that limit)",
                method="fixed hard-breach limit"))
    return out


# ---------------------------------------------------------------------------
# C. Expenditure
# ---------------------------------------------------------------------------
def detect_excess_expenditure(spine, cfg, ctx):
    c = _enabled(cfg, "EXCESS_EXPENDITURE")
    if not c:
        return []
    m = spine.has_sanctioned & spine.has_expenditure & (spine.SANCTION_AMOUNT > 0) \
        & (spine.exp_total_disbursed / spine.SANCTION_AMOUNT > c["max_ratio"])
    return [build_finding(
        r, "EXCESS_EXPENDITURE", c, ctx, severity=c["severity"],
        financial_exposure=r.exp_total_disbursed - r.SANCTION_AMOUNT,
        observed={"total_paid": num(r.exp_total_disbursed), "sanction_amount": num(r.SANCTION_AMOUNT),
                  "ratio": round(r.exp_total_disbursed / r.SANCTION_AMOUNT, 4)},
        threshold={"max_ratio": c["max_ratio"]},
        deviation=f"Paid {rupees(r.exp_total_disbursed)} against a sanction of {rupees(r.SANCTION_AMOUNT)}")
        for r in spine[m].itertuples()]


def detect_sanction_exceeds_recommendation(spine, cfg, ctx):
    c = _enabled(cfg, "SANCTION_EXCEEDS_RECOMMENDATION")
    if not c:
        return []
    m = spine.has_sanctioned & spine.has_recommended & (spine.rec_RECOMMENDED_AMOUNT > 0) \
        & (spine.SANCTION_AMOUNT / spine.rec_RECOMMENDED_AMOUNT > c["max_ratio"])
    return [build_finding(
        r, "SANCTION_EXCEEDS_RECOMMENDATION", c, ctx, severity=c["severity"],
        financial_exposure=r.SANCTION_AMOUNT - r.rec_RECOMMENDED_AMOUNT,
        observed={"sanction_amount": num(r.SANCTION_AMOUNT), "recommended_amount": num(r.rec_RECOMMENDED_AMOUNT),
                  "ratio": round(r.SANCTION_AMOUNT / r.rec_RECOMMENDED_AMOUNT, 4)},
        threshold={"max_ratio": c["max_ratio"]},
        deviation=f"Sanctioned {rupees(r.SANCTION_AMOUNT)} against a recommendation of {rupees(r.rec_RECOMMENDED_AMOUNT)}")
        for r in spine[m].itertuples()]


def detect_expenditure_without_sanction(spine, cfg, ctx):
    c = _enabled(cfg, "EXPENDITURE_WITHOUT_SANCTION")
    if not c:
        return []
    paid = spine.has_expenditure & (spine.exp_total_disbursed > 0)
    m = paid & ((spine.WORK_STAGE_RESOLVED == "Pending for Sanction") | ~spine.has_sanctioned
                | (spine.exp_first_date < spine.SANCTION_DATE))
    out = []
    for r in spine[m].itertuples():
        if not r.has_sanctioned or r.WORK_STAGE_RESOLVED == "Pending for Sanction":
            text = f"{rupees(r.exp_total_disbursed)} paid while the work has no sanction"
        else:
            text = f"First payment on {iso(r.exp_first_date)}, before the sanction on {iso(r.SANCTION_DATE)}"
        out.append(build_finding(
            r, "EXPENDITURE_WITHOUT_SANCTION", c, ctx, severity=c["severity"], financial_exposure=r.exp_total_disbursed,
            observed={"total_paid": num(r.exp_total_disbursed), "first_payment_date": iso(r.exp_first_date),
                      "sanction_date": iso(r.SANCTION_DATE)},
            threshold={}, deviation=text))
    return out


def detect_expenditure_after_completion(spine, cfg, ctx):
    c = _enabled(cfg, "EXPENDITURE_AFTER_COMPLETION")
    if not c:
        return []
    pay = ctx["payments"]
    done = spine[spine.has_completed & spine.has_expenditure]
    if done.empty or pay is None or pay.empty:
        return []
    x = pay[WORK_KEY + ["EXPENDITURE_DATE", "FUND_DISBURSED_AMT"]].merge(
        done[WORK_KEY + ["comp_ACTUAL_END_DATE"]], on=WORK_KEY)
    post = (x[x.EXPENDITURE_DATE > x.comp_ACTUAL_END_DATE].groupby(WORK_KEY)["FUND_DISBURSED_AMT"]
            .sum().rename("post_paid").reset_index())
    d = done.reset_index().merge(post, on=WORK_KEY, how="left").set_index("index")
    d["post_paid"] = d["post_paid"].fillna(0.0)
    lag = (d.exp_last_date - d.comp_ACTUAL_END_DATE).dt.days
    share = d.post_paid / d.exp_total_disbursed.where(d.exp_total_disbursed > 0)
    m = (lag > c["min_lag_days"]) & (share > c["min_post_share"])
    out = []
    for r in d[m].itertuples():
        days = float(lag[r.Index])
        out.append(build_finding(
            r, "EXPENDITURE_AFTER_COMPLETION", c, ctx,
            severity="medium" if days > c["medium_lag_days"] else "low",
            financial_exposure=r.post_paid,
            observed={"completion_date": iso(r.comp_ACTUAL_END_DATE), "last_payment_date": iso(r.exp_last_date),
                      "days": days, "post_completion_paid": num(r.post_paid),
                      "post_completion_share": round(float(share[r.Index]), 4)},
            threshold={"min_lag_days": float(c["min_lag_days"]), "min_post_share": c["min_post_share"]},
            deviation=(f"{rupees(r.post_paid)} ({share[r.Index] * 100:.0f}% of total paid) paid after completion; "
                       f"last payment {days:.0f} days after the completion date")))
    return out


def detect_unusual_cost(spine, cfg, ctx):
    c = _enabled(cfg, "UNUSUAL_COST")
    if not c:
        return []
    base = spine[spine.has_sanctioned & (spine.SANCTION_AMOUNT > 0)].copy()
    base["log_amount"] = np.log10(base.SANCTION_AMOUNT)
    keys = c["peer_keys"]
    g = base.groupby(keys, dropna=False)["log_amount"]
    base["n_peers"] = g.transform("size")
    base = base[base.n_peers >= c["min_peers"]].copy()
    if base.empty:
        return []
    g = base.groupby(keys, dropna=False)["log_amount"]
    base["z"] = g.transform(lambda v: robust_z(v, c["min_mad_log10"]))
    base["peer_median_log"] = g.transform("median")
    base["peer_mad_log"] = g.transform(lambda v: (v - v.median()).abs().median())
    hits = base[base.z >= c["z_low"]]
    out = []
    for r in hits.itertuples():
        median_amt = 10 ** r.peer_median_log
        out.append(build_finding(
            r, "UNUSUAL_COST", c, ctx, severity="medium" if r.z >= c["z_medium"] else "low",
            financial_exposure=r.SANCTION_AMOUNT - median_amt,
            observed={"sanction_amount": num(r.SANCTION_AMOUNT), "robust_z": round(float(r.z), 2),
                      "ratio_to_peer_median": round(float(r.SANCTION_AMOUNT / median_amt), 2)},
            threshold={"z_low": c["z_low"], "z_medium": c["z_medium"], "min_peers": float(c["min_peers"]),
                       "min_mad_log10": c["min_mad_log10"]},
            peer_benchmark={"peer_state": _get(r, "STATE_NAME"), "peer_activity": _get(r, "ACTIVITY"),
                            "n_peers": int(r.n_peers), "peer_median_amount": round(float(median_amt), 0),
                            "peer_mad_log10": round(float(r.peer_mad_log), 4)},
            deviation=(f"{rupees(r.SANCTION_AMOUNT)} is {r.SANCTION_AMOUNT / median_amt:.1f}x the peer median "
                       f"{rupees(median_amt)} for '{_get(r, 'ACTIVITY')}' in {_get(r, 'STATE_NAME')} "
                       f"({int(r.n_peers)} works; robust z {r.z:.1f})"),
            method="robust z of log10(sanction) within state x activity"))
    return out


def detect_payment_completion_mismatch(spine, cfg, ctx):
    c = _enabled(cfg, "PAYMENT_COMPLETION_MISMATCH")
    if not c:
        return []
    m = spine.has_completed & spine.has_expenditure & (spine.comp_ACTUAL_AMOUNT > 0)
    gap = (spine.exp_total_disbursed - spine.comp_ACTUAL_AMOUNT).abs() / spine.comp_ACTUAL_AMOUNT
    m &= gap > c["max_relative_gap"]
    return [build_finding(
        r, "PAYMENT_COMPLETION_MISMATCH", c, ctx, severity="low",
        financial_exposure=abs(r.exp_total_disbursed - r.comp_ACTUAL_AMOUNT),
        observed={"total_paid": num(r.exp_total_disbursed), "completed_amount": num(r.comp_ACTUAL_AMOUNT),
                  "relative_gap": round(float(gap[r.Index]), 4)},
        threshold={"max_relative_gap": c["max_relative_gap"]},
        deviation=f"Paid {rupees(r.exp_total_disbursed)} but the completion record says {rupees(r.comp_ACTUAL_AMOUNT)}")
        for r in spine[m].itertuples()]


# ---------------------------------------------------------------------------
# D. Eligibility and entitlement
# ---------------------------------------------------------------------------
def detect_prohibited_work(spine, cfg, ctx):
    c = _enabled(cfg, "PROHIBITED_WORK")
    if not c:
        return []
    text = norm_text(spine["DESCRIPTION"])
    pattern = "|".join(f"(?:{p})" for p in c["patterns"])
    hit = text.str.contains(pattern, regex=True) & ~text.str.contains(c["exceptions"], regex=True)
    hit &= ~text.str.contains(c["location_exclusion"], regex=True)
    hit &= spine.has_recommended | spine.has_sanctioned
    out = []
    for r in spine[hit].itertuples():
        m = re.search(pattern, text[r.Index])
        out.append(build_finding(
            r, "PROHIBITED_WORK", c, ctx, severity="low", financial_exposure=r.best_amount,
            observed={"matched_phrase": m.group(0) if m else None},
            threshold={},
            deviation=f"Description mentions '{m.group(0) if m else ''}' - check against the Annexure-II negative list",
            method="phrase match on the work description; needs manual check"))
    return out


def detect_trust_society_limit(spine, cfg, ctx):
    c = _enabled(cfg, "TRUST_SOCIETY_LIMIT_EXCEEDED")
    if not c:
        return []
    cap = cfg_value(c["cap_per_mp_per_fy"])
    t = spine[spine.has_recommended & (spine.WORK_CATEGORY == c["category"]) & ~spine.is_inactive_rec].copy()
    if t.empty:
        return []
    d = t.rec_RECOMMENDATION_DATE
    t["fy"] = np.where(d.dt.month >= 4, d.dt.year, d.dt.year - 1)
    out = []
    for (mp, tenure, fy), grp in t.groupby(["MP_NAME", "SCOPE_TENURE", "fy"]):
        total = grp.rec_RECOMMENDED_AMOUNT.sum()
        if total <= cap:
            continue
        r = _anchor(grp)
        out.append(build_finding(
            r, "TRUST_SOCIETY_LIMIT_EXCEEDED", c, ctx, severity=c["severity"], financial_exposure=total - cap,
            observed={"financial_year": f"{int(fy)}-{str(int(fy) + 1)[-2:]}", "trust_society_recommended": float(total),
                      "works_counted": int(len(grp))},
            threshold={"cap": float(cap)}, scope="mp_portfolio",
            deviation=(f"{rupees(total)} recommended to trusts/societies by this MP in FY {int(fy)}-{str(int(fy) + 1)[-2:]} "
                       f"across {len(grp)} works, above the {rupees(cap)} ceiling")))
    return out


def detect_allocation_limit(spine, cfg, ctx):
    c = _enabled(cfg, "ALLOCATION_LIMIT_EXCEEDED")
    if not c:
        return []
    alloc = ctx["allocated"]
    if alloc is None or alloc.empty:
        return []
    active = spine[spine.has_recommended & ~spine.is_inactive_rec]
    totals = active.groupby(["MP_NAME", "SCOPE_TENURE"])["rec_RECOMMENDED_AMOUNT"].sum()
    allocs = alloc.groupby(["MP_NAME", "SCOPE_TENURE"])["ALLOCATED_AMT"].sum()
    merged = pd.concat([totals.rename("recommended"), allocs.rename("allocated")], axis=1).dropna()
    merged = merged[merged.allocated > 0]
    over = merged[(merged.recommended - merged.allocated) / merged.allocated > c["min_overage_share"]]
    out = []
    for (mp, tenure), row in over.iterrows():
        grp = active[(active.MP_NAME == mp) & (active.SCOPE_TENURE == tenure)]
        overage = row.recommended - row.allocated
        out.append(build_finding(
            _anchor(grp), "ALLOCATION_LIMIT_EXCEEDED", c, ctx, severity=c["severity"], financial_exposure=overage,
            observed={"total_recommended": float(row.recommended), "allocated": float(row.allocated),
                      "overage_share": round(float(overage / row.allocated), 4), "works_counted": int(len(grp))},
            threshold={"min_overage_share": c["min_overage_share"]}, scope="mp_portfolio",
            deviation=(f"{rupees(row.recommended)} of active recommendations against a {rupees(row.allocated)} "
                       f"allocation - {overage / row.allocated * 100:.1f}% over")))
    return out


def detect_sc_st_shortfall(spine, cfg, ctx):
    c = _enabled(cfg, "SC_ST_EARMARK_SHORTFALL")
    if not c:
        return []
    rec = spine[spine.has_recommended & ~spine.is_inactive_rec & spine.rec_RECOMMENDED_AMOUNT.notna()].copy()
    if rec.empty:
        return []
    text = norm_text(rec["rec_WORK_DESCRIPTION"].fillna("") + " " + rec["rec_ACTIVITY_NAME_CLEAN"].fillna(""))
    seat = rec["CONSTITUENCY"].fillna("").astype(str).str.upper()
    # whole phrases and the reserved-seat suffix only - never a bare "st",
    # which matches "St." in place names
    rec["is_sc"] = seat.str.contains(r"\(SC\)", regex=True) | text.str.contains(c["sc_phrases"], regex=True)
    rec["is_st"] = seat.str.contains(r"\(ST\)", regex=True) | text.str.contains(c["st_phrases"], regex=True)
    out = []
    for (mp, tenure), grp in rec.groupby(["MP_NAME", "SCOPE_TENURE"]):
        total = grp.rec_RECOMMENDED_AMOUNT.sum()
        if total < c["min_portfolio_amount"]:
            continue
        sc_share = grp.loc[grp.is_sc, "rec_RECOMMENDED_AMOUNT"].sum() / total
        st_share = grp.loc[grp.is_st, "rec_RECOMMENDED_AMOUNT"].sum() / total
        sc_short = max(0.0, c["sc_target_share"] - sc_share) * total
        st_short = max(0.0, c["st_target_share"] - st_share) * total
        shortfall = sc_short + st_short
        if shortfall < c["min_shortfall_amount"]:
            continue
        out.append(build_finding(
            _anchor(grp), "SC_ST_EARMARK_SHORTFALL", c, ctx, severity=c["severity"], financial_exposure=shortfall,
            observed={"total_recommended": float(total), "sc_share_estimated": round(float(sc_share), 4),
                      "st_share_estimated": round(float(st_share), 4), "sc_shortfall": float(sc_short),
                      "st_shortfall": float(st_short)},
            threshold={"sc_target_share": c["sc_target_share"], "st_target_share": c["st_target_share"]},
            scope="mp_portfolio",
            deviation=(f"Estimated: {sc_share * 100:.1f}% to SC areas (target 15%) and {st_share * 100:.1f}% to ST "
                       f"areas (target 7.5%) of {rupees(total)} - estimated shortfall {rupees(shortfall)}"),
            method="estimated from reserved-seat suffix and whole-phrase keywords"))
    return out


def detect_unspent_balance(spine, cfg, ctx):
    c = _enabled(cfg, "UNSPENT_BALANCE")
    if not c:
        return []
    alloc = ctx["allocated"]
    if alloc is None or alloc.empty:
        return []
    as_of = pd.Timestamp(cfg["as_of_date"])
    a = alloc.copy()
    a["end"] = pd.to_datetime(a["TENURE_END_DATE"], errors="coerce", format="mixed")
    per_mp = a.groupby(["MP_NAME", "SCOPE_TENURE"]).agg(allocated=("ALLOCATED_AMT", "sum"), end=("end", "max"))
    if c.get("completed_tenures_only", True):
        per_mp = per_mp[per_mp.end < as_of]
    paid = spine.groupby(["MP_NAME", "SCOPE_TENURE"])["exp_total_disbursed"].sum()
    per_mp = per_mp.join(paid.rename("paid"), how="inner")
    per_mp = per_mp[per_mp.allocated > 0]
    per_mp["util"] = per_mp.paid / per_mp.allocated
    out = []
    for (mp, tenure), row in per_mp[per_mp.util < c["min_utilisation"]].iterrows():
        grp = spine[(spine.MP_NAME == mp) & (spine.SCOPE_TENURE == tenure)]
        if grp.empty:
            continue
        out.append(build_finding(
            _anchor(grp), "UNSPENT_BALANCE", c, ctx, severity=c["severity"],
            financial_exposure=row.allocated - row.paid,
            observed={"allocated": float(row.allocated), "total_paid": float(row.paid),
                      "utilisation": round(float(row.util), 4), "tenure_end": iso(row.end)},
            threshold={"min_utilisation": c["min_utilisation"]}, scope="mp_portfolio",
            deviation=(f"Tenure ended {iso(row.end)} with {row.util * 100:.0f}% of the {rupees(row.allocated)} "
                       f"allocation spent")))
    return out


# ---------------------------------------------------------------------------
# E. Duplication and concentration
# ---------------------------------------------------------------------------
def detect_duplicate_work(spine, cfg, ctx):
    c = _enabled(cfg, "DUPLICATE_WORK")
    if not c:
        return []
    base = spine[spine.has_recommended & spine.rec_WORK_DESCRIPTION.notna()].copy()
    if c.get("exclude_inactive", True):
        base = base[~base.is_inactive_rec]
    base["nd"] = norm_text(base.rec_WORK_DESCRIPTION)
    base["act"] = base.rec_ACTIVITY_NAME_CLEAN.fillna(base.ACTIVITY)
    base = base[(base.nd.str.len() >= c["min_description_length"]) & (base.nd != norm_text(base.act))]
    base["grp_size"] = base.groupby(["CONSTITUENCY_ID", "act", "nd"], dropna=False)["nd"].transform("size")
    hits = base[(base.grp_size >= c["min_group_size"]) & (base.grp_size <= c["max_group_size"])]
    out = []
    for _, grp in hits.groupby(["CONSTITUENCY_ID", "act", "nd"], dropna=False):
        ids = grp.WORK_RECOMMENDATION_DTL_ID.astype("int64").astype(str).tolist()
        for r in grp.itertuples():
            others = [w for w in ids if w != str(int(r.WORK_RECOMMENDATION_DTL_ID))]
            out.append(build_finding(
                r, "DUPLICATE_WORK", c, ctx, severity="high" if len(others) == 1 else "medium",
                financial_exposure=r.rec_RECOMMENDED_AMOUNT,
                observed={"matched_works": others, "matched_work_count": len(others),
                          "recommended_amount": num(r.rec_RECOMMENDED_AMOUNT)},
                threshold={"min_description_length": float(c["min_description_length"]),
                           "max_group_size": float(c["max_group_size"])},
                deviation=(f"Same description as work #{others[0]}"
                           + (f" and {len(others) - 1} more" if len(others) > 1 else "")
                           + " in the same constituency and activity")))
    return out


def detect_same_work_multiple_mps(spine, cfg, ctx):
    c = _enabled(cfg, "SAME_WORK_MULTIPLE_MPS")
    if not c:
        return []
    b = spine[spine.has_recommended & ~spine.is_inactive_rec & (spine.rec_RECOMMENDED_AMOUNT > 0)].copy()
    b["nd"] = norm_text(b.rec_WORK_DESCRIPTION)
    b = b[b.nd.str.len() >= c["min_description_length"]]
    if b.empty:
        return []
    b["mp_norm"] = b.MP_NAME.map(norm_person)
    b["tokens"] = b.nd.str.split().map(frozenset)

    parent = {}

    def find(x):
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    tol, min_j = c["amount_tolerance"], c["min_jaccard"]
    for _, g in b.groupby("IDA_NAME_CLEAN"):
        if g.mp_norm.nunique() < 2:
            continue
        g = g.sort_values("rec_RECOMMENDED_AMOUNT")
        idx, amt, mps = g.index.values, g.rec_RECOMMENDED_AMOUNT.values, g.mp_norm.values
        nds, toks = g.nd.values, g.tokens.values
        for i in range(len(g)):
            hi = amt[i] * (1 + tol)
            j = i + 1
            while j < len(g) and amt[j] <= hi:
                if mps[j] != mps[i]:
                    la, lb = len(toks[i]), len(toks[j])
                    if nds[i] == nds[j] or (min(la, lb) / max(la, lb) >= min_j and jaccard(toks[i], toks[j]) >= min_j):
                        parent[find(idx[i])] = find(idx[j])
                j += 1

    clusters: dict = {}
    for i in list(parent):
        clusters.setdefault(find(i), []).append(i)
    out = []
    for members in clusters.values():
        if not (2 <= len(members) <= c["max_group_size"]):
            continue
        grp = b.loc[members]
        if grp.mp_norm.nunique() < 2:
            continue
        ids = grp.WORK_RECOMMENDATION_DTL_ID.astype("int64").astype(str).tolist()
        for r in grp.itertuples():
            others = [w for w in ids if w != str(int(r.WORK_RECOMMENDATION_DTL_ID))]
            other_mps = sorted(set(grp.MP_NAME) - {r.MP_NAME})
            out.append(build_finding(
                r, "SAME_WORK_MULTIPLE_MPS", c, ctx, severity=c["severity"], financial_exposure=r.rec_RECOMMENDED_AMOUNT,
                observed={"matched_works": others, "matched_work_count": len(others),
                          "other_mps": other_mps, "recommended_amount": num(r.rec_RECOMMENDED_AMOUNT)},
                threshold={"amount_tolerance": tol, "min_jaccard": min_j},
                deviation=(f"Same work (description and amount within {tol * 100:.0f}%) recommended by "
                           f"{', '.join(other_mps)} - work #{', #'.join(others)}")))
    return out


def detect_agency_concentration(spine, cfg, ctx):
    """From payment rows (spec 4.4), not each work's largest-payment agency:
    s_i = agency paid / district paid, HHI = sum(s_i^2) per tenure x district."""
    c = _enabled(cfg, "AGENCY_CONCENTRATION")
    if not c:
        return []
    pay = ctx["payments"]
    if pay is None or pay.empty:
        return []
    p = pay.dropna(subset=["IA_NAME_CLEAN", "DISTRICT"])
    by_agency = p.groupby(["SCOPE_TENURE", "DISTRICT", "IA_NAME_CLEAN"])["FUND_DISBURSED_AMT"].sum().rename("agency_paid").reset_index()
    by_agency = by_agency[by_agency.agency_paid > 0]
    district = by_agency.groupby(["SCOPE_TENURE", "DISTRICT"]).agg(
        district_paid=("agency_paid", "sum"), district_agencies=("agency_paid", "size")).reset_index()
    m = by_agency.merge(district, on=["SCOPE_TENURE", "DISTRICT"])
    m["share"] = m.agency_paid / m.district_paid
    m["hhi"] = m.groupby(["SCOPE_TENURE", "DISTRICT"])["share"].transform(lambda s: float((s ** 2).sum()))
    eligible = m[(m.district_agencies >= c["min_district_agencies"]) & (m.district_paid >= c["min_district_value"])].copy()
    if eligible.empty:
        return []
    pc = c["severity_percentiles"]
    q = eligible.groupby("SCOPE_TENURE")["share"].quantile([pc["low"] / 100, pc["medium"] / 100, pc["high"] / 100]).unstack()
    q.columns = ["p_low", "p_medium", "p_high"]
    eligible = eligible.merge(q, left_on="SCOPE_TENURE", right_index=True)
    hits = eligible[(eligible.share > eligible.p_low) & (eligible.hhi > c["min_hhi"])]

    per_work = p.groupby(WORK_KEY + ["IA_NAME_CLEAN", "DISTRICT"])["FUND_DISBURSED_AMT"].sum().reset_index()
    keyed = spine.reset_index().set_index(WORK_KEY)
    out = []
    for h in hits.itertuples():
        works = per_work[(per_work.SCOPE_TENURE == h.SCOPE_TENURE) & (per_work.DISTRICT == h.DISTRICT)
                         & (per_work.IA_NAME_CLEAN == h.IA_NAME_CLEAN)]
        top = works.loc[works.FUND_DISBURSED_AMT.idxmax()]
        key = tuple(top[k] for k in WORK_KEY)
        if key not in keyed.index:
            continue
        row = keyed.loc[[key]].reset_index().iloc[0]
        sev = "high" if h.share > h.p_high else "medium" if h.share > h.p_medium else "low"
        out.append(build_finding(
            row, "AGENCY_CONCENTRATION", c, ctx, severity=sev, financial_exposure=h.agency_paid,
            observed={"district": h.DISTRICT, "agency": h.IA_NAME_CLEAN, "agency_paid": float(h.agency_paid),
                      "district_paid": float(h.district_paid), "district_agencies": int(h.district_agencies),
                      "share": round(float(h.share), 4), "hhi": round(float(h.hhi), 4),
                      "agency_works": int(len(works))},
            threshold={"p90_share": round(float(h.p_low), 4), "min_hhi": c["min_hhi"],
                       "min_district_agencies": float(c["min_district_agencies"]),
                       "min_district_value": float(c["min_district_value"])},
            scope="district",
            deviation=(f"'{h.IA_NAME_CLEAN}' received {h.share * 100:.0f}% of payments in {h.DISTRICT} "
                       f"({h.SCOPE_TENURE}) across {int(h.district_agencies)} agencies; district HHI {h.hhi:.2f}"),
            method="share of district payment rows; HHI"))
    return out


# ---------------------------------------------------------------------------
# F. Record integrity
# ---------------------------------------------------------------------------
def detect_completion_evidence(spine, cfg, ctx):
    c = _enabled(cfg, "COMPLETION_EVIDENCE_NOT_ATTACHED")
    if not c:
        return []
    m = spine.has_completed & (spine.payment_status == "Payment Success") & spine.comp_ATTACH_ID.isna()
    return [build_finding(
        r, "COMPLETION_EVIDENCE_NOT_ATTACHED", c, ctx, severity=c["severity"], financial_exposure=r.exp_total_disbursed,
        observed={"completion_date": iso(r.comp_ACTUAL_END_DATE), "total_paid": num(r.exp_total_disbursed),
                  "file_attached": False},
        threshold={},
        deviation=(f"Completed and paid {rupees(r.exp_total_disbursed)}, but there is no supporting file on the "
                   f"completion record (this does not prove a photo is missing)"))
        for r in spine[m].itertuples()]


def detect_record_date_discrepancy(spine, cfg, ctx):
    c = _enabled(cfg, "RECORD_DATE_DISCREPANCY")
    if not c:
        return []
    san_before_rec = spine.SANCTION_DATE < spine.rec_RECOMMENDATION_DATE
    comp_before_san = spine.comp_ACTUAL_END_DATE < spine.SANCTION_DATE
    out = []
    for r in spine[san_before_rec | comp_before_san].itertuples():
        if san_before_rec[r.Index]:
            text = f"Sanctioned {iso(r.SANCTION_DATE)}, before the recommendation on {iso(r.rec_RECOMMENDATION_DATE)}"
        else:
            text = f"Completed {iso(r.comp_ACTUAL_END_DATE)}, before the sanction on {iso(r.SANCTION_DATE)}"
        out.append(build_finding(
            r, "RECORD_DATE_DISCREPANCY", c, ctx, severity=c["severity"], financial_exposure=r.best_amount,
            observed={"recommendation_date": iso(r.rec_RECOMMENDATION_DATE), "sanction_date": iso(r.SANCTION_DATE),
                      "completion_date": iso(r.comp_ACTUAL_END_DATE)},
            threshold={}, deviation=text))
    return out


def detect_calamity_consent(spine, cfg, ctx):
    c = _enabled(cfg, "CALAMITY_CONSENT_DISCREPANCY")
    if not c:
        return []
    cal = ctx["calamity"]
    if cal is None or cal.empty:
        return []
    cap = cfg_value(c["max_consent_per_mp"])
    cal = cal.copy()
    cal["event"] = norm_text(cal.CALAMITY_NAME)
    cal["mp_norm"] = cal.MP_NAME.map(norm_person)
    sp = spine[["MP_NAME", "SCOPE_TENURE", "best_amount"]].copy()
    sp["mp_norm"] = sp.MP_NAME.map(norm_person)

    issues = []   # (mp_norm, tenure, text, exposure, observed)
    types = cal.groupby("event")["TYPE"].nunique()
    for event in types[types > 1].index:
        rows = cal[cal.event == event]
        for r in rows.itertuples():
            issues.append((r.mp_norm, r.SCOPE_TENURE, f"'{r.CALAMITY_NAME}' is recorded as both "
                           f"{' and '.join(sorted(rows.TYPE.unique()))}", r.CONSENTED_AMOUNT,
                           {"calamity": r.CALAMITY_NAME, "types": sorted(rows.TYPE.unique())}))
    per_mp = cal.groupby(["mp_norm", "SCOPE_TENURE"])["CONSENTED_AMOUNT"].sum()
    for (mp, tenure), total in per_mp[per_mp > cap].items():
        issues.append((mp, tenure, f"Total calamity consent {rupees(total)} is above the {rupees(cap)} ceiling",
                       total - cap, {"total_consented": float(total)}))

    out, seen = [], set()
    for mp, tenure, text, exposure, observed in issues:
        works = spine[(sp.mp_norm == mp) & (sp.SCOPE_TENURE == tenure)]
        if works.empty:
            continue   # no work to anchor to - reported by run()
        r = _anchor(works)
        det_key = (int(r.WORK_RECOMMENDATION_DTL_ID), r.SCOPE_HOUSE, r.SCOPE_TENURE)
        if det_key in seen:
            continue
        seen.add(det_key)
        out.append(build_finding(
            r, "CALAMITY_CONSENT_DISCREPANCY", c, ctx, severity=c["severity"], financial_exposure=exposure,
            observed=observed, threshold={"max_consent_per_mp": float(cap)}, scope="calamity", deviation=text))
    return out


DETECTORS = [
    detect_delay_in_sanction, detect_recommendation_pending_sanction, detect_sanctioned_not_taken_up,
    detect_delay_in_completion, detect_work_not_completed, detect_payment_without_completion,
    detect_prolonged_delay,
    detect_excess_expenditure, detect_sanction_exceeds_recommendation, detect_expenditure_without_sanction,
    detect_expenditure_after_completion, detect_unusual_cost, detect_payment_completion_mismatch,
    detect_prohibited_work, detect_trust_society_limit, detect_allocation_limit, detect_sc_st_shortfall,
    detect_unspent_balance,
    detect_duplicate_work, detect_same_work_multiple_mps, detect_agency_concentration,
    detect_completion_evidence, detect_record_date_discrepancy, detect_calamity_consent,
]


def load_context() -> dict:
    def maybe(path):
        return pd.read_parquet(path) if path.exists() else None
    return {
        "tags": load_tags()["tags"],
        "payments": maybe(DATA_PROCESSED / "expenditure.parquet"),
        "allocated": maybe(DATA_INTERIM / "allocated.parquet"),
        "calamity": maybe(DATA_INTERIM / "calamity.parquet"),
    }


def run(spine: pd.DataFrame | None = None, cfg: dict | None = None, ctx: dict | None = None) -> list[dict]:
    cfg = cfg or load_config()
    ctx = ctx or load_context()
    if spine is None:
        spine = pd.read_parquet(DATA_PROCESSED / "spine.parquet")
    spine = prepare_spine(spine, cfg)

    findings = []
    for fn in DETECTORS:
        f = fn(spine, cfg, ctx)
        findings += f
        counts: dict = {}
        for x in f:
            counts[x["detector"]] = counts.get(x["detector"], 0) + 1
        for det, n in sorted(counts.items()):
            print(f"  {det:42} {n:>8,}")
    print(f"\n  total findings: {len(findings):,}")
    return findings


def demo():
    findings = run()
    tags = {t["name"] for t in load_tags()["tags"].values()}
    for f in findings:
        assert f["tag"] in tags, f"unregistered tag {f['tag']}"
        assert f["severity"] in SEVERITIES and f["confidence"] in ("rule", "statistical")
        assert f["entities"]["constituency_id"] is not None, f["finding_id"]
    ids = [f["finding_id"] for f in findings]
    assert len(ids) == len(set(ids)), "duplicate finding_id"
    print(f"detectors self-check: PASS ({len(findings):,} findings, all tags registered)")


if __name__ == "__main__":
    demo()
