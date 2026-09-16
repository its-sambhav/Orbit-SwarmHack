"""A real, raw-data-driven risk + anomaly model - the upgrade from
engine/predictive.py's and the retired engine/anomaly.py's shared 5
hand-picked features (log_amount, rec_month, rec_quarter, activity_freq,
state_freq) to ~21 features engineered automatically from raw spine
columns spanning every lifecycle stage: amounts and their ratios across
recommendation/sanction/payment, every real day-gap between stages,
disbursement volume, lifecycle-flag booleans, and frequency-encoded
identity (activity/state/agency/vendor - rarity itself is a signal).

The target is upgraded too: instead of a narrow hand-defined "was this
work late" label, this trains against `max_severity == "high"` from
data/findings/work_risk.parquet - a real, already-computed signal built
from all 13 rule-based detectors combined (ghost assets, cost outliers,
duplicates, statutory deficits, agency concentration, every delay
detector), not just two guideline day-counts. A work can now be "risky"
for reasons the old delay-only model had no way to know about.

Explanations are model-derived, not canned strings: sklearn.inspection.
permutation_importance is run once at training time against the trained
model itself (which features it actually learned matter, ranked), and at
inference time a work's own driver sentences report which of the model's
own top-ranked features this work sits in an extreme percentile for -
computed from the model's real learned structure and this work's real
data, not a human's guess about what correlates with risk.

Also does the unsupervised anomaly job the retired engine/anomaly.py did,
on this same richer feature set - an Isolation Forest, since more real
raw signal is exactly what makes "how unusual is this work" a sharper
question than the old 5-feature version could ask.
"""
import numpy as np
import pandas as pd
import joblib
from sklearn.ensemble import HistGradientBoostingClassifier, IsolationForest
from sklearn.model_selection import train_test_split
from sklearn.metrics import roc_auc_score
from sklearn.inspection import permutation_importance

from engine.paths import DATA_PROCESSED, DATA_FINDINGS, ROOT
from engine.detectors import load_config as load_detector_config

MODEL_DIR = ROOT / "data" / "models"
MODEL_PATH = MODEL_DIR / "risk_model.joblib"

FEATURE_COLS = [
    "log_recommended_amount", "log_sanctioned_amount", "log_paid_amount",
    "sanction_to_recommended_ratio", "paid_to_sanctioned_ratio",
    "rec_month", "rec_quarter",
    "days_rec_to_sanction", "days_sanction_to_complete", "days_since_recommendation",
    "exp_row_count", "exp_vendor_count",
    "has_sanctioned", "has_completed", "has_expenditure", "exp_any_success", "exp_any_inprogress",
    "activity_freq", "state_freq", "agency_freq", "vendor_freq",
]

HUMAN_LABEL = {
    "log_recommended_amount": "Recommended amount",
    "log_sanctioned_amount": "Sanctioned amount",
    "log_paid_amount": "Amount paid so far",
    "sanction_to_recommended_ratio": "Sanctioned-to-recommended ratio",
    "paid_to_sanctioned_ratio": "Paid-to-sanctioned ratio",
    "rec_month": "Recommendation month",
    "rec_quarter": "Recommendation quarter",
    "days_rec_to_sanction": "Days from recommendation to sanction",
    "days_sanction_to_complete": "Days from sanction to completion",
    "days_since_recommendation": "Days since recommendation",
    "exp_row_count": "Number of disbursement records",
    "exp_vendor_count": "Number of distinct vendors paid",
    "has_sanctioned": "Sanctioned status",
    "has_completed": "Completion status",
    "has_expenditure": "Expenditure recorded",
    "exp_any_success": "Any successful disbursement",
    "exp_any_inprogress": "Any in-progress disbursement",
    "activity_freq": "How common this activity type is",
    "state_freq": "How common works from this state are",
    "agency_freq": "How common this implementing agency is",
    "vendor_freq": "How common this vendor is",
}


