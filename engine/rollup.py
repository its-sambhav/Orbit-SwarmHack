"""Stage 6: aggregate work-level findings into work_risk and constituency_risk.

Necessary, not precautionary: raw detection produces ~400K findings over
~220K distinct works (see docs/SCHEMA.md) - a correct detection result and
an unusable review queue. work_risk (one row per work) and constituency_risk
(one row per PC, for the choropleth) are what the dashboard actually reads;
findings.parquet stays the evidence store behind the case-file view.
"""
import json

import pandas as pd

from engine.paths import DATA_PROCESSED

SEV_RANK = {"low": 1, "medium": 2, "high": 3}


def build_work_risk(findings_df: pd.DataFrame, spine: pd.DataFrame, demo_scopes: list[str]) -> pd.DataFrame:
    work_risk = findings_df.groupby(["work_number", "scope_house", "scope_tenure"]).agg(
        tags=("tag", lambda s: sorted(set(s))),
        detectors=("detector", lambda s: sorted(set(s))),
        finding_count=("finding_id", "size"),
        max_severity=("severity", lambda s: max(s, key=lambda v: SEV_RANK[v])),
        total_exposure=("financial_exposure", "sum"),          # sum across this work's findings
        priority=("priority_score", "max"),                     # max, not sum - avoids one work's
                                                                  # several findings compounding into
                                                                  # an inflated rank
    ).reset_index()

    spine_subset = spine[["WORK_RECOMMENDATION_DTL_ID", "SCOPE_HOUSE", "SCOPE_TENURE",
                           "STATE_NAME", "CONSTITUENCY", "CONSTITUENCY_ID", "MP_NAME",
                           "DISTRICT", "IDA_NAME_CLEAN",
                           "exp_top_ia", "exp_top_vendor", "exp_vendor_count"]].copy()
    spine_subset["work_number"] = spine_subset["WORK_RECOMMENDATION_DTL_ID"].astype("int64").astype(str)
    spine_subset = spine_subset.rename(columns={"SCOPE_HOUSE": "scope_house", "SCOPE_TENURE": "scope_tenure"})
    spine_subset = spine_subset.drop(columns=["WORK_RECOMMENDATION_DTL_ID"])

    work_risk = work_risk.merge(spine_subset, on=["work_number", "scope_house", "scope_tenure"], how="left")
    work_risk["in_demo_scope"] = work_risk["scope_tenure"].isin(demo_scopes)
    return work_risk


def build_constituency_risk(work_risk: pd.DataFrame, spine: pd.DataFrame, demo_scopes: list[str]) -> pd.DataFrame:
    scoped_spine = spine[spine["SCOPE_TENURE"].isin(demo_scopes)]
    flagged = work_risk[work_risk["in_demo_scope"]]

    constituency_risk = scoped_spine.groupby("CONSTITUENCY_ID").agg(
        constituency=("CONSTITUENCY", "first"),
        state=("STATE_NAME", "first"),
        works_total=("WORK_RECOMMENDATION_DTL_ID", "size"),
    ).reset_index()

    flagged_agg = flagged.groupby("CONSTITUENCY_ID").agg(
        works_flagged=("work_number", "size"),
        total_exposure=("total_exposure", "sum"),
        mean_priority=("priority", "mean"),
        risk_score=("priority", "sum"),   # drives choropleth shading
    ).reset_index()

    constituency_risk = constituency_risk.merge(flagged_agg, on="CONSTITUENCY_ID", how="left")
    constituency_risk["works_flagged"] = constituency_risk["works_flagged"].fillna(0).astype(int)
    constituency_risk["total_exposure"] = constituency_risk["total_exposure"].fillna(0.0)
    constituency_risk["mean_priority"] = constituency_risk["mean_priority"].fillna(0.0)
    constituency_risk["risk_score"] = constituency_risk["risk_score"].fillna(0.0)
    constituency_risk["breach_rate"] = constituency_risk["works_flagged"] / constituency_risk["works_total"]

    tag_counts = _tag_counts_json(flagged, ["CONSTITUENCY_ID"])
    constituency_risk["tag_counts"] = constituency_risk["CONSTITUENCY_ID"].map(
        lambda cid: tag_counts.get((cid,), json.dumps({})))
    return constituency_risk


