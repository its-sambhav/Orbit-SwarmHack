"""Stage 2: date/amount typing, ACTIVITY_NAME cleanup, vendor/IA/IDA name normalisation.

No entity clustering here (deferred to Slice 2's engine/entity_resolution.py -
no Group A detector needs it, see docs/SCHEMA.md). This stage only collapses
spelling noise (case, punctuation, M/S-prefix, whitespace); it does not merge
distinct spellings of the same real-world entity together.
"""
import re

import pandas as pd

from engine.paths import DATA_INTERIM, DATA_PROCESSED

DATE_FORMATS = {
    "RECOMMENDATION_DATE": "%d-%b-%Y",
    "SANCTION_DATE": "%d-%b-%Y",
    "EXPENDITURE_DATE": "%d-%b-%Y",
    "CRT_DT": "%d-%b-%Y",
    "ACTUAL_END_DATE": "%d-%b-%Y",
    "TENURE_START_DATE": "%b %d, %Y %I:%M:%S %p",
    "TENURE_END_DATE": "%b %d, %Y %I:%M:%S %p",
}

AMOUNT_COLUMNS = {
    "recommended": ["RECOMMENDED_AMOUNT", "SANCTION_AMOUNT"],
    "sanctioned": ["SANCTION_AMOUNT"],
    "completed": ["ACTUAL_AMOUNT"],
    "expenditure": ["FUND_DISBURSED_AMT"],
}

# generalized from a naive MP\d+-only pattern, which misses non-MP member codes
# (e.g. EXLS003) and, since the untouched string still carries the row's unique
# trailing work-ID, turns each miss into a spurious singleton category.
# Verified: 100.000% strip rate on recommended/sanctioned/completed. See SCHEMA.md.
ACTIVITY_PREFIX_RE = re.compile(r'^(?:WS/\t?\s*[A-Z]+\d+/\d{4}-\d{4}/\d+|NA)-')

MS_PREFIX_RE = re.compile(r'^\s*M[/.]?S\.?\s+', re.IGNORECASE)
PUNCT_RE = re.compile(r'[^\w\s]')
WS_RE = re.compile(r'\s+')

PROCESSED_TABLES = ["recommended", "sanctioned", "completed", "expenditure"]


def parse_dates(df: pd.DataFrame, table_key: str) -> pd.DataFrame:
    for col, fmt in DATE_FORMATS.items():
        if col not in df.columns:
            continue
        before_null = df[col].isna().sum()
        parsed = pd.to_datetime(df[col], format=fmt, errors="coerce")
        after_null = parsed.isna().sum()
        assert after_null == before_null, (
            f"{table_key}.{col}: parsing introduced {after_null - before_null} new null(s) "
            f"(had {before_null}, now {after_null}) - format assumption may be wrong"
        )
        df[col] = parsed
    return df


def check_amounts(df: pd.DataFrame, table_key: str) -> None:
    for col in AMOUNT_COLUMNS.get(table_key, []):
        neg = int((df[col] < 0).sum())
        assert neg == 0, f"{table_key}.{col}: {neg} negative value(s) found"
        zero = int((df[col] == 0).sum())
        if zero:
            print(f"    {table_key}.{col}: {zero:,} zero-amount rows")


def clean_activity_name(df: pd.DataFrame, table_key: str) -> pd.DataFrame:
    if "ACTIVITY_NAME" not in df.columns:
        return df
    raw = df["ACTIVITY_NAME"].astype(str)
    cleaned = raw.str.replace(ACTIVITY_PREFIX_RE, "", regex=True).str.strip()
    match_rate = (cleaned != raw).mean()
    distinct = cleaned.nunique()
    print(f"    {table_key}.ACTIVITY_NAME_CLEAN: strip_rate={match_rate:.4f} distinct={distinct}")
    assert 80 <= distinct <= 200, (
        f"{table_key}: ACTIVITY_NAME_CLEAN distinct count {distinct} outside expected 80-200 band"
    )
    df["ACTIVITY_NAME_CLEAN"] = cleaned
    return df


def normalize_name(s) -> str | None:
    """Full normalisation for VENDOR_NAME/IA_NAME: strip M/S-prefix, case, punctuation, whitespace.
    Collapses spelling noise only - does NOT merge distinct spellings (that's Slice 2 clustering)."""
    if pd.isna(s):
        return None
    s = MS_PREFIX_RE.sub('', str(s))
    s = s.upper()
    s = PUNCT_RE.sub(' ', s)
    return WS_RE.sub(' ', s).strip()