def build_features(df: pd.DataFrame, as_of: pd.Timestamp) -> tuple[pd.DataFrame, dict]:
    """Given the full spine, returns (X, freq_tables) - freq_tables carries
    the activity/state/agency/vendor frequency maps forward so a single
    live work can be encoded the same way at inference time. NaN is left
    as real NaN wherever a lifecycle stage hasn't happened yet (e.g. no
    sanction date) - HistGradientBoostingClassifier handles missing values
    natively, so the model itself learns what "not yet sanctioned" means
    from the missingness pattern rather than being handed a fabricated
    sentinel value pretending to be a real amount or day-count."""
    df = df.copy()

    df["log_recommended_amount"] = np.log10(df["rec_RECOMMENDED_AMOUNT"].fillna(df["SANCTION_AMOUNT"]).clip(lower=1000))
    df["log_sanctioned_amount"] = np.log10(df["SANCTION_AMOUNT"].clip(lower=1))
    df["log_paid_amount"] = np.log10(df["exp_total_disbursed"].fillna(0) + 1)

    df["sanction_to_recommended_ratio"] = df["SANCTION_AMOUNT"] / df["rec_RECOMMENDED_AMOUNT"].clip(lower=1)
    df["paid_to_sanctioned_ratio"] = df["exp_total_disbursed"] / df["SANCTION_AMOUNT"].clip(lower=1)

    df["rec_month"] = df["rec_RECOMMENDATION_DATE"].dt.month
    df["rec_quarter"] = df["rec_RECOMMENDATION_DATE"].dt.quarter

    df["days_rec_to_sanction"] = (df["SANCTION_DATE"] - df["rec_RECOMMENDATION_DATE"]).dt.days
    df["days_sanction_to_complete"] = (df["comp_ACTUAL_END_DATE"] - df["SANCTION_DATE"]).dt.days
    df["days_since_recommendation"] = (as_of - df["rec_RECOMMENDATION_DATE"]).dt.days

    df["exp_row_count"] = df["exp_row_count"].fillna(0)
    df["exp_vendor_count"] = df["exp_vendor_count"].fillna(0)

    df["has_sanctioned"] = df["has_sanctioned"].astype(int)
    df["has_completed"] = df["has_completed"].astype(int)
    df["has_expenditure"] = df["has_expenditure"].astype(int)
    df["exp_any_success"] = df["exp_any_success"].fillna(False).astype(int)
    df["exp_any_inprogress"] = df["exp_any_inprogress"].fillna(False).astype(int)

    freq_tables = {}
    for feat_name, col in [("activity", "rec_ACTIVITY_NAME_CLEAN"), ("state", "STATE_NAME"),
                            ("agency", "exp_top_ia"), ("vendor", "exp_top_vendor")]:
        counts = df[col].value_counts(normalize=True).to_dict()
        df[f"{feat_name}_freq"] = df[col].map(counts).fillna(0.0)
        freq_tables[feat_name] = counts

    return df[FEATURE_COLS], freq_tables


