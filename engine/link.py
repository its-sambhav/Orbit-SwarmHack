"""Stage 3: build the one-row-per-work lifecycle spine.

Join key is the composite WORK_KEY, not bare WORK_RECOMMENDATION_DTL_ID - it
collides across SCOPE_HOUSE/SCOPE_TENURE in works_recommended.csv (see
docs/SCHEMA.md). The spine roots at recommended UNION sanctioned, not at
recommended alone - completed/expenditure are always subsets of sanctioned,
but sanctioned has ~0.5% genuine orphans with no recommended row at all, and
rooting at recommended would silently drop them.
"""
import pandas as pd

from engine.paths import DATA_PROCESSED

WORK_KEY = ["WORK_RECOMMENDATION_DTL_ID", "SCOPE_HOUSE", "SCOPE_TENURE"]


def prefixed(df: pd.DataFrame, prefix: str) -> pd.DataFrame:
    return df.rename(columns={c: f"{prefix}{c}" for c in df.columns if c not in WORK_KEY})


def dedup_recommended(rec: pd.DataFrame) -> pd.DataFrame:
    """171 genuine same-scope duplicate WORK_KEYs remain even after compositing
    (believed to be live-DB drift between fetch retries, see SCHEMA.md). Tie-break:
    prefer the row with a non-null SANCTION_DATE, then higher Sno (later fetch order)."""
    before = len(rec)
    rec = rec.assign(_san_notna=rec["SANCTION_DATE"].notna())
    rec = rec.sort_values(["_san_notna", "Sno"], ascending=[False, False])
    rec = rec.drop_duplicates(subset=WORK_KEY, keep="first").drop(columns=["_san_notna"])
    dropped = before - len(rec)
    print(f"  recommended: deduped {before:,} -> {len(rec):,} rows ({dropped:,} dropped on composite WORK_KEY, expected ~171)")
    return rec


def aggregate_expenditure(exp: pd.DataFrame) -> pd.DataFrame:
    """Aggregate BEFORE joining - WORK_RECOMMENDATION_DTL_ID is not unique in
    expenditure (multiple disbursement rows per work), and this is safe (zero
    cross-scope collisions verified, see SCHEMA.md)."""
    agg = exp.groupby(WORK_KEY).agg(
        exp_total_disbursed=("FUND_DISBURSED_AMT", "sum"),
        exp_row_count=("FUND_DISBURSED_AMT", "size"),
        exp_first_date=("EXPENDITURE_DATE", "min"),
        exp_last_date=("EXPENDITURE_DATE", "max"),
        exp_any_success=("WORK_STATUS", lambda s: (s == "Payment Success").any()),
        exp_any_inprogress=("WORK_STATUS", lambda s: (s == "Payment In-Progress").any()),
        exp_vendor_count=("VENDOR_NAME_CLEAN", "nunique"),
    ).reset_index()

    # top vendor = the single largest disbursement row's vendor, not an arbitrary
    # alphabetical pick from the set of vendors on a multi-vendor work.
    top_idx = exp.groupby(WORK_KEY)["FUND_DISBURSED_AMT"].idxmax()
    exp_top_vendor = (exp.loc[top_idx, WORK_KEY + ["VENDOR_NAME_CLEAN"]]
                         .rename(columns={"VENDOR_NAME_CLEAN": "exp_top_vendor"}))
    return agg.merge(exp_top_vendor, on=WORK_KEY, how="left")


def coverage(numerator_mask: pd.Series, denominator_mask: pd.Series) -> tuple[float, int, int]:
    d = int(denominator_mask.sum())
    n = int((numerator_mask & denominator_mask).sum())
    return (n / d * 100 if d else float("nan")), n, d


