"""Tiny hand-made tables for the detector tests - one dict per work, with
every spine column the detectors read, so each test only states what makes
its case different."""
import copy
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine import detectors  # noqa: E402

AS_OF = pd.Timestamp("2026-09-10")
NaT = pd.NaT


def ago(days: int) -> pd.Timestamp:
    return AS_OF - pd.Timedelta(days=days)


BASE = dict(
    WORK_RECOMMENDATION_DTL_ID=1, SCOPE_HOUSE="Lok Sabha", SCOPE_TENURE="18th Lok Sabha",
    STATE_NAME="Bihar", CONSTITUENCY="PATNA SAHIB", CONSTITUENCY_ID=10, DISTRICT="PATNA",
    MP_NAME="Shri Ram Kumar", IDA_NAME_CLEAN="PATNA(DISTRICT COLLECTOR PATNA_IDA)",
    rec_ACTIVITY_NAME_CLEAN="Roads", san_ACTIVITY_NAME_CLEAN=None, comp_ACTIVITY_NAME_CLEAN=None,
    rec_WORK_DESCRIPTION="construction of cc road in ward number one of the town area",
    san_WORK_DESCRIPTION=None, comp_WORK_DESCRIPTION=None,
    rec_WORK_CATEGORY="Normal/Others", san_WORK_CATEGORY=None, comp_WORK_CATEGORY=None,
    rec_RECOMMENDATION_DATE=ago(300), rec_RECOMMENDED_AMOUNT=500000.0, rec_FLAG=1.0,
    SANCTION_DATE=NaT, SANCTION_AMOUNT=np.nan,
    comp_ACTUAL_END_DATE=NaT, comp_ACTUAL_AMOUNT=np.nan, comp_ATTACH_ID=None,
    exp_total_disbursed=np.nan, exp_first_date=NaT, exp_last_date=NaT, exp_row_count=np.nan,
    exp_vendor_count=np.nan, exp_any_success=None, exp_any_inprogress=None,
    exp_top_ia=None, exp_top_vendor=None, WORK_STAGE_RESOLVED="Pending for Sanction",
)


def work(i: int, **kw) -> dict:
    return {**BASE, "WORK_RECOMMENDATION_DTL_ID": i, **kw}


def sanctioned(i: int, lag: int, rec_days_ago: int = 400, amount: float = 500000.0, **kw) -> dict:
    """Recommended rec_days_ago days before as-of, sanctioned `lag` days later."""
    return work(i, rec_RECOMMENDATION_DATE=ago(rec_days_ago), SANCTION_DATE=ago(rec_days_ago - lag),
                SANCTION_AMOUNT=amount, rec_RECOMMENDED_AMOUNT=amount,
                WORK_STAGE_RESOLVED=kw.pop("WORK_STAGE_RESOLVED", "Physical Inspection"), **kw)


def paid(total: float, first_days_ago: int, last_days_ago: int, success: bool = True) -> dict:
    return dict(exp_total_disbursed=total, exp_first_date=ago(first_days_ago), exp_last_date=ago(last_days_ago),
                exp_row_count=2.0, exp_vendor_count=1.0, exp_any_success=success, exp_any_inprogress=not success,
                exp_top_ia="PWD DIVISION 1", exp_top_vendor="VENDOR A")


def spine(rows: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    for c in ("rec_RECOMMENDATION_DATE", "SANCTION_DATE", "comp_ACTUAL_END_DATE", "exp_first_date", "exp_last_date"):
        df[c] = pd.to_datetime(df[c])
    df["has_recommended"] = df["rec_RECOMMENDATION_DATE"].notna()
    df["has_sanctioned"] = df["SANCTION_DATE"].notna()
    df["has_completed"] = df["comp_ACTUAL_END_DATE"].notna()
    df["has_expenditure"] = df["exp_row_count"].notna()
    return df


@pytest.fixture
def cfg():
    return copy.deepcopy(detectors.load_config())


@pytest.fixture
def ctx():
    return {"tags": detectors.load_tags()["tags"], "payments": pd.DataFrame(), "allocated": pd.DataFrame(),
            "calamity": pd.DataFrame()}


def run_one(fn, rows, cfg, ctx):
    return fn(detectors.prepare_spine(spine(rows), cfg), cfg, ctx)


def ids(findings) -> set:
    return {int(f["work_number"]) for f in findings}
