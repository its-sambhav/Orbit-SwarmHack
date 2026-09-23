"""Machine learning - ranking only (spec section 6). Nothing here adds,
removes or re-grades a flag.

1. Isolation Forest, one per amount tier: an "unusual shape" score used only
   to reorder works that already sit in the same priority band of the queue
   (engine/rollup.py build_queue).

2. Rule-agreement score: a gradient-boosting classifier trained on
   max_severity == "high" from the rules, using largely the same raw inputs
   the rules read. Its AUC therefore measures how well it reproduces the
   rules, not real-world risk - so it is reported as a "rule-agreement
   score", never as an independent risk signal. Evaluated with GroupKFold by
   constituency (a random split leaks near-identical works from the same
   constituency into both sides). The old agency_freq/vendor_freq features
   are gone - they treated "rare" as "risky" and so penalised small agencies.

3. A model on real reviewer labels (data/finding_status.json) is trained
   only once there are >= min_reviews_for_label_model reviewed findings;
   isotonic-calibrated, reported with precision@k.
"""
import numpy as np
import pandas as pd
import joblib
from sklearn.ensemble import HistGradientBoostingClassifier, IsolationForest
from sklearn.model_selection import GroupKFold
from sklearn.metrics import roc_auc_score

from engine.paths import DATA_PROCESSED, DATA_FINDINGS, ROOT
from engine.detectors import load_config as load_detector_config
from engine.explain import compute_importance_ranking, compute_feature_stats, explain_drivers

MODEL_DIR = ROOT / "data" / "models"
MODEL_PATH = MODEL_DIR / "risk_model.joblib"
LABEL_MODEL_PATH = MODEL_DIR / "label_model.joblib"
N_TIERS = 4

FEATURE_COLS = [
    "log_recommended_amount", "log_sanctioned_amount", "log_paid_amount",
    "sanction_to_recommended_ratio", "paid_to_sanctioned_ratio",
    "rec_month", "rec_quarter",
    "days_rec_to_sanction", "days_sanction_to_complete", "days_since_recommendation",
    "exp_row_count", "exp_vendor_count",
    "has_sanctioned", "has_completed", "has_expenditure", "exp_any_success", "exp_any_inprogress",
    "activity_freq", "state_freq",
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
}


def build_features(df: pd.DataFrame, as_of: pd.Timestamp) -> tuple[pd.DataFrame, dict]:
    """Missing lifecycle stages stay NaN - the classifier handles NaN
    natively, so it learns what 'not yet sanctioned' means instead of being
    handed a made-up amount or day count."""
    df = df.copy()
    rec = df["rec_RECOMMENDED_AMOUNT"]
    df["log_recommended_amount"] = np.log10(rec.where(rec > 0))
    df["log_sanctioned_amount"] = np.log10(df["SANCTION_AMOUNT"].where(df["SANCTION_AMOUNT"] > 0))
    df["log_paid_amount"] = np.log10(df["exp_total_disbursed"].fillna(0) + 1)
    df["sanction_to_recommended_ratio"] = df["SANCTION_AMOUNT"] / rec.where(rec > 0)
    df["paid_to_sanctioned_ratio"] = df["exp_total_disbursed"] / df["SANCTION_AMOUNT"].where(df["SANCTION_AMOUNT"] > 0)
    df["rec_month"] = df["rec_RECOMMENDATION_DATE"].dt.month
    df["rec_quarter"] = df["rec_RECOMMENDATION_DATE"].dt.quarter
    df["days_rec_to_sanction"] = (df["SANCTION_DATE"] - df["rec_RECOMMENDATION_DATE"]).dt.days
    df["days_sanction_to_complete"] = (df["comp_ACTUAL_END_DATE"] - df["SANCTION_DATE"]).dt.days
    df["days_since_recommendation"] = (as_of - df["rec_RECOMMENDATION_DATE"]).dt.days
    df["exp_row_count"] = df["exp_row_count"].fillna(0)
    df["exp_vendor_count"] = df["exp_vendor_count"].fillna(0)
    for col in ("has_sanctioned", "has_completed", "has_expenditure", "exp_any_success", "exp_any_inprogress"):
        df[col] = df[col].fillna(False).astype(bool).astype(int)
    freq_tables = {}
    for name, col in (("activity", "rec_ACTIVITY_NAME_CLEAN"), ("state", "STATE_NAME")):
        counts = df[col].value_counts(normalize=True).to_dict()
        df[f"{name}_freq"] = df[col].map(counts)
        freq_tables[name] = counts
    return df[FEATURE_COLS], freq_tables


