"""Pre-sanction delay predictor for MPLADS works.

Question: at the moment a work is recommended, how likely is it to be
seriously delayed - sanctioned unusually late, or finished unusually late
(or not at all)? Everything the model reads is known on the recommendation
date; nothing decided later leaks in.

Target (delay_labels): a work is DELAYED if its recommendation-to-sanction
time, or its sanction-to-completion time, is above the 90th percentile of
all training works - or if it has already waited longer than that without
the next step happening. It is ON TIME if both steps are done within those
limits. A work too young to tell yet (e.g. sanctioned last month, still
open) is UNKNOWN and left out of training - calling it "on time" would
teach the model that unfinished works are fine.

Training data: 17th Lok Sabha works recommended from models.delay.train_from
(2023-04-01, eSAKSHI go-live). Before that date the data holds only the ~900
works still unfinished at migration, all of them delayed.

Model: gradient-boosted trees (HistGradientBoostingClassifier, early
stopping), isotonic-calibrated on grouped out-of-fold scores so the output
is a real probability. Evaluated two ways: GroupKFold by constituency, and
forward in time (train on earlier works, test on later ones).
"""
import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import (average_precision_score, brier_score_loss, precision_score, recall_score,
                             roc_auc_score)
from sklearn.model_selection import GroupKFold

from engine.paths import DATA_PROCESSED, ROOT
from engine.detectors import load_config as load_detector_config
from engine.explain import compute_importance_ranking, compute_feature_stats, explain_drivers

MODEL_DIR = ROOT / "data" / "models"
MODEL_PATH = MODEL_DIR / "delay_predictor.joblib"
BUNDLE_VERSION = 3

# The work itself
WORK_FEATURES = ["log_amount", "relative_cost", "desc_len"]
# When it was recommended
TIMING_FEATURES = ["rec_month", "rec_quarter", "is_fy_end_quarter"]
# Where / what (how common the place and activity are)
PLACE_FEATURES = ["activity_freq", "state_freq", "district_freq"]
# How busy the system was on that day - read only from earlier recommendations
CONTEXT_FEATURES = ["letter_batch_size", "mp_recs_prev_30d", "ida_recs_prev_90d"]
FEATURE_COLS = WORK_FEATURES + TIMING_FEATURES + PLACE_FEATURES + CONTEXT_FEATURES

HUMAN_LABEL = {
    "log_amount": "Recommended amount",
    "relative_cost": "Cost vs. similar works in the same state and activity",
    "desc_len": "Length of the work description",
    "rec_month": "Recommendation month",
    "rec_quarter": "Recommendation quarter",
    "is_fy_end_quarter": "Recommended in the Jan-Mar financial-year-end window",
    "activity_freq": "How common this activity type is",
    "state_freq": "How common works from this state are",
    "district_freq": "How common works from this district are",
    "letter_batch_size": "Works recommended in the same letter",
    "mp_recs_prev_30d": "Works this MP recommended in the previous 30 days",
    "ida_recs_prev_90d": "Works the district authority received in the previous 90 days",
}

DEFAULT_PARAMS = dict(max_iter=600, learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=40,
                      l2_regularization=1.0, early_stopping=True, validation_fraction=0.1, n_iter_no_change=30)


# ---------------------------------------------------------------------------
# target
# ---------------------------------------------------------------------------
def delay_labels(df: pd.DataFrame, as_of: pd.Timestamp, gates: tuple[float, float] | None = None):
    """(y, (sanction_gate, execution_gate)). y is 1 delayed, 0 on time, NaN
    not knowable yet. Gates are the 90th percentiles of the two lags."""
    rec = df["rec_RECOMMENDATION_DATE"]
    san_date = df["san_SANCTION_DATE"]
    san_lag = (san_date - rec).dt.days
    exec_lag = (df["comp_ACTUAL_END_DATE"] - san_date).dt.days
    if gates is None:
        gates = (float(san_lag.dropna().quantile(0.90)), float(exec_lag.dropna().quantile(0.90)))
    g_san, g_exec = gates
    sanctioned = df["has_sanctioned"].fillna(False).astype(bool)
    completed = df["has_completed"].fillna(False).astype(bool)
    waiting_sanction = (as_of - rec).dt.days
    waiting_completion = (as_of - san_date).dt.days

    late = ((san_lag > g_san) | (~sanctioned & (waiting_sanction > g_san))
            | (exec_lag > g_exec) | (sanctioned & ~completed & (waiting_completion > g_exec)))
    on_time = sanctioned & completed & (san_lag <= g_san) & (exec_lag <= g_exec)
    y = pd.Series(np.nan, index=df.index)
    y[on_time] = 0.0
    y[late] = 1.0
    return y, gates