def build_inference_features(work: dict, freq_tables: dict, as_of: pd.Timestamp) -> pd.DataFrame:
    """Same 21 columns as build_features(), for one live work - work is the
    raw spine-row dict api/main.py already has from Store.work(...), so no
    extra lookup is needed at the call site."""
    def get(key):
        v = work.get(key)
        return None if pd.isna(v) else v

    rec_amount = get("rec_RECOMMENDED_AMOUNT")
    sanction_amount = get("SANCTION_AMOUNT")
    paid = get("exp_total_disbursed")
    rec_ts = pd.Timestamp(get("rec_RECOMMENDATION_DATE")) if get("rec_RECOMMENDATION_DATE") is not None else None
    sanction_ts = pd.Timestamp(get("SANCTION_DATE")) if get("SANCTION_DATE") is not None else None
    complete_ts = pd.Timestamp(get("comp_ACTUAL_END_DATE")) if get("comp_ACTUAL_END_DATE") is not None else None

    fallback_amount = rec_amount if rec_amount is not None else (sanction_amount if sanction_amount is not None else 1000.0)

    row = {
        "log_recommended_amount": float(np.log10(max(float(fallback_amount), 1000.0))),
        "log_sanctioned_amount": float(np.log10(max(float(sanction_amount), 1.0))) if sanction_amount is not None else np.nan,
        "log_paid_amount": float(np.log10((float(paid) if paid is not None else 0.0) + 1.0)),
        "sanction_to_recommended_ratio": (float(sanction_amount) / max(float(rec_amount), 1.0))
            if sanction_amount is not None and rec_amount is not None else np.nan,
        "paid_to_sanctioned_ratio": (float(paid) / max(float(sanction_amount), 1.0))
            if paid is not None and sanction_amount is not None else np.nan,
        "rec_month": rec_ts.month if rec_ts is not None else 6,
        "rec_quarter": rec_ts.quarter if rec_ts is not None else 2,
        "days_rec_to_sanction": (sanction_ts - rec_ts).days if sanction_ts is not None and rec_ts is not None else np.nan,
        "days_sanction_to_complete": (complete_ts - sanction_ts).days if complete_ts is not None and sanction_ts is not None else np.nan,
        "days_since_recommendation": (as_of - rec_ts).days if rec_ts is not None else np.nan,
        "exp_row_count": float(get("exp_row_count") or 0),
        "exp_vendor_count": float(get("exp_vendor_count") or 0),
        "has_sanctioned": int(bool(get("has_sanctioned"))),
        "has_completed": int(bool(get("has_completed"))),
        "has_expenditure": int(bool(get("has_expenditure"))),
        "exp_any_success": int(bool(get("exp_any_success"))),
        "exp_any_inprogress": int(bool(get("exp_any_inprogress"))),
        "activity_freq": freq_tables["activity"].get(get("rec_ACTIVITY_NAME_CLEAN"), 0.005),
        "state_freq": freq_tables["state"].get(get("STATE_NAME"), 0.02),
        "agency_freq": freq_tables["agency"].get(get("exp_top_ia"), 0.001),
        "vendor_freq": freq_tables["vendor"].get(get("exp_top_vendor"), 0.0005),
    }
    return pd.DataFrame([row])[FEATURE_COLS]


def train_model() -> dict:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    spine_path = DATA_PROCESSED / "spine.parquet"
    work_risk_path = DATA_FINDINGS / "work_risk.parquet"
    if not spine_path.exists() or not work_risk_path.exists():
        raise FileNotFoundError(f"spine.parquet and work_risk.parquet are both required - run the pipeline first.")

    cfg = load_detector_config()
    as_of = pd.Timestamp(cfg["as_of_date"])

    spine = pd.read_parquet(spine_path)
    work_risk = pd.read_parquet(work_risk_path)

    # trained on the FULL spine (both tenures) - the old predictive.py only
    # ever trained on 17th Lok Sabha's 94,795 rows; max_severity is real for
    # every work regardless of tenure, so there's no reason to leave the
    # 18th LS's 107,971 rows unused.
    spine = spine.copy()
    spine["work_number"] = spine["WORK_RECOMMENDATION_DTL_ID"].astype("int64").astype(str)

    high = work_risk.loc[work_risk["max_severity"] == "high", ["work_number", "scope_house", "scope_tenure"]].drop_duplicates()
    high["is_high_risk"] = 1
    df = spine.merge(
        high, how="left",
        left_on=["work_number", "SCOPE_HOUSE", "SCOPE_TENURE"],
        right_on=["work_number", "scope_house", "scope_tenure"],
    )
    df["is_high_risk"] = df["is_high_risk"].fillna(0).astype(int)

    X, freq_tables = build_features(df, as_of)
    y = df["is_high_risk"]

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

    clf = HistGradientBoostingClassifier(max_iter=150, learning_rate=0.08, max_depth=6, random_state=42)
    clf.fit(X_train, y_train)

    proba = clf.predict_proba(X_test)[:, 1]
    auc = float(roc_auc_score(y_test, proba))

    # what the trained model actually learned matters, ranked - not a
    # human's guess about what should matter. Run once here (against the
    # held-out test set), stored in the bundle, reused for every live
    # prediction's driver explanation.
    perm = permutation_importance(clf, X_test, y_test, n_repeats=8, random_state=42, scoring="roc_auc", n_jobs=-1)
    importance_ranking = sorted(zip(FEATURE_COLS, perm.importances_mean.tolist()), key=lambda kv: kv[1], reverse=True)

    feature_stats = {
        c: {"p10": float(X[c].quantile(0.1)), "p90": float(X[c].quantile(0.9)), "median": float(X[c].median())}
        for c in FEATURE_COLS
    }

    # Isolation Forest can't take NaN - filled with the real training
    # median only for this model; the classifier above still sees real NaN.
    X_filled = X.fillna({c: feature_stats[c]["median"] for c in FEATURE_COLS})
    iso = IsolationForest(n_estimators=200, contamination=0.05, random_state=42)
    iso.fit(X_filled)
    train_scores = iso.score_samples(X_filled)

    bundle = {
        "clf": clf, "iso": iso, "freq_tables": freq_tables, "as_of": as_of,
        "importance_ranking": importance_ranking, "feature_stats": feature_stats,
        "anomaly_score_range": (float(train_scores.min()), float(train_scores.max())),
        "metrics": {
            "auc": round(auc, 3), "n_train": len(X_train), "n_test": len(X_test),
            "positive_rate": round(float(y.mean()), 4), "n_features": len(FEATURE_COLS),
        },
    }
    joblib.dump(bundle, MODEL_PATH)
    print(f"Trained risk model: AUC={auc:.3f}, positive_rate={y.mean():.3f} (is_high_risk), n={len(X):,}, features={len(FEATURE_COLS)}")
    print("Top learned risk factors:", ", ".join(f"{f} ({imp:.4f})" for f, imp in importance_ranking[:5]))
    print(f"Saved to {MODEL_PATH}")
    return bundle["metrics"]