def build_inference_features(work: dict, freq_tables: dict, as_of: pd.Timestamp) -> pd.DataFrame:
    row = pd.DataFrame([work])
    for col in ("rec_RECOMMENDATION_DATE", "SANCTION_DATE", "comp_ACTUAL_END_DATE"):
        row[col] = pd.to_datetime(row[col]) if col in row else pd.NaT
    for col in ("rec_RECOMMENDED_AMOUNT", "SANCTION_AMOUNT", "exp_total_disbursed", "exp_row_count", "exp_vendor_count"):
        row[col] = pd.to_numeric(row[col], errors="coerce") if col in row else np.nan
    for col in ("has_sanctioned", "has_completed", "has_expenditure", "exp_any_success", "exp_any_inprogress",
                "rec_ACTIVITY_NAME_CLEAN", "STATE_NAME"):
        if col not in row:
            row[col] = None
    X, _ = build_features(row, as_of)
    X["activity_freq"] = freq_tables["activity"].get(work.get("rec_ACTIVITY_NAME_CLEAN"), np.nan)
    X["state_freq"] = freq_tables["state"].get(work.get("STATE_NAME"), np.nan)
    return X


# ---------------------------------------------------------------------------
# isolation forest per amount tier
# ---------------------------------------------------------------------------
def _amount(df: pd.DataFrame) -> pd.Series:
    return df["SANCTION_AMOUNT"].fillna(df["rec_RECOMMENDED_AMOUNT"])


def fit_tier_forests(X: pd.DataFrame, amount: pd.Series, medians: dict) -> dict:
    edges = list(np.nanquantile(np.log10(amount.where(amount > 0)), np.linspace(0, 1, N_TIERS + 1))[1:-1])
    tier = np.digitize(np.log10(amount.where(amount > 0)).fillna(-1), edges)
    Xf = X.fillna(medians)
    forests = {}
    for t in range(N_TIERS):
        part = Xf[tier == t]
        if len(part) < 200:
            continue
        iso = IsolationForest(n_estimators=200, contamination="auto", random_state=42).fit(part)
        s = iso.score_samples(part)
        forests[t] = {"iso": iso, "range": (float(s.min()), float(s.max()))}
    return {"edges": edges, "forests": forests}


def tier_anomaly(X: pd.DataFrame, amount: pd.Series, bundle: dict, medians: dict) -> np.ndarray:
    tier = np.digitize(np.log10(amount.where(amount > 0)).fillna(-1), bundle["edges"])
    Xf = X.fillna(medians)
    out = np.full(len(X), np.nan)
    for t, fm in bundle["forests"].items():
        mask = tier == t
        if mask.any():
            lo, hi = fm["range"]
            raw = fm["iso"].score_samples(Xf[mask])
            out[mask] = np.clip((hi - raw) / (hi - lo), 0, 1) if hi > lo else np.nan
    return out


def anomaly_scores(spine: pd.DataFrame | None = None) -> pd.DataFrame:
    """[work_number, scope_house, scope_tenure, anomaly_score] for every work
    - attached to work_risk to reorder the queue within a priority band."""
    cfg = load_detector_config()
    as_of = pd.Timestamp(cfg["as_of_date"])
    spine = spine if spine is not None else pd.read_parquet(DATA_PROCESSED / "spine.parquet")
    X, _ = build_features(spine, as_of)
    medians = {c: float(X[c].median()) for c in FEATURE_COLS}
    amount = _amount(spine)
    forests = fit_tier_forests(X, amount, medians)
    return pd.DataFrame({
        "work_number": spine["WORK_RECOMMENDATION_DTL_ID"].astype("int64").astype(str),
        "scope_house": spine["SCOPE_HOUSE"], "scope_tenure": spine["SCOPE_TENURE"],
        "anomaly_score": np.round(tier_anomaly(X, amount, forests, medians), 4),
    })


