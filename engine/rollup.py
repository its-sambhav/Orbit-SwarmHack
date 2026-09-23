"""Stage 6: aggregate findings into work_risk and the region rollups.

work_risk (one row per flagged work) - spec 5.5-5.7:
  per family, take the strongest finding s_f = severity_weight * confidence
  factor; Risk = 100 * [1 - prod_f (1 - s_f)]. Correlated tags inside one
  family (three delay tags on one stalled work) don't stack; independent
  families do. priority = Risk * (0.5 + 0.5 * E) with E from the work's own
  exposure. Suppressed findings don't count.

constituency / district / state / agency rollups - spec 5.9:
  shrunk flagged rate (k + a) / (n + a + b), a = p0*m, b = (1 - p0)*m, and
  exposure-weighted Risk sum(exposure * Risk) / sum(exposure). risk_score =
  shrunk rate * exposure-weighted Risk. Never sum(priority), which ranks a
  place by how many works it has rather than how it runs them.
"""
import json

import numpy as np
import pandas as pd

from engine.paths import DATA_PROCESSED
from engine.score import strength, exposure_factor

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
    f = f.assign(s=[strength(sev, conf, fam, sc) for sev, conf, fam in zip(f.severity, f.confidence, f.family)])

    per_family = f.groupby(KEY + ["family"])["s"].max().reset_index()
    per_family["log_keep"] = np.log1p(-per_family["s"].clip(upper=0.999999))
    risk = per_family.groupby(KEY).agg(log_keep=("log_keep", "sum"),
                                        families=("family", lambda s: sorted(set(s)))).reset_index()
    risk["risk"] = (100 * (1 - np.exp(risk["log_keep"]))).round(2)

    work_risk = f.groupby(KEY).agg(
        tags=("tag", lambda s: sorted(set(s))),
        detectors=("detector", lambda s: sorted(set(s))),
        finding_count=("finding_id", "size"),
        max_severity=("severity", lambda s: max(s, key=lambda v: SEV_RANK[v])),
    ).reset_index().merge(risk[KEY + ["risk", "families"]], on=KEY)

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
    work_risk["priority"] = (work_risk["risk"] * (0.5 + 0.5 * work_risk["total_exposure"].map(
        lambda e: exposure_factor(e, sc)))).round(3)
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
                   m: float = 50.0) -> pd.DataFrame:
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
    a, b = p0 * m, (1 - p0) * m
    out["breach_rate"] = out["works_flagged"] / out["works_total"]
    out["shrunk_rate"] = (out["works_flagged"] + a) / (out["works_total"] + a + b)
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


def build_constituency_risk(work_risk, spine, demo_scopes, cfg=None):
    out = _region_rollup(work_risk, spine, demo_scopes, ["CONSTITUENCY_ID"], ["CONSTITUENCY_ID"],
                         {"constituency": ("CONSTITUENCY", "first"), "state": ("STATE_NAME", "first")}, _m(cfg))
    return out


def build_district_risk(work_risk, spine, demo_scopes, cfg=None):
    out = _region_rollup(work_risk, spine, demo_scopes, ["STATE_NAME", "DISTRICT"], ["STATE_NAME", "DISTRICT"],
                         None, _m(cfg))
    return out.rename(columns={"STATE_NAME": "state", "DISTRICT": "district"})


def build_state_risk(work_risk, spine, demo_scopes, cfg=None):
    out = _region_rollup(work_risk, spine, demo_scopes, ["STATE_NAME"], ["STATE_NAME"],
                         {"districts": ("DISTRICT", "nunique")}, _m(cfg))
    return out.rename(columns={"STATE_NAME": "state"})


def build_agency_risk(work_risk, spine, demo_scopes, cfg=None):
    """Implementing agency = each work's largest-payment agency (exp_top_ia),
    only set once a work has any payment - works with none have no agency
    and are left out rather than lumped into an 'Unknown' row."""
    out = _region_rollup(work_risk, spine[spine["exp_top_ia"].notna()], demo_scopes, ["exp_top_ia"], ["exp_top_ia"],
                         None, _m(cfg))
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