def _tag_counts_json(flagged: pd.DataFrame, group_cols: list[str]) -> dict:
    """dict keyed by the group tuple (or bare value for a single group_col),
    value a JSON string of {tag: count} - dict-per-row with heterogeneous
    keys doesn't survive pyarrow's schema inference cleanly (same defensive
    move as export.py's nested-struct fallback for findings.parquet)."""
    tag_rows = flagged[[*group_cols, "tags"]].explode("tags")
    counts = tag_rows.groupby([*group_cols, "tags"]).size().reset_index(name="n")
    grouped = counts.groupby(group_cols).apply(
        lambda g: json.dumps(dict(zip(g["tags"], g["n"].astype(int)))), include_groups=False)
    return grouped.to_dict()


def build_district_risk(work_risk: pd.DataFrame, spine: pd.DataFrame, demo_scopes: list[str]) -> pd.DataFrame:
    """One row per (state, district) - the District Authority dashboard's
    unit. DISTRICT is derived from IDA_NAME text (see normalise.py) since no
    district field exists in the source data; grouping by (state, district)
    together avoids any cross-state same-name collision."""
    scoped_spine = spine[spine["SCOPE_TENURE"].isin(demo_scopes)]
    flagged = work_risk[work_risk["in_demo_scope"]]
    group = ["STATE_NAME", "DISTRICT"]

    district_risk = scoped_spine.groupby(group).agg(
        works_total=("WORK_RECOMMENDATION_DTL_ID", "size"),
    ).reset_index()
    flagged_agg = flagged.groupby(group).agg(
        works_flagged=("work_number", "size"), total_exposure=("total_exposure", "sum"),
        mean_priority=("priority", "mean"), risk_score=("priority", "sum"),
    ).reset_index()

    district_risk = district_risk.merge(flagged_agg, on=group, how="left")
    for col, default in [("works_flagged", 0), ("total_exposure", 0.0), ("mean_priority", 0.0), ("risk_score", 0.0)]:
        district_risk[col] = district_risk[col].fillna(default)
    district_risk["works_flagged"] = district_risk["works_flagged"].astype(int)
    district_risk["breach_rate"] = district_risk["works_flagged"] / district_risk["works_total"]

    tag_map = _tag_counts_json(flagged, group)
    district_risk["tag_counts"] = district_risk.apply(
        lambda r: tag_map.get((r["STATE_NAME"], r["DISTRICT"]), json.dumps({})), axis=1)
    return district_risk.rename(columns={"STATE_NAME": "state", "DISTRICT": "district"})


