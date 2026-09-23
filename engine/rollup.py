"""Stage 6: aggregate findings into work_risk and the region rollups.

work_risk (one row per flagged work) - spec 5.5-5.7:
  per family, take the strongest finding's strength s_f (engine/score.py
  stores it on every finding: severity curve of its continuous
  severity_score * confidence factor); Risk = 100 * [1 - prod_f (1 - s_f)].
  Correlated tags inside one family (three delay tags on one stalled work)
  don't stack; independent families do. priority = Risk * (0.5 + 0.5 * E)
  with E from the work's own exposure. Suppressed findings don't count.

constituency / district / state / agency rollups - spec 5.9:
  shrunk flagged rate (k + p0*m) / (n + m) and exposure-weighted Risk
  sum(exposure * Risk) / sum(exposure); risk_score = shrunk rate *
  exposure-weighted Risk. Never sum(priority), which ranks a place by how
  many works it has rather than how it runs them. m (how hard a small
  region is pulled toward the overall rate) is estimated from the data at
  each level by default - see estimate_prior_strength.
"""
import json

import numpy as np
import pandas as pd

from engine.paths import DATA_PROCESSED
from engine.score import strength
from engine.severity import CENTRE as _BAND_CENTRE

SEV_RANK = {"low": 1, "medium": 2, "high": 3}
KEY = ["work_number", "scope_house", "scope_tenure"]

# A work whose only findings are paperwork (documentation) or a date-entry
# mismatch (data_integrity) hasn't shown a rupee or a timeline problem - see
# engine/score.py's own corroboration_excluded_families, which already
# treats these two families as not real corroborating evidence for the same
# reason. COMPLETION_EVIDENCE_NOT_ATTACHED alone was 28.6% of every
# completed+paid work (measured on the 2026-09-10 snapshot) and is_flagged
# rate/risk_score is a region's headline number - one detector about missing
# scans dominating "works flagged" made every district's ranking partly a
# measure of how well it uploads files rather than how it runs its works.
# is_substantive stays False->still visible: the work keeps its row (and its
# own low Risk, typically ~9) in work_risk and on its case file - it's only
# left out of the flagged counts and region risk_score fed by
# _region_rollup() below, which is a materiality judgement, not a decision
# to hide anything.
NON_SUBSTANTIVE_FAMILIES = {"documentation", "data_integrity"}


RANK_SEV = {v: k for k, v in SEV_RANK.items()}


def _finding_strengths(f: pd.DataFrame, sc: dict) -> pd.Series:
    """The strength engine/score.py stored on each finding; computed here
    only for rows that don't have one (an older findings file, a test)."""
    s = f["strength"].astype(float) if "strength" in f else pd.Series(np.nan, index=f.index)
    missing = s.isna()
    if missing.any():
        g = f[missing]
        xs = g["severity_score"] if "severity_score" in g else g["severity"]
        xs = [x if isinstance(x, str) or pd.notna(x) else sev for x, sev in zip(xs, g["severity"])]
        s[missing] = [strength(x, conf, fam, sc) for x, conf, fam in zip(xs, g["confidence"], g["family"])]
    return s


def exposure_factors(exposure: pd.Series, sc: dict) -> np.ndarray:
    """Vectorised engine/score.py exposure_factor: clip(log10(x / base) /
    decades, 0, 1), and 0 for no or non-positive exposure."""
    x = exposure.astype(float).to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        e = np.log10(x / sc["exposure_base"]) / sc["exposure_decades"]
    return np.where(x > 0, np.clip(np.nan_to_num(e, nan=0.0, neginf=0.0), 0, 1), 0.0)


def estimate_prior_strength(k: pd.Series, n: pd.Series, bounds=(5, 1000)) -> float:
    """Empirical-Bayes prior strength m for flagged rates k/n across regions
    (beta-binomial method of moments). The spread of observed rates is part
    real difference between regions (tau^2) and part binomial noise; with
    N = sum(n), p0 = sum(k)/N:
        sum n_i (r_i - p0)^2  ~  (R - 1) p0 (1 - p0) + tau^2 (N - sum(n_i^2)/N)
    and a Beta prior with mean p0 and variance tau^2 has m = p0(1-p0)/tau^2 - 1.
    Little real spread -> large m (trust the overall rate); a lot -> small m
    (trust each region's own rate). Clipped to `bounds`."""
    lo, hi = bounds
    keep = n > 0
    k, n = k[keep].astype(float), n[keep].astype(float)
    N = n.sum()
    if len(n) < 3 or N == 0:
        return float(hi)
    p0 = k.sum() / N
    if p0 <= 0 or p0 >= 1:
        return float(hi)
    between = float((n * (k / n - p0) ** 2).sum())
    denom = N - float((n ** 2).sum()) / N
    tau2 = (between - (len(n) - 1) * p0 * (1 - p0)) / denom if denom > 0 else 0.0
    if tau2 <= 0:
        return float(hi)
    return float(np.clip(p0 * (1 - p0) / tau2 - 1, lo, hi))


