"""Stage 1: read the 6 source CSVs, validate against _totals.csv, write typed Parquet.

No date parsing, no cleanup here - that's normalise.py's job. This stage only
does structural typing (pandas' own inference from read_csv) and validation.
"""
import json

import pandas as pd

from engine.paths import ROOT, DATA_INTERIM

# table key -> (source filename, amount column). Mirrors README's own validation table.
SOURCES = {
    "recommended": ("works_recommended.csv", "RECOMMENDED_AMOUNT"),
    "sanctioned": ("works_sanctioned.csv", "SANCTION_AMOUNT"),
    "completed": ("works_completed.csv", "ACTUAL_AMOUNT"),
    "expenditure": ("expenditure_on_completed_and_on_going_works_as_on_date.csv", "FUND_DISBURSED_AMT"),
    "allocated": ("allocated_limit_for_hon_ble_mps.csv", "ALLOCATED_AMT"),
    "calamity": ("amount_consented_for_calamity.csv", "CONSENTED_AMOUNT"),
}

# Lok-Sabha-only counts (17th + 18th). This project covers only 17th/18th
# Lok Sabha - Rajya Sabha rows are filtered out below, right after read, so
# every stage downstream of ingest never sees them. Raw CSVs still contain
# Rajya Sabha rows (they're the original fetch's full record, see README) -
# filtering here rather than re-fetching is what keeps this correct
# regardless of whether the source files get refreshed later.
EXPECTED_ROWS = {
    "recommended": 202341, "sanctioned": 172049, "completed": 106755,
    "expenditure": 223414, "allocated": 1086, "calamity": 12,
}

TOLERANCE = 1.0  # rupees; README notes JSON floats are re-serialised, not exact


def _load_totals() -> pd.DataFrame:
    totals = pd.read_csv(ROOT / "_totals.csv", encoding="utf-8-sig")
    # _totals.csv itself has known exact-duplicate rows (8 of 32) plus one pair
    # that ISN'T an exact duplicate: expenditure/Rajya Sabha/Sitting disagreed
    # by ~Rs 80,060 between its two copies (see docs/SCHEMA.md) - moot now
    # that Rajya Sabha rows are filtered before validate_table ever runs, but
    # dedup stays as a general defence in case a similar LS-side divergence
    # ever shows up. Exact-dedup first; any (TABLE,HOUSE,TENURE) group still
    # >1 after that is a divergent case, handled explicitly in validate_table.
    return totals.drop_duplicates()


def validate_table(key: str, df: pd.DataFrame, amount_col: str, totals: pd.DataFrame) -> list[dict]:
    fname = SOURCES[key][0]
    grp = (df.groupby(["SCOPE_HOUSE", "SCOPE_TENURE"])
             .agg(n=(amount_col, "size"), total=(amount_col, "sum"))
             .reset_index())
    t = totals[totals.TABLE == fname]
    results = []
    for _, row in grp.iterrows():
        match = t[(t.HOUSE == row.SCOPE_HOUSE) & (t.TENURE == row.SCOPE_TENURE)]
        rec = {"table": key, "house": row.SCOPE_HOUSE, "tenure": row.SCOPE_TENURE,
               "computed_n": int(row.n), "computed_total": float(row.total)}
        if len(match) == 0:
            rec["status"] = "NO_TOTAL_ROW"
        elif len(match) > 1:
            # the known _totals.csv internal divergence (or a new one) - warn, don't fail
            rec["status"] = "WARN_DIVERGENT_TOTALS_FILE"
            rec["totals_file_values"] = [float(v) for v in match.TOTAL_AMT.tolist()]
        else:
            expected = float(match.TOTAL_AMT.iloc[0])
            delta = abs(row.total - expected)
            rec["expected_total"] = expected
            rec["delta"] = delta
            rec["status"] = "PASS" if delta < TOLERANCE else "FAIL"
        results.append(rec)
    return results


def run() -> list[dict]:
    totals = _load_totals()
    all_results = []
    for key, (fname, amount_col) in SOURCES.items():
        df = pd.read_csv(ROOT / fname, encoding="utf-8-sig")

        # Total_Amt is the API's appended grand-total row, already stripped from
        # these CSVs during fetch (see README) - every remaining row's copy must
        # be blank. Fail loudly if that's ever not true; don't silently drop data.
        assert df["Total_Amt"].isna().all(), (
            f"{key}: Total_Amt has non-null values - source snapshot shape changed, "
            f"grand-total rows may not have been stripped"
        )
        df = df.drop(columns=["Total_Amt"])

        # Rajya Sabha out of scope for this project - dropped here so nothing
        # downstream of ingest ever has to think about it. Every table
        # (including allocated/calamity) carries SCOPE_HOUSE, so this is safe
        # to apply uniformly.
        before = len(df)
        df = df[df["SCOPE_HOUSE"] == "Lok Sabha"].reset_index(drop=True)
        dropped = before - len(df)
        if dropped:
            print(f"  {key}: dropped {dropped:,} Rajya Sabha row(s), {len(df):,} Lok Sabha remain")

        all_results += validate_table(key, df, amount_col, totals)

        df.to_parquet(DATA_INTERIM / f"{key}.parquet", engine="pyarrow", index=False)

    report_path = DATA_INTERIM / "_validation_report.json"
    with open(report_path, "w") as f:
        json.dump(all_results, f, indent=2, default=str)

    for r in all_results:
        print(f"  {r['status']:26} {r['table']:12} {r['house']:12} {r['tenure']:16} "
              f"n={r['computed_n']:>7,}")
    fails = [r for r in all_results if r["status"] == "FAIL"]
    warns = [r for r in all_results if r["status"].startswith("WARN")]
    print(f"\ningest: {len(all_results)} scope checks, {len(fails)} FAIL, {len(warns)} WARN")
    return all_results


def demo():
    report = run()
    for key, expected_n in EXPECTED_ROWS.items():
        actual = pd.read_parquet(DATA_INTERIM / f"{key}.parquet")
        assert len(actual) == expected_n, f"{key}: expected {expected_n} rows, got {len(actual)}"
        assert "Total_Amt" not in actual.columns, f"{key}: Total_Amt should have been dropped"
    fails = [r for r in report if r["status"] == "FAIL"]
    assert not fails, f"unexplained validation FAILs: {fails}"
    print("\ningest self-check: PASS")


if __name__ == "__main__":
    demo()