def normalize_whitespace(s) -> str | None:
    """Lighter normalisation for IDA_NAME - whitespace only, per docs/SCHEMA.md
    (low collision risk there, not worth the M/S-prefix and full case treatment)."""
    if pd.isna(s):
        return None
    return WS_RE.sub(' ', str(s).strip())


# No DISTRICT column exists anywhere in this dataset (see docs/SCHEMA.md), but
# IDA_NAME embeds it as text - e.g. "KOTTAYAM(DISTRICT COLLECTOR KOTTAYAM_IDA)".
# Verified 100% parse rate, 776 distinct districts (matches the known ~775-779
# distinct IDA_NAME count). This is a derived field, documented as such - not
# a fabricated one - and is what makes a real District Authority dashboard
# view possible despite the source data having no district field.
DISTRICT_RE = re.compile(r'^([^(]+)\(')


def extract_district(ida_name) -> str | None:
    if pd.isna(ida_name):
        return None
    m = DISTRICT_RE.match(str(ida_name))
    return m.group(1).strip().upper() if m else None


def run() -> None:
    dfs = {key: pd.read_parquet(DATA_INTERIM / f"{key}.parquet") for key in PROCESSED_TABLES}

    for key, df in dfs.items():
        parse_dates(df, key)
        check_amounts(df, key)
        clean_activity_name(df, key)
        if "IDA_NAME" in df.columns:
            df["IDA_NAME_CLEAN"] = df["IDA_NAME"].map(normalize_whitespace)
            df["DISTRICT"] = df["IDA_NAME"].map(extract_district)

    exp = dfs["expenditure"]
    raw_vendor_n = exp["VENDOR_NAME"].nunique()
    exp["VENDOR_NAME_CLEAN"] = exp["VENDOR_NAME"].map(normalize_name)
    norm_vendor_n = exp["VENDOR_NAME_CLEAN"].nunique()
    print(f"    expenditure.VENDOR_NAME_CLEAN: raw_distinct={raw_vendor_n:,} "
          f"normalised_distinct={norm_vendor_n:,} (spelling normalisation only, "
          f"real collapse via clustering is Slice 2)")

    raw_ia_n = exp["IA_NAME"].nunique()
    exp["IA_NAME_CLEAN"] = exp["IA_NAME"].map(normalize_name)
    norm_ia_n = exp["IA_NAME_CLEAN"].nunique()
    print(f"    expenditure.IA_NAME_CLEAN: raw_distinct={raw_ia_n:,} "
          f"normalised_distinct={norm_ia_n:,}")

    for key, df in dfs.items():
        df.to_parquet(DATA_PROCESSED / f"{key}.parquet", engine="pyarrow", index=False)
        print(f"  wrote {key}.parquet ({len(df):,} rows, {len(df.columns)} cols)")


def demo():
    run()
    for key in PROCESSED_TABLES:
        df = pd.read_parquet(DATA_PROCESSED / f"{key}.parquet")
        for col in ("RECOMMENDATION_DATE", "SANCTION_DATE", "EXPENDITURE_DATE",
                    "CRT_DT", "ACTUAL_END_DATE", "TENURE_START_DATE", "TENURE_END_DATE"):
            if col in df.columns:
                assert pd.api.types.is_datetime64_any_dtype(df[col]), f"{key}.{col} not datetime64"
        for col in AMOUNT_COLUMNS.get(key, []):
            # NaN fails a naive `>= 0` test without being negative (1,385 legitimately
            # null SANCTION_AMOUNT rows in `recommended` - withdrawn recommendations,
            # see docs/SCHEMA.md) - test for real negatives explicitly instead.
            neg = int((df[col] < 0).sum())
            assert neg == 0, f"{key}.{col} has {neg} negative value(s)"
        if "ACTIVITY_NAME_CLEAN" in df.columns:
            n = df["ACTIVITY_NAME_CLEAN"].nunique()
            assert 80 <= n <= 200, f"{key}.ACTIVITY_NAME_CLEAN distinct count {n} outside band"
        if "DISTRICT" in df.columns:
            null_rate = df["DISTRICT"].isna().mean()
            assert null_rate == 0, f"{key}.DISTRICT has {null_rate:.1%} nulls, expected 100% parse rate"
            n = df["DISTRICT"].nunique()
            assert 500 <= n <= 900, f"{key}.DISTRICT distinct count {n} outside expected band (~776)"
    print("\nnormalise self-check: PASS")


if __name__ == "__main__":
    demo()