# ---------------------------------------------------------------------------
# features
# ---------------------------------------------------------------------------
def _count_before(event_times: np.ndarray, t: np.ndarray, days: int) -> np.ndarray:
    """How many events fall in [t - days, t) - strictly before t."""
    lo = np.searchsorted(event_times, t - np.timedelta64(days, "D"), side="left")
    return np.searchsorted(event_times, t, side="left") - lo


def recommendation_context(rows: pd.DataFrame, history: pd.DataFrame) -> pd.DataFrame:
    """The three workload features for `rows`, read from `history` (the full
    spine): how many works share this work's recommendation letter, how many
    the same MP recommended in the 30 days before, and how many the same
    district authority received in the 90 days before. Only recommendation
    dates strictly before this work's own are counted - nothing later."""
    out = pd.DataFrame(np.nan, index=rows.index, columns=CONTEXT_FEATURES)
    # only the history rows that share a letter / MP / authority with `rows`
    # are read - one work's prediction scans a handful of rows, not the spine
    if "rec_LETTER_NO" in rows and "rec_LETTER_NO" in history:
        letters = history["rec_LETTER_NO"]
        sizes = letters[letters.isin(rows["rec_LETTER_NO"].dropna().unique())].value_counts()
        out["letter_batch_size"] = rows["rec_LETTER_NO"].map(sizes)
    t_all = pd.to_datetime(rows["rec_RECOMMENDATION_DATE"])
    for key, col, days in (("MP_NAME", "mp_recs_prev_30d", 30), ("IDA_NAME_CLEAN", "ida_recs_prev_90d", 90)):
        if key not in rows or key not in history:
            continue
        hist = history.loc[history[key].isin(rows[key].dropna().unique()), [key, "rec_RECOMMENDATION_DATE"]].dropna()
        times = {k: np.sort(g.values) for k, g in hist.groupby(key)["rec_RECOMMENDATION_DATE"]}
        known = rows[key].notna() & t_all.notna()
        for k, idx in rows[known].groupby(key).groups.items():
            ts = times.get(k)
            if ts is not None:
                out.loc[idx, col] = _count_before(ts, t_all.loc[idx].values.astype("datetime64[ns]"), days)
            else:
                out.loc[idx, col] = 0
    return out


def _cost_table(log_amount: pd.Series, state: pd.Series, activity: pd.Series) -> dict:
    """Median log10 amount per (state, activity) with >= 5 works, per state,
    and overall - the specific-to-general fallback detectors.py's peer gate
    also uses."""
    d = pd.DataFrame({"la": log_amount, "state": state, "activity": activity}).dropna(subset=["la"])
    sizes = d.groupby(["state", "activity"])["la"].transform("size")
    return {"by_group": d[sizes >= 5].groupby(["state", "activity"])["la"].median(),
            "by_state": d.groupby("state")["la"].median(),
            "overall": float(d["la"].median()) if len(d) else 0.0}


def _relative_cost(log_amount: pd.Series, state: pd.Series, activity: pd.Series, table: dict) -> pd.Series:
    """log10(amount) - peer median log10(amount): +0.3 means about 2x its
    peers. Vectorised lookups with the same fallback order."""
    idx = pd.MultiIndex.from_arrays([state, activity])
    base = pd.Series(table["by_group"].reindex(idx).to_numpy(), index=log_amount.index)
    base = base.fillna(pd.Series(state.map(table["by_state"]).to_numpy(), index=log_amount.index))
    return log_amount - base.fillna(table["overall"])


