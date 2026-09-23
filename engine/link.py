"""Stage 3: build the one-row-per-work lifecycle spine.

Join key is the composite WORK_KEY, not bare WORK_RECOMMENDATION_DTL_ID - it
collides across SCOPE_HOUSE/SCOPE_TENURE in works_recommended.csv (see
docs/SCHEMA.md). The spine roots at recommended UNION sanctioned, not at
recommended alone - completed/expenditure are always subsets of sanctioned,
but sanctioned has ~0.5% genuine orphans with no recommended row at all, and
rooting at recommended would silently drop them.
"""
import json

import pandas as pd

from engine.paths import DATA_PROCESSED

WORK_KEY = ["WORK_RECOMMENDATION_DTL_ID", "SCOPE_HOUSE", "SCOPE_TENURE"]
COVERAGE_PATH = DATA_PROCESSED / "_join_coverage.json"


def load_payment_rows() -> pd.DataFrame:
    """Row-level payments (one row per disbursement). The spine only keeps
    per-work aggregates; payment-timing and agency-concentration detectors
    need the individual rows - the aggregate's exp_top_ia/exp_top_vendor
    come from the single largest row and mislabel multi-vendor works."""
    return pd.read_parquet(DATA_PROCESSED / "expenditure.parquet")


def orphan_rates(rec: pd.DataFrame, san: pd.DataFrame, comp: pd.DataFrame, exp: pd.DataFrame) -> dict:
    """Share of each file's rows whose work has no parent row upstream."""
    def orphan(child, parent):
        keys = parent[WORK_KEY].drop_duplicates()
        m = child[WORK_KEY].merge(keys, on=WORK_KEY, how="left", indicator=True)
        return round(float((m["_merge"] == "left_only").mean() * 100), 4) if len(m) else 0.0
    return {
        "sanctioned_without_recommendation_pct": orphan(san, rec),
        "completed_without_sanction_pct": orphan(comp, san),
        "payments_without_sanction_pct": orphan(exp, san),
        "rows": {"recommended": len(rec), "sanctioned": len(san), "completed": len(comp), "payments": len(exp)},
    }


def check_coverage(rates: dict, max_increase_pp: float) -> None:
    """Fails the run if any orphan rate jumped by more than max_increase_pp
    percentage points since the last run - a sign a join key broke upstream."""
    previous = json.loads(COVERAGE_PATH.read_text(encoding="utf-8")) if COVERAGE_PATH.exists() else None
    for name, pct in rates.items():
        if name == "rows":
            continue
        prev = previous.get(name) if previous else None
        print(f"  join coverage: {name} = {pct:.3f}%" + (f" (was {prev:.3f}%)" if prev is not None else ""))
        if prev is not None and pct - prev > max_increase_pp:
            raise RuntimeError(f"join coverage: {name} jumped {prev:.3f}% -> {pct:.3f}% "
                               f"(> {max_increase_pp} pp) - check the source files before trusting this run")
    COVERAGE_PATH.write_text(json.dumps(rates, indent=2), encoding="utf-8")


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

    # top vendor/implementing-agency = whichever the single largest disbursement
    # row names, not an arbitrary alphabetical pick from a multi-vendor work.
    # IA_NAME_CLEAN is the specific engineering office that executed the work -
    # a real, distinct entity from the district IDA that sanctioned it (see
    # docs/SCHEMA.md) - carried through here so "who completed this work" has
    # an honest answer instead of repeating the sanctioning authority's name.
    top_idx = exp.groupby(WORK_KEY)["FUND_DISBURSED_AMT"].idxmax()
    exp_top = (exp.loc[top_idx, WORK_KEY + ["VENDOR_NAME_CLEAN", "IA_NAME_CLEAN"]]
                  .rename(columns={"VENDOR_NAME_CLEAN": "exp_top_vendor", "IA_NAME_CLEAN": "exp_top_ia"}))
    return agg.merge(exp_top, on=WORK_KEY, how="left")


def coverage(numerator_mask: pd.Series, denominator_mask: pd.Series) -> tuple[float, int, int]:
    d = int(denominator_mask.sum())
    n = int((numerator_mask & denominator_mask).sum())
    return (n / d * 100 if d else float("nan")), n, d


def run() -> pd.DataFrame:
    from engine.detectors import load_config
    rec = dedup_recommended(pd.read_parquet(DATA_PROCESSED / "recommended.parquet"))
    san = pd.read_parquet(DATA_PROCESSED / "sanctioned.parquet")
    comp = pd.read_parquet(DATA_PROCESSED / "completed.parquet")
    exp_rows = load_payment_rows()
    check_coverage(orphan_rates(rec, san, comp, exp_rows),
                   load_config().get("link", {}).get("max_orphan_rate_increase_pp", 1.0))
    exp_agg = aggregate_expenditure(exp_rows)

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
    spine["DISTRICT"] = spine["rec_DISTRICT"].fillna(spine["san_DISTRICT"])

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

    null_district = int(spine["DISTRICT"].isna().sum())
    n_districts = spine["DISTRICT"].nunique()
    print(f"  DISTRICT: {null_district:,} null / {len(spine):,} rows, {n_districts:,} distinct districts")
    assert null_district == 0, f"{null_district} spine row(s) with null DISTRICT"

    print(f"\nlink self-check: PASS  (0 duplicate keys, 0 orphan completions, "
          f"0 null constituency_id, 0 null district, {len(spine):,} total works)")


if __name__ == "__main__":
    demo()
