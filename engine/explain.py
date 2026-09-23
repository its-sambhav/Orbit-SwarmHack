"""Shared "why did the model say that" helpers for engine/predictive.py and
engine/risk_model.py, so both models explain themselves the same way: real
sklearn.inspection.permutation_importance computed once at training time
(which features the trained model actually learned matter, ranked - not a
human's guess), plus each feature's real p10/p90 from the training data. At
inference time, a work's own value for a top-ranked feature is compared
against that training-data spread, and only feature/value pairs that land in
an extreme decile are reported - "in the bottom 10% of all works" is a
statement about this work's real data against the model's own learned
ranking, not canned text.
"""
import numpy as np
import pandas as pd
from sklearn.inspection import permutation_importance


def compute_importance_ranking(model, X: pd.DataFrame, y: pd.Series, feature_cols: list[str],
                               sample_size: int = 20000, n_repeats: int = 5, random_state: int = 42) -> list[tuple[str, float]]:
    """Permutation importance of `model` (already fit) on a sample of
    (X, y), most important first. Returns [] if there are too few rows or
    only one class to score - never a fabricated ranking."""
    if len(X) < 2 or y.nunique() < 2:
        return []
    idx = X.index[:sample_size]
    perm = permutation_importance(model, X.loc[idx], y.loc[idx], n_repeats=n_repeats,
                                  random_state=random_state, scoring="roc_auc", n_jobs=-1)
    return sorted(zip(feature_cols, perm.importances_mean.tolist()), key=lambda kv: kv[1], reverse=True)


def compute_feature_stats(X: pd.DataFrame, feature_cols: list[str]) -> dict:
    """{feature: {p10, p90, median}} from the training data - the spread a
    live prediction's own values get compared against."""
    return {c: {"p10": float(X[c].quantile(0.1)), "p90": float(X[c].quantile(0.9)),
               "median": float(X[c].median())} for c in feature_cols}


def explain_drivers(features_row: dict, importance_ranking: list, feature_stats: dict,
                    human_label: dict, top_n: int = 3) -> list[str]:
    """This work's own values against the model's own top-ranked features -
    a sentence only for a feature this work sits in an extreme (<=p10 or
    >=p90) percentile for, walking down the ranking until top_n are found."""
    drivers = []
    for rank, (feat, _imp) in enumerate(importance_ranking, start=1):
        if len(drivers) >= top_n:
            break
        v = features_row.get(feat)
        if v is None or (isinstance(v, float) and np.isnan(v)) or feat not in feature_stats:
            continue
        s = feature_stats[feat]
        label = human_label.get(feat, feat)
        if v >= s["p90"]:
            drivers.append(f"{label} is in the top 10% of all works (the model's #{rank} factor)")
        elif v <= s["p10"]:
            drivers.append(f"{label} is in the bottom 10% of all works (the model's #{rank} factor)")
    return drivers