def _activity(df: pd.DataFrame) -> pd.Series:
    col = "rec_ACTIVITY_NAME_CLEAN" if "rec_ACTIVITY_NAME_CLEAN" in df else "ACTIVITY_NAME"
    return df[col]


def build_features(df: pd.DataFrame, history: pd.DataFrame | None = None,
                   tables: dict | None = None) -> tuple[pd.DataFrame, dict]:
    """(X, lookup_tables). Frequency and cost tables are learned from `df`
    unless `tables` is passed (inference). Missing stays missing (NaN) - the
    trees handle it natively rather than being handed a guess."""
    amount = df["rec_RECOMMENDED_AMOUNT"].fillna(df["SANCTION_AMOUNT"]) if "SANCTION_AMOUNT" in df else df["rec_RECOMMENDED_AMOUNT"]
    amount = pd.to_numeric(amount, errors="coerce")
    log_amount = np.log10(amount.where(amount > 0))
    activity, state = _activity(df), df["STATE_NAME"]
    district = df["DISTRICT"] if "DISTRICT" in df else pd.Series(np.nan, index=df.index)
    if tables is None:
        tables = {"activity": activity.value_counts(normalize=True),
                  "state": state.value_counts(normalize=True),
                  "district": district.value_counts(normalize=True),
                  "cost": _cost_table(log_amount, state, activity)}
    rec = pd.to_datetime(df["rec_RECOMMENDATION_DATE"])
    X = pd.DataFrame({
        "log_amount": log_amount,
        "relative_cost": _relative_cost(log_amount, state, activity, tables["cost"]),
        "desc_len": (df["rec_WORK_DESCRIPTION"].astype("string").str.len().astype("float64")
                     if "rec_WORK_DESCRIPTION" in df else np.nan),
        "rec_month": rec.dt.month,
        "rec_quarter": rec.dt.quarter,
        # Jan-Mar: the Indian financial year's closing quarter
        "is_fy_end_quarter": rec.dt.month.isin([1, 2, 3]).astype(float).where(rec.notna()),
        "activity_freq": activity.map(tables["activity"]),
        "state_freq": state.map(tables["state"]),
        "district_freq": district.map(tables["district"]),
    }, index=df.index)
    X = pd.concat([X, recommendation_context(df, history if history is not None else df)], axis=1)
    return X[FEATURE_COLS].astype("float64"), tables


# ---------------------------------------------------------------------------
# training
# ---------------------------------------------------------------------------
def _top_share(y: np.ndarray, p: np.ndarray, frac: float = 0.1) -> float:
    k = max(1, int(len(y) * frac))
    return float(y[np.argsort(-p)[:k]].mean())


