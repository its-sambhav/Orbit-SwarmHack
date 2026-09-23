"""Pre-Sanction Predictive Delay Risk Engine for MPLADS works.

Trains a HistGradientBoostingClassifier on historical 17th Lok Sabha works
to predict the probability of a work experiencing severe execution/sanction
delays at the moment of recommendation, before public funds are locked.
"""
import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.isotonic import IsotonicRegression
from sklearn.model_selection import GroupKFold
from sklearn.metrics import brier_score_loss, roc_auc_score, precision_score, recall_score

from engine.paths import DATA_PROCESSED, ROOT
from engine.detectors import load_config as load_detector_config
from engine.explain import compute_importance_ranking, compute_feature_stats, explain_drivers

MODEL_DIR = ROOT / "data" / "models"
MODEL_PATH = MODEL_DIR / "delay_predictor.joblib"

# 8 features, all knowable at the moment of recommendation (no leakage of
# anything decided later). Wider than the original 5 (log_amount, rec_month,
# rec_quarter, activity_freq, state_freq, kept below). "Days left in the
# term" was tried and removed: today's 18th Lok Sabha works sit 1,000-1,800
# days before their term ends, a range the post-2023 training works never
# cover, so the model extrapolated and called 56% of current works >= 99%
# likely to be delayed. See
# engine/risk_model.py for the broader, ~19-raw-feature risk + anomaly model
# trained against every detector's output, not just a delay guideline. This
# model stays a distinct, narrower question ("will THIS work be late") on
# purpose; the addition here is depth of evidence for that one question, not
# scope creep into risk_model.py's job.
FEATURE_COLS = [
    "log_amount", "rec_month", "rec_quarter", "is_fy_end_quarter", "relative_cost",
    "activity_freq", "state_freq", "district_freq",
]

HUMAN_LABEL = {
    "log_amount": "Recommended amount",
    "rec_month": "Recommendation month",
    "rec_quarter": "Recommendation quarter",
    "is_fy_end_quarter": "Recommended in the Jan-Mar financial-year-end window",
    "relative_cost": "Cost vs. similar works in the same state and activity",
    "activity_freq": "How common this activity type is",
    "state_freq": "How common works from this state are",
    "district_freq": "How common works from this district are",
}


def _cost_lookup_table(log_amount: pd.Series, state: pd.Series, activity: pd.Series) -> dict:
    """{(state, activity): median log10 amount} for groups with >= 5 works,
    plus a per-state and an overall fallback - same specific-to-general
    fallback engine/detectors.py's peer_percentiles() uses for the delay
    gate, so a work in a thin (state, activity) cell still gets a sensible
    "expensive for its peers" comparison instead of NaN."""
    d = pd.DataFrame({"log_amount": log_amount, "state": state, "activity": activity}).dropna(subset=["log_amount"])
    overall = float(d["log_amount"].median()) if len(d) else 0.0
    by_state = d.groupby("state")["log_amount"].median().to_dict()
    sizes = d.groupby(["state", "activity"])["log_amount"].transform("size")
    by_group = d[sizes >= 5].groupby(["state", "activity"])["log_amount"].median().to_dict()
    return {"by_group": by_group, "by_state": by_state, "overall": overall}


def _relative_cost(log_amt: float, state, activity, table: dict) -> float:
    if log_amt is None or (isinstance(log_amt, float) and np.isnan(log_amt)):
        return np.nan
    if (state, activity) in table["by_group"]:
        base = table["by_group"][(state, activity)]
    elif state in table["by_state"]:
        base = table["by_state"][state]
    else:
        base = table["overall"]
    return log_amt - base


