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
                           "STATE_NAME", "CONSTITUENCY", "CONSTITUENCY_ID", "MP_NAME"]].copy()
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

    tag_rows = flagged[["CONSTITUENCY_ID", "tags"]].explode("tags")
    tag_counts = (tag_rows.groupby(["CONSTITUENCY_ID", "tags"]).size()
                  .reset_index(name="n")
                  .groupby("CONSTITUENCY_ID")
                  .apply(lambda g: dict(zip(g["tags"], g["n"].astype(int))), include_groups=False)
                  .to_dict())

    constituency_risk = constituency_risk.merge(flagged_agg, on="CONSTITUENCY_ID", how="left")
    constituency_risk["works_flagged"] = constituency_risk["works_flagged"].fillna(0).astype(int)
    constituency_risk["total_exposure"] = constituency_risk["total_exposure"].fillna(0.0)
    constituency_risk["mean_priority"] = constituency_risk["mean_priority"].fillna(0.0)
    constituency_risk["risk_score"] = constituency_risk["risk_score"].fillna(0.0)
    constituency_risk["breach_rate"] = constituency_risk["works_flagged"] / constituency_risk["works_total"]
    # dict-per-row with heterogeneous keys across rows doesn't survive pyarrow's
    # schema inference cleanly - store as a JSON string, same defensive move as
    # export.py's nested-struct fallback for findings.parquet.
    constituency_risk["tag_counts"] = constituency_risk["CONSTITUENCY_ID"].map(
        lambda cid: json.dumps(tag_counts.get(cid, {})))
    return constituency_risk


def build_queue(work_risk: pd.DataFrame, queue_cfg: dict) -> pd.DataFrame:
    eligible = work_risk[work_risk["in_demo_scope"] & (work_risk["total_exposure"] >= queue_cfg["materiality_floor"])]
    return eligible.nlargest(queue_cfg["max_queue_size"], "priority")


def run(findings: list[dict], cfg: dict) -> tuple[pd.DataFrame, pd.DataFrame]:
    spine = pd.read_parquet(DATA_PROCESSED / "spine.parquet")
    demo_scopes = cfg["queue"]["demo_scopes"]

    findings_df = pd.DataFrame(findings)
    findings_df["scope_house"] = findings_df["entities"].apply(lambda e: e["scope_house"])
    findings_df["scope_tenure"] = findings_df["entities"].apply(lambda e: e["scope_tenure"])

    work_risk = build_work_risk(findings_df, spine, demo_scopes)
    constituency_risk = build_constituency_risk(work_risk, spine, demo_scopes)

    queue = build_queue(work_risk, cfg["queue"])
    in_scope_universe = int((spine["SCOPE_TENURE"].isin(demo_scopes)).sum())
    print(f"  queue: {len(queue):,} / {in_scope_universe:,} in-scope universe "
          f"= {len(queue) / in_scope_universe * 100:.2f}%  (target 1-2%)")

    all_scope_breach = len(work_risk) / len(spine) * 100
    in_scope_breach = work_risk["in_demo_scope"].sum() / in_scope_universe * 100
    print(f"  breach rate: all-scope {all_scope_breach:.1f}%  in-scope {in_scope_breach:.1f}%")

    return work_risk, constituency_risk


def demo():
    from engine.link import run as link_run
    from engine.detectors import run as detectors_run, load_config as load_detector_config
    from engine.score import run as score_run

    link_run()
    cfg = load_detector_config()
    findings = score_run(detectors_run(), cfg)
    work_risk, constituency_risk = run(findings, cfg)

    spine = pd.read_parquet(DATA_PROCESSED / "spine.parquet")
    distinct_flagged_keys = pd.DataFrame(findings)["work_number"].nunique()
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
    assert constituency_risk["works_total"].sum() == scoped_spine_len, (
        f"constituency_risk.works_total sums to {constituency_risk['works_total'].sum():,}, "
        f"expected in-scope spine count {scoped_spine_len:,}"
    )

    print(f"\nrollup self-check: PASS  ({len(work_risk):,} flagged works, "
          f"{len(constituency_risk):,} constituencies)")
    return findings, work_risk, constituency_risk


if __name__ == "__main__":
    demo()