def train_model() -> dict:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    spine_path = DATA_PROCESSED / "spine.parquet"
    if not spine_path.exists():
        raise FileNotFoundError(f"Spine not found at {spine_path}. Run pipeline first.")
    spine = pd.read_parquet(spine_path)
    cfg = load_detector_config()
    mcfg = cfg.get("models", {})
    dcfg = mcfg.get("delay", {})
    as_of = pd.Timestamp(cfg["as_of_date"])
    seed = mcfg.get("random_state", 42)

    df = spine[spine["SCOPE_TENURE"] == "17th Lok Sabha"]
    train_from = dcfg.get("train_from")
    if train_from:
        df = df[df["rec_RECOMMENDATION_DATE"] >= pd.Timestamp(train_from)]
    y_all, gates = delay_labels(df, as_of)
    df = df[y_all.notna()].reset_index(drop=True)
    y = y_all.dropna().astype(int).reset_index(drop=True)
    n_unknown = int(y_all.isna().sum())

    X, tables = build_features(df, history=spine)
    groups = df["CONSTITUENCY_ID"].fillna(-1)
    params = {**DEFAULT_PARAMS, **dcfg.get("params", {}), "random_state": seed}

    def fit(Xa, ya):
        return HistGradientBoostingClassifier(**params).fit(Xa, ya)

    # grouped out-of-fold scores: no constituency on both sides of a split
    oof = np.full(len(y), np.nan)
    last = None
    for tr, te in GroupKFold(n_splits=mcfg.get("cv_folds", 5)).split(X, y, groups):
        m = fit(X.iloc[tr], y.iloc[tr])
        oof[te] = m.predict_proba(X.iloc[te])[:, 1]
        last = (m, te)
    auc = float(roc_auc_score(y, oof))
    pr_auc = float(average_precision_score(y, oof))

    # isotonic calibration on those out-of-fold scores (monotone: can't
    # reorder works, so AUC is unchanged; 0.7 then means ~70% were delayed)
    calibrator = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(oof, y) \
        if dcfg.get("calibrate") else None
    oof_p = calibrator.predict(oof) if calibrator is not None else oof
    y_pred = (oof_p >= 0.5).astype(int)

    # tiers: "auto" = cut-offs at the 90th / 60th percentile of the
    # calibrated out-of-fold probabilities - High is the riskiest 10% of past
    # works, Medium the next 30% - and how often each tier really was delayed
    # is recorded with it. Fixed numbers can also be given in config.
    tier_cfg = dcfg.get("tiers", "auto")
    if tier_cfg == "auto":
        tiers = {"high": round(float(np.quantile(oof_p, 0.9)), 3), "medium": round(float(np.quantile(oof_p, 0.6)), 3)}
    else:
        tiers = tier_cfg
    in_high, in_med = oof_p >= tiers["high"], (oof_p >= tiers["medium"]) & (oof_p < tiers["high"])
    tier_delay_rate = {"high": round(float(y[in_high].mean()), 3) if in_high.any() else None,
                       "medium": round(float(y[in_med].mean()), 3) if in_med.any() else None,
                       "low": round(float(y[~(in_high | in_med)].mean()), 3)}

    # forward in time: earliest 70% by recommendation date -> latest 30%
    cut = df["rec_RECOMMENDATION_DATE"].quantile(0.7)
    early = (df["rec_RECOMMENDATION_DATE"] < cut).to_numpy()
    late = ~early
    fwd = fit(X[early], y[early]).predict_proba(X[late])[:, 1]

    model, te = last
    importance_ranking = compute_importance_ranking(model, X.iloc[te], y.iloc[te], FEATURE_COLS)
    clf = fit(X, y)

    metrics = {
        "auc": round(auc, 3),
        "pr_auc": round(pr_auc, 3),
        "precision": round(float(precision_score(y, y_pred, zero_division=0)), 3),
        "recall": round(float(recall_score(y, y_pred, zero_division=0)), 3),
        "precision_at_10pct": round(_top_share(y.to_numpy(), oof), 3),
        "brier": round(float(brier_score_loss(y, oof_p)), 4),
        "forward_auc": round(float(roc_auc_score(y[late], fwd)), 3),
        "forward_pr_auc": round(float(average_precision_score(y[late], fwd)), 3),
        "forward_precision_at_10pct": round(_top_share(y[late].to_numpy(), fwd), 3),
        "positive_rate": round(float(y.mean()), 4),
        "n": int(len(y)), "n_unknown_outcome_excluded": n_unknown,
        "trees": int(clf.n_iter_),
        "tiers": tiers, "tier_observed_delay_rate": tier_delay_rate,
        "gates_days": {"sanction": round(gates[0]), "execution": round(gates[1])},
        "calibration": dcfg.get("calibrate") or "none",
        "evaluation": "GroupKFold(5) by constituency, out-of-fold",
        "trained_on": f"17th Lok Sabha works recommended from {train_from}" if train_from else "17th Lok Sabha works",
        "forward_evaluation": f"trained on works recommended before {cut.date()}, tested on later ones",
    }
    joblib.dump({
        "version": BUNDLE_VERSION, "model": clf, "calibrator": calibrator, "feature_cols": FEATURE_COLS,
        "tables": tables, "tiers": tiers,
        "importance_ranking": importance_ranking, "feature_stats": compute_feature_stats(X, FEATURE_COLS),
        "metrics": metrics,
    }, MODEL_PATH)
    print(f"  delay model: AUC={metrics['auc']} PR-AUC={metrics['pr_auc']} precision@10%={metrics['precision_at_10pct']} "
          f"recall={metrics['recall']} Brier={metrics['brier']} (n={metrics['n']:,}, {n_unknown:,} not yet knowable excluded, "
          f"{metrics['trees']} trees)")
    print(f"  delay tiers: High >= {tiers['high']} (observed delay rate {tier_delay_rate['high']}), "
          f"Medium >= {tiers['medium']} ({tier_delay_rate['medium']}), Low ({tier_delay_rate['low']})")
    print(f"  delay model, forward in time (train before {cut.date()}, test after): AUC={metrics['forward_auc']} "
          f"PR-AUC={metrics['forward_pr_auc']} precision@10%={metrics['forward_precision_at_10pct']}")
    print(f"Saved to {MODEL_PATH}")
    return metrics