def run() -> pd.DataFrame:
    rec = dedup_recommended(pd.read_parquet(DATA_PROCESSED / "recommended.parquet"))
    san = pd.read_parquet(DATA_PROCESSED / "sanctioned.parquet")
    comp = pd.read_parquet(DATA_PROCESSED / "completed.parquet")
    exp_agg = aggregate_expenditure(pd.read_parquet(DATA_PROCESSED / "expenditure.parquet"))

    all_keys = pd.concat([rec[WORK_KEY], san[WORK_KEY]]).drop_duplicates().reset_index(drop=True)

    spine = (all_keys
             .merge(prefixed(rec, "rec_"), on=WORK_KEY, how="left")
             .merge(prefixed(san, "san_"), on=WORK_KEY, how="left")
             .merge(prefixed(comp, "comp_"), on=WORK_KEY, how="left")
             .merge(exp_agg, on=WORK_KEY, how="left"))

    spine["has_recommended"] = spine["rec_RECOMMENDATION_DATE"].notna()
    spine["has_sanctioned"] = spine["san_SANCTION_DATE"].notna()
    spine["has_completed"] = spine["comp_ACTUAL_END_DATE"].notna()
    spine["has_expenditure"] = spine["exp_row_count"].notna()

    # authoritative fields - sanctioned wins on conflict (see SCHEMA.md: 100%
    # identical to recommended's copy wherever both are populated, sanctioned's
    # copy is simply more complete: 0% null vs 15.44% null in recommended)
    spine["SANCTION_DATE"] = spine["san_SANCTION_DATE"]
    spine["SANCTION_AMOUNT"] = spine["san_SANCTION_AMOUNT"]
    spine["WORK_STAGE_RESOLVED"] = spine["san_WORK_STAGE"].fillna(spine["rec_WORK_STAGE"])
    spine["CONSTITUENCY_ID"] = (spine["rec_CONSTITUENCY_ID"]
                                 .fillna(spine["san_CONSTITUENCY_ID"])
                                 .fillna(spine["comp_CONSTITUENCY_ID"]))

    # Display entity fields, same coalesce pattern as CONSTITUENCY_ID: recommended's
    # copy wins where present, falling back to sanctioned's own independent copy.
    # Matters for the 1,077 sanctioned-but-never-recommended orphans - several
    # detectors (STALLED_AT_EXECUTION, STUCK_STATUS, GHOST_ASSET, PAID_NOT_COMPLETE)
    # only require has_sanctioned, and those are exactly the irregular works this
    # slice cares about catching - they shouldn't render with blank entities when
    # sanctioned independently carries STATE_NAME/MP_NAME/CONSTITUENCY/IDA_NAME.
    spine["STATE_NAME"] = spine["rec_STATE_NAME"].fillna(spine["san_STATE_NAME"])
    spine["CONSTITUENCY"] = spine["rec_CONSTITUENCY"].fillna(spine["san_CONSTITUENCY"])
    spine["MP_NAME"] = spine["rec_MP_NAME"].fillna(spine["san_MP_NAME"])
    spine["IDA_NAME_CLEAN"] = spine["rec_IDA_NAME_CLEAN"].fillna(spine["san_IDA_NAME_CLEAN"])

    spine.to_parquet(DATA_PROCESSED / "spine.parquet", engine="pyarrow", index=False)

    n = len(spine)
    print(f"\n  spine: {n:,} rows (recommended U sanctioned)")
    print(f"  has_recommended={spine.has_recommended.sum():,}  has_sanctioned={spine.has_sanctioned.sum():,}  "
          f"has_completed={spine.has_completed.sum():,}  has_expenditure={spine.has_expenditure.sum():,}")

    pct, n_, d_ = coverage(spine.has_recommended, spine.has_sanctioned)
    print(f"  sanctioned -> recommended: {pct:.3f}% ({n_:,}/{d_:,})  [SCHEMA.md: 99.502%]")
    pct, n_, d_ = coverage(spine.has_sanctioned, spine.has_completed)
    print(f"  completed  -> sanctioned:  {pct:.3f}% ({n_:,}/{d_:,})  [SCHEMA.md: 100.000%]")
    pct, n_, d_ = coverage(spine.has_sanctioned, spine.has_expenditure)
    print(f"  expenditure-> sanctioned:  {pct:.3f}% ({n_:,}/{d_:,})  [SCHEMA.md: 100.000%]")
    pct, n_, d_ = coverage(spine.has_completed, spine.has_expenditure)
    print(f"  expenditure-> completed:   {pct:.3f}% ({n_:,}/{d_:,})  [SCHEMA.md: 72.667%]")

    return spine


def demo():
    spine = run()
    dup_keys = spine.duplicated(subset=WORK_KEY).sum()
    assert dup_keys == 0, f"{dup_keys} duplicate WORK_KEY(s) in spine"

    orphan_completions = int((spine.has_completed & ~spine.has_sanctioned).sum())
    assert orphan_completions == 0, (
        f"{orphan_completions} completed work(s) with no sanctioned row - "
        f"completed->sanctioned should structurally be 100%"
    )

    null_constituency = int(spine["CONSTITUENCY_ID"].isna().sum())
    assert null_constituency == 0, f"{null_constituency} spine row(s) with null CONSTITUENCY_ID"

    orphans = ~spine.has_recommended
    orphans_with_state = int((orphans & spine["STATE_NAME"].notna()).sum())
    print(f"  {int(orphans.sum()):,} recommended-orphans; {orphans_with_state:,} of them "
          f"have STATE_NAME via the sanctioned-table fallback (expect = orphan count)")
    assert orphans_with_state == int(orphans.sum()), "sanctioned-table fallback isn't covering all orphans"

    print(f"\nlink self-check: PASS  (0 duplicate keys, 0 orphan completions, "
          f"0 null constituency_id, {len(spine):,} total works)")


if __name__ == "__main__":
    demo()