def build_agency_risk(work_risk: pd.DataFrame, spine: pd.DataFrame, demo_scopes: list[str]) -> pd.DataFrame:
    """One row per implementing agency (exp_top_ia) - the Implementing Agency
    dashboard's unit. Unlike state/district, an agency has no geographic
    parent to disambiguate on, so the name itself is the whole identity - and
    that identity is real but imperfect: exp_top_ia is each work's single
    largest-disbursement row's agency name, only whitespace/case-normalised
    (not fuzzy-clustered - see docs/SCHEMA.md), and only populated once a
    work has any expenditure at all (~70% of works, never for a work still at
    Recommended/Sanctioned with zero disbursement). pandas groupby drops NaN
    keys by default, which is exactly right here - never emit a fake
    "Unknown agency" row for the un-attributed 30%."""
    scoped_spine = spine[spine["SCOPE_TENURE"].isin(demo_scopes)]
    flagged = work_risk[work_risk["in_demo_scope"]]
    group = "exp_top_ia"

    agency_risk = scoped_spine.groupby(group).agg(
        works_total=("WORK_RECOMMENDATION_DTL_ID", "size"),
    ).reset_index()
    flagged_agg = flagged.groupby(group).agg(
        works_flagged=("work_number", "size"), total_exposure=("total_exposure", "sum"),
        mean_priority=("priority", "mean"), risk_score=("priority", "sum"),
    ).reset_index()

    agency_risk = agency_risk.merge(flagged_agg, on=group, how="left")
    for col, default in [("works_flagged", 0), ("total_exposure", 0.0), ("mean_priority", 0.0), ("risk_score", 0.0)]:
        agency_risk[col] = agency_risk[col].fillna(default)
    agency_risk["works_flagged"] = agency_risk["works_flagged"].astype(int)
    agency_risk["breach_rate"] = agency_risk["works_flagged"] / agency_risk["works_total"]

    # _tag_counts_json keys its dict by the bare value (not a tuple) when
    # given a single group column - verified directly, not by pattern-copying
    # build_state_risk's analogous line below, which uses a tuple key and as
    # a result never actually matches (a pre-existing bug, left alone here
    # since fixing it isn't part of this change).
    tag_map = _tag_counts_json(flagged, [group])
    agency_risk["tag_counts"] = agency_risk[group].map(lambda a: tag_map.get(a, json.dumps({})))
    return agency_risk.rename(columns={"exp_top_ia": "agency"})


def build_state_risk(work_risk: pd.DataFrame, spine: pd.DataFrame, demo_scopes: list[str]) -> pd.DataFrame:
    """One row per state - the State Nodal Authority dashboard's unit."""
    scoped_spine = spine[spine["SCOPE_TENURE"].isin(demo_scopes)]
    flagged = work_risk[work_risk["in_demo_scope"]]

    state_risk = scoped_spine.groupby("STATE_NAME").agg(
        works_total=("WORK_RECOMMENDATION_DTL_ID", "size"),
        districts=("DISTRICT", "nunique"),
    ).reset_index()
    flagged_agg = flagged.groupby("STATE_NAME").agg(
        works_flagged=("work_number", "size"), total_exposure=("total_exposure", "sum"),
        mean_priority=("priority", "mean"), risk_score=("priority", "sum"),
    ).reset_index()

    state_risk = state_risk.merge(flagged_agg, on="STATE_NAME", how="left")
    for col, default in [("works_flagged", 0), ("total_exposure", 0.0), ("mean_priority", 0.0), ("risk_score", 0.0)]:
        state_risk[col] = state_risk[col].fillna(default)
    state_risk["works_flagged"] = state_risk["works_flagged"].astype(int)
    state_risk["breach_rate"] = state_risk["works_flagged"] / state_risk["works_total"]

    tag_map = _tag_counts_json(flagged, ["STATE_NAME"])
    state_risk["tag_counts"] = state_risk["STATE_NAME"].map(lambda s: tag_map.get((s,), json.dumps({})))
    return state_risk.rename(columns={"STATE_NAME": "state"})


def build_queue(work_risk: pd.DataFrame, queue_cfg: dict) -> pd.DataFrame:
    eligible = work_risk[work_risk["in_demo_scope"] & (work_risk["total_exposure"] >= queue_cfg["materiality_floor"])]
    return eligible.nlargest(queue_cfg["max_queue_size"], "priority")