# ---------------------------------------------------------------------------
# inference
# ---------------------------------------------------------------------------
_model_bundle = None


def get_model():
    global _model_bundle
    if _model_bundle is None:
        if not MODEL_PATH.exists():
            train_model()
        _model_bundle = joblib.load(MODEL_PATH)
        if _model_bundle.get("version") != BUNDLE_VERSION:      # bundle from an older feature set
            train_model()
            _model_bundle = joblib.load(MODEL_PATH)
    return _model_bundle


def predict_work_risk(amount: float | None, state: str | None, activity: str | None, month: int | None = None,
                      district: str | None = None, work: dict | None = None,
                      history: pd.DataFrame | None = None) -> dict:
    """Predicted delay probability, tier and the model's own reasons.

    For a real work, pass its spine row as `work` and the spine as `history`:
    every feature, including the workload context, is then read from the
    real record. For a "what if" query only amount/state/activity/month/
    district are known; everything else is NaN to the model, never guessed."""
    try:
        bundle = get_model()
        if work is not None:
            row = pd.DataFrame([work])
            row["rec_RECOMMENDATION_DATE"] = pd.to_datetime(row.get("rec_RECOMMENDATION_DATE"))
        else:
            row = pd.DataFrame([{
                "rec_RECOMMENDED_AMOUNT": amount, "STATE_NAME": state, "rec_ACTIVITY_NAME_CLEAN": activity,
                "DISTRICT": district,
                "rec_RECOMMENDATION_DATE": pd.Timestamp(2000, month, 1) if month else pd.NaT,
            }])
        X, _ = build_features(row, history=history if work is not None else row.iloc[0:0], tables=bundle["tables"])
        if work is None:
            X.loc[:, CONTEXT_FEATURES + ["desc_len"]] = np.nan
        proba = float(bundle["model"].predict_proba(X)[0, 1])
        if bundle.get("calibrator") is not None:
            proba = float(bundle["calibrator"].predict([proba])[0])
        tiers = bundle.get("tiers", {"high": 0.70, "medium": 0.40})
        tier = "High" if proba >= tiers["high"] else "Medium" if proba >= tiers["medium"] else "Low"
        return {
            "predicted_delay_probability": round(proba, 3),
            "risk_tier": tier,
            "drivers": explain_drivers(X.iloc[0].to_dict(), bundle.get("importance_ranking", []),
                                       bundle.get("feature_stats", {}), HUMAN_LABEL),
            "model_auc": bundle["metrics"].get("auc"),
            "model_forward_auc": bundle["metrics"].get("forward_auc"),
        }
    except Exception as e:
        return {"predicted_delay_probability": None, "risk_tier": None,
                "drivers": [f"Model unavailable ({e})"], "model_auc": None, "model_forward_auc": None}


if __name__ == "__main__":
    train_model()