def build_features(df: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """Given an already-scoped spine slice, returns (X, lookup_tables) - the
    feature frame this module's delay classifier trains and predicts on.
    Missing stays missing - the classifier handles NaN natively, so it
    learns what "unknown" means instead of being handed a guessed value."""
    df = df.copy()
    amount = df["rec_RECOMMENDED_AMOUNT"].fillna(df["SANCTION_AMOUNT"])
    log_amount = np.log10(amount.where(amount > 0))
    df["log_amount"] = log_amount
    df["rec_month"] = df["rec_RECOMMENDATION_DATE"].dt.month
    df["rec_quarter"] = df["rec_RECOMMENDATION_DATE"].dt.quarter
    # Jan-Mar: the Indian financial year's closing quarter, when MPLADS
    # sanctioning authorities are historically working through a backlog to
    # keep the year's utilisation numbers up - a distinct effect from the
    # already-present calendar rec_quarter, which a tree model can split on
    # numerically but not name.
    df["is_fy_end_quarter"] = df["rec_month"].isin([1, 2, 3]).astype(float)

    activity_col = "rec_ACTIVITY_NAME_CLEAN" if "rec_ACTIVITY_NAME_CLEAN" in df.columns else "ACTIVITY_NAME"
    activity_counts = df[activity_col].value_counts(normalize=True).to_dict()
    df["activity_freq"] = df[activity_col].map(activity_counts)

    state_counts = df["STATE_NAME"].value_counts(normalize=True).to_dict()
    df["state_freq"] = df["STATE_NAME"].map(state_counts)

    if "DISTRICT" in df.columns:
        district_counts = df["DISTRICT"].value_counts(normalize=True).to_dict()
        df["district_freq"] = df["DISTRICT"].map(district_counts)
    else:
        district_counts = {}
        df["district_freq"] = np.nan

    cost_table = _cost_lookup_table(log_amount, df["STATE_NAME"], df[activity_col])
    df["relative_cost"] = [
        _relative_cost(la, st, ac, cost_table)
        for la, st, ac in zip(log_amount, df["STATE_NAME"], df[activity_col])
    ]

    tables = {"activity": activity_counts, "state": state_counts, "district": district_counts, "cost": cost_table}
    return df[FEATURE_COLS], tables


def build_inference_features(amount, state, activity, month, tables: dict, district=None) -> pd.DataFrame:
    """Single-row feature frame for a live prediction - same columns as
    build_features(). Unknown inputs are NaN, never a guessed default."""
    amount = float(amount) if amount is not None and not pd.isna(amount) and float(amount) > 0 else np.nan
    log_amount = np.log10(amount) if not np.isnan(amount) else np.nan
    return pd.DataFrame([{
        "log_amount": log_amount,
        "rec_month": month if month is not None else np.nan,
        "rec_quarter": (month - 1) // 3 + 1 if month is not None else np.nan,
        "is_fy_end_quarter": float(month in (1, 2, 3)) if month is not None else np.nan,
        "relative_cost": _relative_cost(log_amount, state, activity, tables["cost"]),
        "activity_freq": tables["activity"].get(activity, np.nan),
        "state_freq": tables["state"].get(state, np.nan),
        "district_freq": tables["district"].get(district, np.nan),
    }], dtype="float64")


def train_model() -> dict:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    spine_path = DATA_PROCESSED / "spine.parquet"
    if not spine_path.exists():
        raise FileNotFoundError(f"Spine not found at {spine_path}. Run pipeline first.")

    spine = pd.read_parquet(spine_path)

    cfg = load_detector_config()
    mcfg = cfg.get("models", {})
    dcfg = mcfg.get("delay", {})

    # Train on 17th Lok Sabha works recommended on or after `train_from`
    # (2023-04-01, when MPLADS moved to the eSAKSHI portal). Before that date
    # the data holds only ~900 17th LS works - the ones still unfinished when
    # records were carried over - and every one of them is "delayed" (100%,
    # against 36% after). Left in, they taught the model "an early
    # recommendation means a delay", an artefact of how the records were
    # migrated, not of how works run. From train_from on, the population is
    # complete.
    df = spine[spine["SCOPE_TENURE"] == "17th Lok Sabha"].copy()
    train_from = dcfg.get("train_from")
    if train_from:
        df = df[df["rec_RECOMMENDATION_DATE"] >= pd.Timestamp(train_from)]
    if len(df) < 1000:
        df = spine.copy()

    # Ground truth target: is this work unusually slow relative to its own
    # real population, not a fixed day-count. engine/detectors.py's own delay
    # detectors went through exactly this recalibration already (see
    # docs/SCHEMA.md's "Flag-rate recalibration") after finding the fixed
    # MPLADS guideline (45 days to sanction, 365 to complete) is missed by
    # 28-69% of real works - failing the guideline is this system's norm, not
    # a deviation from it. Gating each delay metric on its own 90th
    # percentile (same convention as detectors.py's dynamic_gate()) fixes the
    # target at its source instead of just relabelling the output.
    #
    # A sanctioned work with no completion date is either genuinely still
    # running or has stalled - comp_ACTUAL_END_DATE being NaT does not mean
    # "on time", and treating it that way is itself a bug that was here
    # before this comment: of the 20,362 17th-Lok-Sabha works sanctioned and
    # never completed, 17,261 had already sat open for a median of 918 days
    # (past the 699-day execution-delay gate) and were still being scored as
    # "not delayed" purely because dt.days on a NaT comparison is NaN, which
    # `>` silently evaluates to False. Every one of those was mislabelled
    # negative, which is most of why recall was only 0.163 - the model was
    # trained to say "on time" about works that had been stuck for years.
    # The fix scores those against the work's age as of the snapshot date
    # instead of a completion date that doesn't exist.
    as_of = pd.Timestamp(cfg["as_of_date"])
    san_delay = (df["san_SANCTION_DATE"] - df["rec_RECOMMENDATION_DATE"]).dt.days
    exec_delay = (df["comp_ACTUAL_END_DATE"] - df["san_SANCTION_DATE"]).dt.days
    san_gate = san_delay.dropna().quantile(0.90)
    exec_gate = exec_delay.dropna().quantile(0.90)
    age_since_sanction = (as_of - df["san_SANCTION_DATE"]).dt.days
    open_overdue = df["has_sanctioned"] & ~df["has_completed"] & (age_since_sanction > exec_gate)

    is_delayed = (
        (san_delay > san_gate) | (exec_delay > exec_gate)
        | (df["has_recommended"] & ~df["has_sanctioned"]) | open_overdue
    ).astype(int)
    df["target"] = is_delayed

    X, tables = build_features(df)
    y = df["target"]
    groups = df["CONSTITUENCY_ID"].fillna(-1)

    params = {**dict(max_iter=100, learning_rate=0.08, max_depth=5), **dcfg.get("params", {}),
              "random_state": mcfg.get("random_state", 42)}
    calibrate = dcfg.get("calibrate")

    # out-of-fold scores with GroupKFold by constituency - a random split puts
    # near-identical works from one constituency on both sides of the split
    oof = np.full(len(y), np.nan)
    last = None
    for train, test in GroupKFold(n_splits=mcfg.get("cv_folds", 5)).split(X, y, groups):
        fold = HistGradientBoostingClassifier(**params).fit(X.iloc[train], y.iloc[train])
        oof[test] = fold.predict_proba(X.iloc[test])[:, 1]
        last = (fold, test)
    try:
        auc = float(roc_auc_score(y, oof))
    except ValueError:
        auc = None          # not evaluated - never a stand-in number

    # Isotonic calibration fitted on those same out-of-fold scores: the
    # boosted score ranks well but isn't a probability; calibrated, 0.7 means
    # about 70% of such works really were delayed, so the fixed High/Medium
    # tier cut-offs mean something. Fitting it on grouped out-of-fold scores
    # (rather than sklearn's CalibratedClassifierCV, whose unshuffled inner
    # folds each saw different states - AUC fell to 0.605 that way) keeps it
    # honest and costs no extra training. Isotonic is monotone, so it can't
    # reorder works - AUC is reported on the raw scores.
    calibrator = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(oof, y) if calibrate else None
    oof_p = calibrator.predict(oof) if calibrator is not None else oof
    y_pred = (oof_p >= 0.5).astype(int)
    precision = float(precision_score(y, y_pred, zero_division=0))
    recall = float(recall_score(y, y_pred, zero_division=0))
    # precision@10% - the slice of the queue officers actually act on, same
    # spirit as risk_model.py's precision_at_k for the reviewer-label model.
    k = max(1, len(y) // 10)
    top_k = np.argsort(-np.nan_to_num(oof, nan=-1))[:k]
    precision_at_10pct = float(y.iloc[top_k].mean())
    brier = float(brier_score_loss(y, oof_p))

    # forward-in-time check: train on the earliest 70% of works by
    # recommendation date, score the latest 30%. This is the situation the
    # model is used in (predicting works that come after its training data)
    # and reads lower than the constituency split above; both are reported.
    forward_auc = forward_p10 = None
    cut = df["rec_RECOMMENDATION_DATE"].quantile(0.7)
    early = (df["rec_RECOMMENDATION_DATE"] < cut).to_numpy()
    late = (df["rec_RECOMMENDATION_DATE"] >= cut).to_numpy()
    if early.sum() and late.sum() and y[early].nunique() == 2 and y[late].nunique() == 2:
        fwd = HistGradientBoostingClassifier(**params).fit(X[early], y[early]).predict_proba(X[late])[:, 1]
        forward_auc = float(roc_auc_score(y[late], fwd))
        kf = max(1, int(late.sum()) // 10)
        forward_p10 = float(y[late].to_numpy()[np.argsort(-fwd)[:kf]].mean())

    importance_ranking = []
    if last is not None:
        fold, test = last
        importance_ranking = compute_importance_ranking(fold, X.iloc[test], y.iloc[test], FEATURE_COLS)

    clf = HistGradientBoostingClassifier(**params).fit(X, y)
    feature_stats = compute_feature_stats(X, FEATURE_COLS)

    artifacts = {
        "model": clf,
        "calibrator": calibrator,
        "feature_cols": FEATURE_COLS,
        "tables": tables,
        "tiers": dcfg.get("tiers", {"high": 0.70, "medium": 0.40}),
        "importance_ranking": importance_ranking,
        "feature_stats": feature_stats,
        "metrics": {
            "auc": round(auc, 3) if auc is not None else None,
            "precision": round(precision, 3),
            "recall": round(recall, 3),
            "precision_at_10pct": round(precision_at_10pct, 3),
            "brier": round(brier, 4),
            "calibration": calibrate or "none",
            "n": len(X),
            "positive_rate": round(float(y.mean()), 4),
            "evaluation": "GroupKFold(5) by constituency, out-of-fold",
            "trained_on": f"17th Lok Sabha works recommended from {train_from}" if train_from else "17th Lok Sabha works",
            "forward_auc": round(forward_auc, 3) if forward_auc is not None else None,
            "forward_precision_at_10pct": round(forward_p10, 3) if forward_p10 is not None else None,
            "forward_evaluation": f"trained on works recommended before {cut.date()}, tested on later ones",
        },
    }

    joblib.dump(artifacts, MODEL_PATH)
    print(f"  delay model: out-of-fold AUC={artifacts['metrics']['auc']}, precision={precision:.3f}, "
          f"recall={recall:.3f}, precision@10%={precision_at_10pct:.3f}, Brier={brier:.4f}, positive rate={y.mean():.3f}")
    if forward_auc is not None:
        print(f"  delay model, forward in time (train before {cut.date()}, test after): "
              f"AUC={forward_auc:.3f}, precision@10%={forward_p10:.3f}")
    print(f"Saved to {MODEL_PATH}")
    return artifacts["metrics"]


_model_bundle = None


def get_model():
    global _model_bundle
    if _model_bundle is None:
        if not MODEL_PATH.exists():
            train_model()
        _model_bundle = joblib.load(MODEL_PATH)
        if "tables" not in _model_bundle:          # bundle from before this change
            train_model()
            _model_bundle = joblib.load(MODEL_PATH)
    return _model_bundle


def predict_work_risk(amount: float | None, state: str | None, activity: str | None, month: int | None = None,
                      district: str | None = None) -> dict:
    """Computes predicted delay risk probability and contributing factors.
    Anything not supplied (e.g. `district` from the standalone "what if"
    form) is NaN to the model, never a guessed value."""
    try:
        bundle = get_model()
        clf = bundle["model"]
        tables = bundle["tables"]
        features = build_inference_features(amount, state, activity, month, tables, district=district)

        proba = float(clf.predict_proba(features)[0, 1])
        if bundle.get("calibrator") is not None:
            proba = float(bundle["calibrator"].predict([proba])[0])

        tiers = bundle.get("tiers", {"high": 0.70, "medium": 0.40})
        tier = "High" if proba >= tiers["high"] else "Medium" if proba >= tiers["medium"] else "Low"

        drivers = explain_drivers(features.iloc[0].to_dict(), bundle.get("importance_ranking", []),
                                  bundle.get("feature_stats", {}), HUMAN_LABEL)

        return {
            "predicted_delay_probability": round(proba, 3),
            "risk_tier": tier,
            "drivers": drivers,
            "model_auc": bundle["metrics"].get("auc"),
            "model_forward_auc": bundle["metrics"].get("forward_auc"),
        }
    except Exception as e:
        return {
            "predicted_delay_probability": None,
            "risk_tier": None,
            "drivers": [f"Model unavailable ({e})"],
            "model_auc": None,
            "model_forward_auc": None,
        }


if __name__ == "__main__":
    train_model()