def run(findings: list[dict], cfg: dict) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    spine = pd.read_parquet(DATA_PROCESSED / "spine.parquet")
    demo_scopes = cfg["queue"]["demo_scopes"]

    findings_df = pd.DataFrame(findings)
    findings_df["scope_house"] = findings_df["entities"].apply(lambda e: e["scope_house"])
    findings_df["scope_tenure"] = findings_df["entities"].apply(lambda e: e["scope_tenure"])

    work_risk = build_work_risk(findings_df, spine, demo_scopes)
    constituency_risk = build_constituency_risk(work_risk, spine, demo_scopes)
    district_risk = build_district_risk(work_risk, spine, demo_scopes)
    state_risk = build_state_risk(work_risk, spine, demo_scopes)

    queue = build_queue(work_risk, cfg["queue"])
    in_scope_universe = int((spine["SCOPE_TENURE"].isin(demo_scopes)).sum())
    print(f"  queue: {len(queue):,} / {in_scope_universe:,} in-scope universe "
          f"= {len(queue) / in_scope_universe * 100:.2f}%  (target 1-2%)")

    all_scope_breach = len(work_risk) / len(spine) * 100
    in_scope_breach = work_risk["in_demo_scope"].sum() / in_scope_universe * 100
    print(f"  breach rate: all-scope {all_scope_breach:.1f}%  in-scope {in_scope_breach:.1f}%")

    return work_risk, constituency_risk, district_risk, state_risk


def demo():
    from engine.link import run as link_run
    from engine.detectors import run as detectors_run, load_config as load_detector_config
    from engine.score import run as score_run

    link_run()
    cfg = load_detector_config()
    findings = score_run(detectors_run(), cfg)
    work_risk, constituency_risk, district_risk, state_risk = run(findings, cfg)

    spine = pd.read_parquet(DATA_PROCESSED / "spine.parquet")
    # work_risk is grouped by (work_number, scope_house, scope_tenure), not
    # work_number alone - compare against the same composite grouping.
    findings_df = pd.DataFrame(findings)
    findings_df["scope_house"] = findings_df["entities"].apply(lambda e: e["scope_house"])
    findings_df["scope_tenure"] = findings_df["entities"].apply(lambda e: e["scope_tenure"])
    expected_work_risk_rows = findings_df.drop_duplicates(subset=["work_number", "scope_house", "scope_tenure"]).shape[0]
    assert len(work_risk) == expected_work_risk_rows, (
        f"work_risk has {len(work_risk):,} rows, expected {expected_work_risk_rows:,} distinct flagged (work,scope) keys"
    )

    demo_scopes = cfg["queue"]["demo_scopes"]
    scoped_spine_len = int((spine["SCOPE_TENURE"].isin(demo_scopes)).sum())
    for name, df, col in [("constituency_risk", constituency_risk, "works_total"),
                           ("district_risk", district_risk, "works_total"),
                           ("state_risk", state_risk, "works_total")]:
        total = int(df[col].sum())
        assert total == scoped_spine_len, (
            f"{name}.{col} sums to {total:,}, expected in-scope spine count {scoped_spine_len:,}"
        )

    # agency_risk isn't part of run()'s exported tuple (it's computed fresh at
    # API startup, not written to parquet - see Store.__init__), so it's
    # self-checked here directly rather than threading a 5th value through
    # run()/export.py's signatures.
    agency_risk = build_agency_risk(work_risk, spine, demo_scopes)
    scoped_spine_with_ia = int((spine["SCOPE_TENURE"].isin(demo_scopes) & spine["exp_top_ia"].notna()).sum())
    agency_total = int(agency_risk["works_total"].sum())
    assert agency_total == scoped_spine_with_ia, (
        f"agency_risk.works_total sums to {agency_total:,}, expected {scoped_spine_with_ia:,} "
        f"in-scope works with a non-null exp_top_ia"
    )
    assert agency_risk["agency"].notna().all(), "agency_risk must never contain a null agency row"

    print(f"\nrollup self-check: PASS  ({len(work_risk):,} flagged works, "
          f"{len(constituency_risk):,} constituencies, {len(district_risk):,} districts, "
          f"{len(state_risk):,} states, {len(agency_risk):,} agencies)")
    return findings, work_risk, constituency_risk, district_risk, state_risk


if __name__ == "__main__":
    demo()
