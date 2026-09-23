"""Pre-Sanction Predictive Delay Risk Engine for MPLADS works.

Trains a HistGradientBoostingClassifier on historical 17th Lok Sabha works
to predict the probability of a work experiencing severe execution/sanction
delays at the moment of recommendation, before public funds are locked.
"""
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.model_selection import GroupKFold
from sklearn.metrics import roc_auc_score, precision_score, recall_score

from engine.paths import DATA_PROCESSED, ROOT

MODEL_DIR = ROOT / "data" / "models"
MODEL_PATH = MODEL_DIR / "delay_predictor.joblib"

FEATURE_COLS = ["log_amount", "rec_month", "rec_quarter", "activity_freq", "state_freq"]


def build_features(df: pd.DataFrame) -> tuple[pd.DataFrame, dict, dict]:
    """Given an already-scoped spine slice, returns (X, activity_counts,
    state_counts) - the 5-column feature frame this module's own delay
    classifier trains and predicts on. Deliberately narrow and specific
    ("will this work be late") - see engine/risk_model.py for the broader,
    ~21-raw-feature risk + anomaly model trained against every detector's
    output, not just a delay guideline."""
    df = df.copy()
    # missing stays missing - the classifier handles NaN natively
    amount = df["rec_RECOMMENDED_AMOUNT"].fillna(df["SANCTION_AMOUNT"])
    df["log_amount"] = np.log10(amount.where(amount > 0))
    df["rec_month"] = df["rec_RECOMMENDATION_DATE"].dt.month
    df["rec_quarter"] = df["rec_RECOMMENDATION_DATE"].dt.quarter

    activity_col = "rec_ACTIVITY_NAME_CLEAN" if "rec_ACTIVITY_NAME_CLEAN" in df.columns else "ACTIVITY_NAME"
    activity_counts = df[activity_col].value_counts(normalize=True).to_dict()
    df["activity_freq"] = df[activity_col].map(activity_counts)

    state_counts = df["STATE_NAME"].value_counts(normalize=True).to_dict()
    df["state_freq"] = df["STATE_NAME"].map(state_counts)

    return df[FEATURE_COLS], activity_counts, state_counts


def build_inference_features(amount, state, activity, month, activity_counts, state_counts) -> pd.DataFrame:
    """Single-row feature frame for a live prediction - same 5 columns as
    build_features(). Unknown inputs are NaN, not a guessed default."""
    amount = float(amount) if amount is not None and not pd.isna(amount) and float(amount) > 0 else np.nan
    return pd.DataFrame([{
        "log_amount": np.log10(amount) if not np.isnan(amount) else np.nan,
        "rec_month": month if month is not None else np.nan,
        "rec_quarter": (month - 1) // 3 + 1 if month is not None else np.nan,
        "activity_freq": activity_counts.get(activity, np.nan),
        "state_freq": state_counts.get(state, np.nan),
    }], dtype="float64")