def _cfg(cfg):
    if cfg is None:
        from engine.detectors import load_config
        cfg = load_config()
    return cfg


def build_work_risk(findings_df: pd.DataFrame, spine: pd.DataFrame, demo_scopes: list[str], cfg: dict | None = None) -> pd.DataFrame:
    sc = _cfg(cfg)["scoring"]
    f = findings_df
    if "suppressed" in f:
        f = f[~f["suppressed"].fillna(False).astype(bool)]
    f = f.assign(family=f["evidence"].apply(lambda e: e["family"]))
    f = f.assign(s=_finding_strengths(f, sc), sev_rank=f["severity"].map(SEV_RANK),
                 sev_x=f["severity_score"] if "severity_score" in f else f["severity"].map(_BAND_CENTRE))

    per_family = f.groupby(KEY + ["family"])["s"].max().reset_index()
    per_family["log_keep"] = np.log1p(-per_family["s"].clip(upper=0.999999))
    risk = per_family.groupby(KEY).agg(log_keep=("log_keep", "sum"),
                                        families=("family", lambda s: sorted(set(s)))).reset_index()
    risk["risk"] = (100 * (1 - np.exp(risk["log_keep"]))).round(2)

    work_risk = f.groupby(KEY).agg(
        tags=("tag", lambda s: sorted(set(s))),
        detectors=("detector", lambda s: sorted(set(s))),
        finding_count=("finding_id", "size"),
        sev_rank=("sev_rank", "max"),
        max_severity_score=("sev_x", "max"),
    ).reset_index().merge(risk[KEY + ["risk", "families"]], on=KEY)
    work_risk["max_severity"] = work_risk.pop("sev_rank").map(RANK_SEV)
    work_risk["max_severity_score"] = work_risk["max_severity_score"].astype(float).round(4)

    spine_subset = spine[["WORK_RECOMMENDATION_DTL_ID", "SCOPE_HOUSE", "SCOPE_TENURE",
                          "STATE_NAME", "CONSTITUENCY", "CONSTITUENCY_ID", "MP_NAME",
                          "DISTRICT", "IDA_NAME_CLEAN", "WORK_STAGE_RESOLVED",
                          "SANCTION_AMOUNT", "rec_RECOMMENDED_AMOUNT",
                          "exp_top_ia", "exp_top_vendor", "exp_vendor_count"]].copy()
    spine_subset["work_number"] = spine_subset["WORK_RECOMMENDATION_DTL_ID"].astype("int64").astype(str)
    spine_subset = spine_subset.rename(columns={"SCOPE_HOUSE": "scope_house", "SCOPE_TENURE": "scope_tenure",
                                                "WORK_STAGE_RESOLVED": "lifecycle_stage"})
    spine_subset = spine_subset.drop(columns=["WORK_RECOMMENDATION_DTL_ID"])
    work_risk = work_risk.merge(spine_subset, on=KEY, how="left")

    # the work's own money (sanctioned, else recommended) - never a sum of
    # its findings' exposures, which include MP- and district-level totals
    work_risk["total_exposure"] = work_risk["SANCTION_AMOUNT"].fillna(work_risk["rec_RECOMMENDED_AMOUNT"]).fillna(0.0)
    work_risk = work_risk.drop(columns=["SANCTION_AMOUNT", "rec_RECOMMENDED_AMOUNT"])
    work_risk["priority"] = (work_risk["risk"] * (0.5 + 0.5 * exposure_factors(work_risk["total_exposure"], sc))).round(3)
    work_risk["in_demo_scope"] = work_risk["scope_tenure"].isin(demo_scopes)
    work_risk["is_substantive"] = work_risk["families"].apply(lambda fams: not set(fams).issubset(NON_SUBSTANTIVE_FAMILIES))
    return work_risk