# ---------------------------------------------------------------------------
# rule-agreement classifier
# ---------------------------------------------------------------------------
def grouped_auc(clf, X, y, groups, n_splits=5):
    """Out-of-fold AUC with GroupKFold. None when a fold can't be scored
    (one class only) - never a stand-in number."""
    oof = np.full(len(y), np.nan)
    for train, test in GroupKFold(n_splits=n_splits).split(X, y, groups):
        if y.iloc[train].nunique() < 2:
            return None, None, None
        model = clf.__class__(**clf.get_params()).fit(X.iloc[train], y.iloc[train])
        oof[test] = model.predict_proba(X.iloc[test])[:, 1]
        last = (model, test)
    try:
        auc = float(roc_auc_score(y, oof))
    except ValueError:
        auc = None
    return auc, oof, last


def train_model() -> dict:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    spine_path, wr_path = DATA_PROCESSED / "spine.parquet", DATA_FINDINGS / "work_risk.parquet"
    if not spine_path.exists() or not wr_path.exists():
        raise FileNotFoundError("spine.parquet and work_risk.parquet are both required - run the pipeline first.")
    cfg = load_detector_config()
    as_of = pd.Timestamp(cfg["as_of_date"])
    spine = pd.read_parquet(spine_path)
    work_risk = pd.read_parquet(wr_path)
    spine["work_number"] = spine["WORK_RECOMMENDATION_DTL_ID"].astype("int64").astype(str)

    high = work_risk.loc[work_risk["max_severity"] == "high", ["work_number", "scope_house", "scope_tenure"]].drop_duplicates()
    high["is_high"] = 1
    df = spine.merge(high, how="left", left_on=["work_number", "SCOPE_HOUSE", "SCOPE_TENURE"],
                     right_on=["work_number", "scope_house", "scope_tenure"])
    y = df["is_high"].fillna(0).astype(int)
    X, freq_tables = build_features(df, as_of)
    groups = df["CONSTITUENCY_ID"].fillna(-1)

    clf = HistGradientBoostingClassifier(max_iter=150, learning_rate=0.08, max_depth=6, random_state=42)
    auc, _oof, last = grouped_auc(clf, X, y, groups)
    importance_ranking = []
    if last is not None:
        model, test = last
        importance_ranking = compute_importance_ranking(model, X.iloc[test], y.iloc[test], FEATURE_COLS)
    clf.fit(X, y)

    feature_stats = compute_feature_stats(X, FEATURE_COLS)
    medians = {c: s["median"] for c, s in feature_stats.items()}
    forests = fit_tier_forests(X, _amount(df), medians)

    bundle = {
        "clf": clf, "forests": forests, "freq_tables": freq_tables, "as_of": as_of,
        "importance_ranking": importance_ranking, "feature_stats": feature_stats,
        "metrics": {"rule_agreement_auc": round(auc, 3) if auc is not None else None,
                    "evaluation": "GroupKFold(5) by constituency, out-of-fold",
                    "n": int(len(X)), "positive_rate": round(float(y.mean()), 4), "n_features": len(FEATURE_COLS)},
    }
    joblib.dump(bundle, MODEL_PATH)
    print(f"  rule-agreement model: out-of-fold AUC={bundle['metrics']['rule_agreement_auc']} "
          f"(GroupKFold by constituency), positive rate {y.mean():.3f}, n={len(X):,}")
    return bundle["metrics"]


_model_bundle = None


def get_model():
    global _model_bundle
    if _model_bundle is None:
        if not MODEL_PATH.exists():
            train_model()
        _model_bundle = joblib.load(MODEL_PATH)
        if "forests" not in _model_bundle:          # bundle from before this change
            train_model()
            _model_bundle = joblib.load(MODEL_PATH)
    return _model_bundle