def train_model() -> dict:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    spine_path = DATA_PROCESSED / "spine.parquet"
    if not spine_path.exists():
        raise FileNotFoundError(f"Spine not found at {spine_path}. Run pipeline first.")

    spine = pd.read_parquet(spine_path)

    # Focus training on 17th Lok Sabha completed / concluded works
    df = spine[spine["SCOPE_TENURE"] == "17th Lok Sabha"].copy()
    if len(df) < 1000:
        df = spine.copy()

    # Ground truth target: is this work unusually slow relative to its own
    # real population, not a fixed day-count. engine/detectors.py's own delay
    # detectors went through exactly this recalibration already (see
    # docs/SCHEMA.md's "Flag-rate recalibration") after finding the fixed
    # MPLADS guideline (45 days to sanction, 365 to complete) is missed by
    # 28-69% of real works - failing the guideline is this system's norm, not
    # a deviation from it. An earlier version of this file trained the
    # target against that same fixed guideline: ~79% of the 17th Lok Sabha
    # training population came out "delayed", so the classifier correctly
    # learned to output a high probability for most works - an accurate fit
    # to a miscalibrated target, not a modelling bug, but it made the
    # resulting risk tier read as "High" for the large majority of works
    # (verified: 84% of a live 18th Lok Sabha sample), which defeats the
    # point of a differentiating risk signal. Gating each delay metric on
    # its own 90th percentile (same convention as detectors.py's
    # dynamic_gate()) fixes the target at its source instead of just
    # relabelling the output - about 1 in 5 works ends up "delayed" by this
    # definition, matching the rest of the system's p90-based severity gates.
    san_delay = (df["san_SANCTION_DATE"] - df["rec_RECOMMENDATION_DATE"]).dt.days
    exec_delay = (df["comp_ACTUAL_END_DATE"] - df["san_SANCTION_DATE"]).dt.days
    san_gate = san_delay.dropna().quantile(0.90)
    exec_gate = exec_delay.dropna().quantile(0.90)

    is_delayed = ((san_delay > san_gate) | (exec_delay > exec_gate) | (df["has_recommended"] & ~df["has_sanctioned"])).astype(int)
    df["target"] = is_delayed

    X, activity_counts, state_counts = build_features(df)
    y = df["target"]
    groups = df["CONSTITUENCY_ID"].fillna(-1)

    params = dict(max_iter=100, learning_rate=0.08, max_depth=5, random_state=42)
    # out-of-fold scores with GroupKFold by constituency - a random split puts
    # near-identical works from one constituency on both sides of the split
    oof = np.full(len(y), np.nan)
    for train, test in GroupKFold(n_splits=5).split(X, y, groups):
        fold = HistGradientBoostingClassifier(**params).fit(X.iloc[train], y.iloc[train])
        oof[test] = fold.predict_proba(X.iloc[test])[:, 1]
    try:
        auc = float(roc_auc_score(y, oof))
    except ValueError:
        auc = None          # not evaluated - never a stand-in number
    y_pred = (oof >= 0.5).astype(int)
    precision = float(precision_score(y, y_pred, zero_division=0))
    recall = float(recall_score(y, y_pred, zero_division=0))

    clf = HistGradientBoostingClassifier(**params).fit(X, y)

    artifacts = {
        "model": clf,
        "feature_cols": FEATURE_COLS,
        "activity_counts": activity_counts,
        "state_counts": state_counts,
        "metrics": {
            "auc": round(auc, 3) if auc is not None else None,
            "precision": round(precision, 3),
            "recall": round(recall, 3),
            "n": len(X),
            "evaluation": "GroupKFold(5) by constituency, out-of-fold",
        },
    }

    joblib.dump(artifacts, MODEL_PATH)
    print(f"  delay model: out-of-fold AUC={artifacts['metrics']['auc']}, precision={precision:.3f}, recall={recall:.3f}")
    print(f"Saved to {MODEL_PATH}")
    return artifacts["metrics"]


_model_bundle = None


def get_model():
    global _model_bundle
    if _model_bundle is None:
        if not MODEL_PATH.exists():
            train_model()
        _model_bundle = joblib.load(MODEL_PATH)
    return _model_bundle


def predict_work_risk(amount: float | None, state: str | None, activity: str | None, month: int | None = None) -> dict:
    """Computes predicted delay risk probability and contributing factors."""
    try:
        bundle = get_model()
        clf = bundle["model"]
        act_counts = bundle["activity_counts"]
        st_counts = bundle["state_counts"]

        st_freq = st_counts.get(state)
        features = build_inference_features(amount, state, activity, month, act_counts, st_counts)

        proba = float(clf.predict_proba(features)[0, 1])

        if proba >= 0.70:
            tier = "High"
        elif proba >= 0.40:
            tier = "Medium"
        else:
            tier = "Low"

        # Explain key drivers
        drivers = []
        if amount is not None and not pd.isna(amount) and amount > 2500000:
            drivers.append("High capital expenditure (> ₹25L) historically correlates with execution delay")
        if month in (6, 7, 8):
            drivers.append("Monsoon quarter recommendation historically incurs initial sanction delays")
        if st_freq is not None and st_freq < 0.01:
            drivers.append("Lower volume jurisdiction exhibits higher timeline variability")

        return {
            "predicted_delay_probability": round(proba, 3),
            "risk_tier": tier,
            "drivers": drivers,
            "model_auc": bundle["metrics"].get("auc"),
        }
    except Exception as e:
        return {
            "predicted_delay_probability": None,
            "risk_tier": None,
            "drivers": [f"Model unavailable ({e})"],
            "model_auc": None,
        }


if __name__ == "__main__":
    train_model()