def _tag_counts(flagged: pd.DataFrame, group_cols: list[str]) -> dict:
    """{group key (tuple if >1 col, else bare value): JSON {tag: count}} -
    JSON strings because a dict column with varying keys doesn't survive
    pyarrow's schema inference."""
    rows = flagged[[*group_cols, "tags"]].explode("tags").dropna(subset=["tags"])
    if rows.empty:
        return {}
    counts = rows.groupby([*group_cols, "tags"]).size().reset_index(name="n")
    out = {}
    for key, g in counts.groupby(group_cols if len(group_cols) > 1 else group_cols[0]):
        out[key] = json.dumps(dict(zip(g["tags"], g["n"].astype(int))))
    return out


def _region_rollup(work_risk: pd.DataFrame, spine: pd.DataFrame, demo_scopes: list[str],
                   spine_group: list[str], wr_group: list[str], extra_agg: dict | None = None,
                   m: float | str = 50.0, m_bounds=(5, 1000)) -> pd.DataFrame:
    scoped = spine[spine["SCOPE_TENURE"].isin(demo_scopes)]
    # "flagged" here means materially flagged - a work whose only findings
    # are paperwork/data-entry ones (is_substantive False) doesn't count
    # toward a region's works_flagged/breach_rate/risk_score. See
    # NON_SUBSTANTIVE_FAMILIES above.
    flagged = work_risk[work_risk["in_demo_scope"] & work_risk["is_substantive"]].copy()
    flagged["exp_x_risk"] = flagged["total_exposure"] * flagged["risk"]

    base = scoped.groupby(spine_group).agg(works_total=("WORK_RECOMMENDATION_DTL_ID", "size"),
                                           **(extra_agg or {})).reset_index()
    agg = flagged.groupby(wr_group).agg(
        works_flagged=("work_number", "size"), total_exposure=("total_exposure", "sum"),
        mean_priority=("priority", "mean"), exp_x_risk=("exp_x_risk", "sum"), mean_risk=("risk", "mean"),
    ).reset_index()
    if wr_group != spine_group:
        agg = agg.rename(columns=dict(zip(wr_group, spine_group)))
    out = base.merge(agg, on=spine_group, how="left")
    for col in ("works_flagged", "total_exposure", "mean_priority", "exp_x_risk", "mean_risk"):
        out[col] = out[col].fillna(0)
    out["works_flagged"] = out["works_flagged"].astype(int)

    n_all, k_all = out["works_total"].sum(), out["works_flagged"].sum()
    p0 = k_all / n_all if n_all else 0.0
    if m == "auto":
        m = estimate_prior_strength(out["works_flagged"], out["works_total"], m_bounds)
    out["breach_rate"] = out["works_flagged"] / out["works_total"]
    out["shrunk_rate"] = (out["works_flagged"] + p0 * m) / (out["works_total"] + m)
    out["shrinkage_m"] = round(float(m), 2)
    out["exposure_weighted_risk"] = np.where(out["total_exposure"] > 0,
                                             out["exp_x_risk"] / out["total_exposure"].replace(0, np.nan),
                                             out["mean_risk"])
    out["exposure_weighted_risk"] = out["exposure_weighted_risk"].fillna(0.0).round(2)
    out["risk_score"] = (out["shrunk_rate"] * out["exposure_weighted_risk"]).round(4)
    tags = _tag_counts(flagged.rename(columns=dict(zip(wr_group, spine_group))), spine_group)
    keys = out[spine_group].apply(tuple, axis=1) if len(spine_group) > 1 else out[spine_group[0]]
    out["tag_counts"] = keys.map(lambda k: tags.get(k, json.dumps({})))
    return out.drop(columns=["exp_x_risk", "mean_risk"])


def _m(cfg):
    return _cfg(cfg).get("rollup", {}).get("shrinkage_m", 50)


def _m_bounds(cfg):
    return tuple(_cfg(cfg).get("rollup", {}).get("shrinkage_m_bounds", (5, 1000)))


def build_constituency_risk(work_risk, spine, demo_scopes, cfg=None):
    out = _region_rollup(work_risk, spine, demo_scopes, ["CONSTITUENCY_ID"], ["CONSTITUENCY_ID"],
                         {"constituency": ("CONSTITUENCY", "first"), "state": ("STATE_NAME", "first")}, _m(cfg), _m_bounds(cfg))
    return out