_model_bundle = None


def get_model():
    global _model_bundle
    if _model_bundle is None:
        if not MODEL_PATH.exists():
            train_model()
        _model_bundle = joblib.load(MODEL_PATH)
    return _model_bundle


def explain_drivers(features_row: dict, importance_ranking: list, feature_stats: dict, top_n: int = 3) -> list[str]:
    drivers = []
    for rank, (feat, _imp) in enumerate(importance_ranking, start=1):
        if len(drivers) >= top_n:
            break
        val = features_row.get(feat)
        if val is None or pd.isna(val):
            continue
        stats = feature_stats[feat]
        label = HUMAN_LABEL.get(feat, feat)
        if val >= stats["p90"]:
            drivers.append(f"{label} is in the top 10% of all works - the model's #{rank} most important learned factor")
        elif val <= stats["p10"]:
            drivers.append(f"{label} is in the bottom 10% of all works - the model's #{rank} most important learned factor")
    if not drivers:
        drivers.append("No single factor stands out - risk here comes from a combination of moderate factors the model weighs together")
    return drivers


def predict(work: dict) -> dict:
    """work: the raw spine-row dict for one work (api/main.py already has
    this from Store.work(...)). Returns a comprehensive risk read - a
    supervised risk score, an unsupervised anomaly score, and real
    model-derived driver sentences - from ~21 automatically-engineered raw
    features, not the old 5 hand-picked ones."""
    try:
        bundle = get_model()
        features_row = build_inference_features(work, bundle["freq_tables"], bundle["as_of"])

        proba = float(bundle["clf"].predict_proba(features_row)[0, 1])
        tier = "High" if proba >= 0.70 else "Medium" if proba >= 0.40 else "Low"

        filled = features_row.fillna({c: bundle["feature_stats"][c]["median"] for c in FEATURE_COLS})
        raw_score = float(bundle["iso"].score_samples(filled)[0])
        is_anomalous = bool(bundle["iso"].predict(filled)[0] == -1)
        lo, hi = bundle["anomaly_score_range"]
        anomaly_score = float(np.clip((hi - raw_score) / (hi - lo), 0.0, 1.0)) if hi > lo else 0.0

        drivers = explain_drivers(features_row.iloc[0].to_dict(), bundle["importance_ranking"], bundle["feature_stats"])

        return {
            "risk_score": round(proba, 3),
            "risk_tier": tier,
            "anomaly_score": round(anomaly_score, 3),
            "is_anomalous": is_anomalous,
            "top_drivers": drivers,
            "model_auc": bundle["metrics"]["auc"],
        }
    except Exception as e:
        return {
            "risk_score": None, "risk_tier": "Medium", "anomaly_score": None, "is_anomalous": False,
            "top_drivers": [f"Model unavailable ({e})"], "model_auc": None,
        }


if __name__ == "__main__":
    train_model()