def predict(work: dict) -> dict:
    """work: the raw spine row for one work. Returns the rule-agreement
    score (how closely this work resembles works the rules graded high) and
    the anomaly score. Neither is a risk judgement of its own."""
    try:
        bundle = get_model()
        X = build_inference_features(work, bundle["freq_tables"], bundle["as_of"])
        score = float(bundle["clf"].predict_proba(X)[0, 1])
        medians = {c: s["median"] for c, s in bundle["feature_stats"].items()}
        amount = pd.Series([work.get("SANCTION_AMOUNT") if pd.notna(work.get("SANCTION_AMOUNT"))
                            else work.get("rec_RECOMMENDED_AMOUNT")], dtype="float64")
        anomaly = tier_anomaly(X, amount, bundle["forests"], medians)[0]
        return {
            "rule_agreement_score": round(score, 3),
            "anomaly_score": None if np.isnan(anomaly) else round(float(anomaly), 3),
            "top_drivers": explain_drivers(X.iloc[0].to_dict(), bundle["importance_ranking"], bundle["feature_stats"], HUMAN_LABEL),
            "model_auc": bundle["metrics"].get("rule_agreement_auc"),
            "evaluation": bundle["metrics"].get("evaluation"),
        }
    except Exception as e:
        return {"rule_agreement_score": None, "anomaly_score": None,
                "top_drivers": [f"Model unavailable ({e})"], "model_auc": None, "evaluation": None}


# ---------------------------------------------------------------------------
# model on real reviewer labels (spec 6.6)
# ---------------------------------------------------------------------------
def precision_at_k(y_true: np.ndarray, scores: np.ndarray, k: int) -> float | None:
    if len(y_true) < k:
        return None
    top = np.argsort(-scores)[:k]
    return float(np.mean(y_true[top]))


def train_label_model() -> dict:
    """Trained only on officer verdicts (verified = 1, dismissed = 0). Below
    the threshold it reports why and does nothing."""
    from sklearn.calibration import CalibratedClassifierCV
    from engine.validation import load_statuses

    cfg = load_detector_config()
    need = cfg["feedback"]["min_reviews_for_label_model"]
    statuses = [s for s in load_statuses() if s["status"] in ("verified", "dismissed")]
    if len(statuses) < need:
        msg = f"label model not trained: {len(statuses)} reviewed findings < {need} required"
        print(f"  {msg}")
        return {"trained": False, "reason": msg}

    as_of = pd.Timestamp(cfg["as_of_date"])
    spine = pd.read_parquet(DATA_PROCESSED / "spine.parquet")
    spine["work_number"] = spine["WORK_RECOMMENDATION_DTL_ID"].astype("int64").astype(str)
    labels = pd.DataFrame(statuses)
    labels["y"] = (labels["status"] == "verified").astype(int)
    df = labels.merge(spine, left_on=["work_number", "scope_house", "scope_tenure"],
                      right_on=["work_number", "SCOPE_HOUSE", "SCOPE_TENURE"])
    X, freq_tables = build_features(df, as_of)
    y, groups = df["y"], df["CONSTITUENCY_ID"].fillna(-1)
    base = HistGradientBoostingClassifier(max_iter=100, learning_rate=0.08, max_depth=4, random_state=42)
    oof = np.full(len(y), np.nan)
    for train, test in GroupKFold(n_splits=5).split(X, y, groups):
        model = CalibratedClassifierCV(base, method="isotonic", cv=3).fit(X.iloc[train], y.iloc[train])
        oof[test] = model.predict_proba(X.iloc[test])[:, 1]
    final = CalibratedClassifierCV(base, method="isotonic", cv=3).fit(X, y)
    metrics = {"trained": True, "n": int(len(y)),
               "precision_at_50": precision_at_k(y.values, oof, 50),
               "precision_at_100": precision_at_k(y.values, oof, 100)}
    joblib.dump({"model": final, "freq_tables": freq_tables, "metrics": metrics}, LABEL_MODEL_PATH)
    print(f"  label model: {metrics}")
    return metrics


if __name__ == "__main__":
    train_model()