def build_district_risk(work_risk, spine, demo_scopes, cfg=None):
    out = _region_rollup(work_risk, spine, demo_scopes, ["STATE_NAME", "DISTRICT"], ["STATE_NAME", "DISTRICT"],
                         None, _m(cfg), _m_bounds(cfg))
    return out.rename(columns={"STATE_NAME": "state", "DISTRICT": "district"})


def build_state_risk(work_risk, spine, demo_scopes, cfg=None):
    out = _region_rollup(work_risk, spine, demo_scopes, ["STATE_NAME"], ["STATE_NAME"],
                         {"districts": ("DISTRICT", "nunique")}, _m(cfg), _m_bounds(cfg))
    return out.rename(columns={"STATE_NAME": "state"})


def build_agency_risk(work_risk, spine, demo_scopes, cfg=None):
    """Implementing agency = each work's largest-payment agency (exp_top_ia),
    only set once a work has any payment - works with none have no agency
    and are left out rather than lumped into an 'Unknown' row."""
    out = _region_rollup(work_risk, spine[spine["exp_top_ia"].notna()], demo_scopes, ["exp_top_ia"], ["exp_top_ia"],
                         None, _m(cfg), _m_bounds(cfg))
    return out.rename(columns={"exp_top_ia": "agency"})


def build_queue(work_risk: pd.DataFrame, queue_cfg: dict) -> pd.DataFrame:
    """Membership is decided by priority alone. The isolation-forest score
    (if attached) only reorders works inside the same priority band - it
    never brings a work in or pushes one out (spec 6.1)."""
    eligible = work_risk[work_risk["in_demo_scope"] & (work_risk["total_exposure"] >= queue_cfg["materiality_floor"])]
    # only bites if high_severity_min_exposure is ever raised above
    # materiality_floor - at today's equal values (both 500000) every row
    # here has already cleared the floor above, so this drops nothing; kept
    # so a future config change can't silently let a high-severity, low-
    # exposure work back into the queue.
    eligible = eligible[~((eligible["max_severity"] == "high")
                          & (eligible["total_exposure"] < queue_cfg["high_severity_min_exposure"]))]
    queue = eligible.nlargest(queue_cfg["max_queue_size"], "priority").copy()
    queue["priority_band"] = np.floor(queue["priority"] / queue_cfg["anomaly_reorder_band"])
    order = ["priority_band"] + (["anomaly_score"] if "anomaly_score" in queue else []) + ["priority"]
    queue = queue.sort_values(order, ascending=False)
    queue["queue_rank"] = np.arange(1, len(queue) + 1)
    return queue


def run(findings: list[dict], cfg: dict, anomaly: pd.DataFrame | None = None):
    spine = pd.read_parquet(DATA_PROCESSED / "spine.parquet")
    demo_scopes = cfg["queue"]["demo_scopes"]

    findings_df = pd.DataFrame(findings)
    findings_df["scope_house"] = findings_df["entities"].apply(lambda e: e["scope_house"])
    findings_df["scope_tenure"] = findings_df["entities"].apply(lambda e: e["scope_tenure"])

    work_risk = build_work_risk(findings_df, spine, demo_scopes, cfg)
    if anomaly is not None:
        work_risk = work_risk.merge(anomaly, on=KEY, how="left")
    constituency_risk = build_constituency_risk(work_risk, spine, demo_scopes, cfg)
    district_risk = build_district_risk(work_risk, spine, demo_scopes, cfg)
    state_risk = build_state_risk(work_risk, spine, demo_scopes, cfg)

    queue = build_queue(work_risk, cfg["queue"])
    work_risk = work_risk.merge(queue[KEY + ["queue_rank"]], on=KEY, how="left")
    work_risk["in_queue"] = work_risk["queue_rank"].notna()

    in_scope = int(spine["SCOPE_TENURE"].isin(demo_scopes).sum())
    print(f"  queue: {len(queue):,} / {in_scope:,} in-scope works = {len(queue) / in_scope * 100:.2f}%")
    print(f"  flagged per 1,000: all-scope {len(work_risk) / len(spine) * 1000:.1f}  "
          f"in-scope {work_risk['in_demo_scope'].sum() / in_scope * 1000:.1f}")
    return work_risk, constituency_risk, district_risk, state_risk


if __name__ == "__main__":
    print(__doc__)
