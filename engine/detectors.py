"""Stage 4: detectors. Pure functions over the lifecycle spine.

11 logical detectors, 13 finding-type IDs (TEMPORAL_IMPOSSIBLE is split into
3 - see docs/SCHEMA.md / plan C3 - to avoid colliding finding_ids when a work
trips more than one sub-check).

Two confidence tiers now fire (see config/detectors.yaml):
- "rule": a deterministic guideline/logic breach (GHOST_ASSET, TEMPORAL_*,
  OVER_ALLOCATION). No judgement call - either the record violates the rule
  or it doesn't.
- "statistical": a peer-relative outlier - the 6 delay detectors (gated on a
  PERCENTILE of their own real population, recomputed every run, not a
  hardcoded guess - see the recalibration note in detectors.yaml) plus
  COST_OUTLIER and DUPLICATE_WORK. These carry a populated `peer_benchmark`
  so the evidence shows what "normal" looked like this run, not just the
  fixed MPLADS guideline.
"""
import yaml
import pandas as pd

from engine.paths import CONFIG_DIR, DATA_PROCESSED

WORK_KEY = ["WORK_RECOMMENDATION_DTL_ID", "SCOPE_HOUSE", "SCOPE_TENURE"]


def load_config() -> dict:
    with open(CONFIG_DIR / "detectors.yaml") as f:
        return yaml.safe_load(f)


def prepare_spine(spine: pd.DataFrame, cfg: dict) -> pd.DataFrame:
    as_of = pd.Timestamp(cfg["as_of_date"])
    # NaT arithmetic -> NaN, and NaN > threshold is False, so every mask below
    # self-excludes rows missing the dates it needs with no special-casing.
    spine["age_since_recommendation"] = (as_of - spine["rec_RECOMMENDATION_DATE"]).dt.days
    spine["age_since_sanction"] = (as_of - spine["SANCTION_DATE"]).dt.days
    spine["sanction_delay_days"] = (spine["SANCTION_DATE"] - spine["rec_RECOMMENDATION_DATE"]).dt.days
    spine["execution_delay_days"] = (spine["comp_ACTUAL_END_DATE"] - spine["SANCTION_DATE"]).dt.days
    return spine


def iso(ts) -> str | None:
    return ts.date().isoformat() if pd.notna(ts) else None


# ---------------------------------------------------------------------------
# Dynamic percentile gating - the core fix for "it flags everything". A fixed
# guideline day-count (e.g. 45 days) is missed by 28-69% of real works in
# this dataset (see docs/SCHEMA.md) - that's the norm here, not a deviation
# from it. Each delay detector instead gates on a percentile of its OWN
# population, recomputed fresh from the current data every run.
# ---------------------------------------------------------------------------
def dynamic_gate(population: pd.Series, c: dict) -> tuple[float, list[dict], dict]:
    """population: the metric column for every row the detector could plausibly
    fire on (before the day-count filter). Returns (gate_value, severity_buckets,
    peer_benchmark) all computed from this run's real data."""
    clean = population.dropna()
    pcts = c["bucket_percentiles"]
    q = clean.quantile([p / 100 for p in pcts])
    gate_value = float(q[pcts[0] / 100])
    sevs = ["low", "medium", "high"]
    # bucket i's edge is q[pcts[i]] itself - e.g. pcts=[90,95,99] means the
    # "low" bucket runs up to p90 (the gate), "medium" up to p95, "high" beyond p99.
    buckets = [{"max_days": float(q[p / 100]) if i < len(pcts) - 1 else None, "severity": sevs[min(i, 2)]}
               for i, p in enumerate(pcts)]
    peer_benchmark = {
        "population_median_days": float(clean.median()) if len(clean) else None,
        "population_p90_days": float(q[0.90]) if 0.90 in q.index else None,
        "n_peers": int(len(clean)),
        "gate_percentile": pcts[0],
    }
    return gate_value, buckets, peer_benchmark


def bucket_severity(value: float, buckets: list[dict]) -> str:
    for b in buckets:
        if b["max_days"] is None or value <= b["max_days"]:
            return b["severity"]
    return buckets[-1]["severity"]


def build_finding(row, detector_id, tag, severity, confidence, financial_exposure,
                   observed, threshold, deviation, stage, peer_benchmark=None) -> dict:
    return {
        "finding_id": f"{detector_id}:{int(row.WORK_RECOMMENDATION_DTL_ID)}:{row.SCOPE_HOUSE}:{row.SCOPE_TENURE}",
        "work_number": str(int(row.WORK_RECOMMENDATION_DTL_ID)),
        "detector": detector_id,
        "tag": tag,
        "severity": severity,
        "confidence": confidence,
        "financial_exposure": float(financial_exposure) if pd.notna(financial_exposure) else 0.0,
        "evidence": {
            "observed": observed,
            "threshold": threshold,
            "peer_benchmark": peer_benchmark,
            "deviation": deviation,
        },
        "entities": {
            "state": row.STATE_NAME if pd.notna(row.STATE_NAME) else None,
            "constituency": row.CONSTITUENCY if pd.notna(row.CONSTITUENCY) else None,
            "constituency_id": int(row.CONSTITUENCY_ID) if pd.notna(row.CONSTITUENCY_ID) else None,
            "district": row.DISTRICT if pd.notna(getattr(row, "DISTRICT", None)) else None,
            "lgd_code": None,
            "mp_name": row.MP_NAME if pd.notna(row.MP_NAME) else None,
            "implementing_agency": row.exp_top_ia if row.has_expenditure and pd.notna(row.exp_top_ia) else None,
            "vendor": row.exp_top_vendor if row.has_expenditure and pd.notna(row.exp_top_vendor) else None,
            "vendor_count": int(row.exp_vendor_count) if row.has_expenditure and pd.notna(row.exp_vendor_count) else 0,
            "scope_house": row.SCOPE_HOUSE,
            "scope_tenure": row.SCOPE_TENURE,
        },
        "suppressed": False,
        "suppression_reason": None,
        "routed_to": None,   # filled by score.py
        "stage": stage,
    }


def _emit(spine: pd.DataFrame, mask: pd.Series, **kwargs_per_row) -> list[dict]:
    """Build one finding per masked row. kwargs_per_row values are either
    constants or callables(row) -> value."""
    findings = []
    for row in spine.loc[mask.fillna(False)].itertuples():
        resolved = {k: (v(row) if callable(v) else v) for k, v in kwargs_per_row.items()}
        findings.append(build_finding(row, **resolved))
    return findings


def _delay_detector(spine, cfg, detector_id, base_mask, metric_col, financial_exposure_fn,
                     stage, extra_observed=None):
    """Shared shape for the 6 percentile-gated delay detectors."""
    c = cfg["detectors"][detector_id]
    population = spine.loc[base_mask, metric_col]
    gate, buckets, peer_benchmark = dynamic_gate(population, c)
    mask = base_mask & (spine[metric_col] > gate)

    def observed(r):
        d = {metric_col: float(getattr(r, metric_col))}
        if extra_observed:
            d.update(extra_observed(r))
        return d

    return _emit(spine, mask,
        detector_id=detector_id, tag=c["tag"], confidence=c["confidence"], stage=stage,
        severity=lambda r: bucket_severity(getattr(r, metric_col), buckets),
        financial_exposure=financial_exposure_fn,
        observed=observed,
        threshold=lambda r: {"guideline_days": c["guideline_days"], "gate_days_this_run": round(gate, 1),
                              "source": c["guideline_source"]},
        peer_benchmark=peer_benchmark,
        deviation=lambda r: (
            f"{getattr(r, metric_col):.0f} days - slower than {c['bucket_percentiles'][0]}% of "
            f"{peer_benchmark['n_peers']:,} comparable works this run (their median is "
            f"{peer_benchmark['population_median_days']:.0f} days; MPLADS guideline is "
            f"{c['guideline_days']} days)"
        ))


def detect_stalled_at_sanction(spine, cfg):
    base_mask = spine.has_recommended & ~spine.has_sanctioned
    return _delay_detector(spine, cfg, "STALLED_AT_SANCTION", base_mask, "age_since_recommendation",
                            lambda r: r.rec_RECOMMENDED_AMOUNT, "sanction")


def detect_sanction_delay(spine, cfg):
    base_mask = spine.has_sanctioned & spine.has_recommended
    return _delay_detector(spine, cfg, "SANCTION_DELAY", base_mask, "sanction_delay_days",
                            lambda r: r.SANCTION_AMOUNT, "sanction")


def detect_stalled_at_execution(spine, cfg):
    base_mask = spine.has_sanctioned & ~spine.has_completed
    return _delay_detector(spine, cfg, "STALLED_AT_EXECUTION", base_mask, "age_since_sanction",
                            lambda r: r.SANCTION_AMOUNT, "execution")


def detect_execution_delay(spine, cfg):
    base_mask = spine.has_completed & spine.has_sanctioned
    return _delay_detector(spine, cfg, "EXECUTION_DELAY", base_mask, "execution_delay_days",
                            lambda r: r.comp_ACTUAL_AMOUNT, "execution")


def detect_paid_not_complete(spine, cfg):
    base_mask = spine.has_expenditure & ~spine.has_completed & spine.has_sanctioned
    return _delay_detector(spine, cfg, "PAID_NOT_COMPLETE", base_mask, "age_since_sanction",
                            lambda r: r.exp_total_disbursed, "payment",
                            extra_observed=lambda r: {"total_disbursed": r.exp_total_disbursed,
                                                       "disbursement_rows": int(r.exp_row_count)})


def detect_stuck_status(spine, cfg):
    c = cfg["detectors"]["STUCK_STATUS"]
    early_stages = c["early_stages"]
    base_mask = spine.WORK_STAGE_RESOLVED.isin(early_stages)
    population = spine.loc[base_mask, "age_since_recommendation"]
    gate, buckets, peer_benchmark = dynamic_gate(population, c)
    mask = base_mask & (spine.age_since_recommendation > gate)
    return _emit(spine, mask,
        detector_id="STUCK_STATUS", tag=c["tag"], confidence=c["confidence"],
        severity=lambda r: bucket_severity(r.age_since_recommendation, buckets),
        stage=lambda r: "sanction" if not r.has_sanctioned else "execution",
        financial_exposure=lambda r: r.SANCTION_AMOUNT if r.has_sanctioned else r.rec_RECOMMENDED_AMOUNT,
        observed=lambda r: {"work_stage": r.WORK_STAGE_RESOLVED, "age_since_recommendation": int(r.age_since_recommendation)},
        threshold=lambda r: {"guideline_days": c["guideline_days"], "gate_days_this_run": round(gate, 1),
                              "early_stages": early_stages, "source": c["guideline_source"]},
        peer_benchmark=peer_benchmark,
        deviation=lambda r: f"parked at '{r.WORK_STAGE_RESOLVED}' for {int(r.age_since_recommendation)} days - "
                             f"slower than {c['bucket_percentiles'][0]}% of {peer_benchmark['n_peers']:,} "
                             f"comparable early-stage works this run")


def detect_temporal_impossible(spine, cfg):
    """3 independent sub-checks, each its own detector_id/finding - a work can
    trip more than one, and bundling them would collide finding_id and blur
    which specific rule was violated. Hard logical constraints - confidence=rule."""
    out = []

    c = cfg["detectors"]["TEMPORAL_SANCTION_BEFORE_RECOMMENDATION"]
    mask = spine.has_sanctioned & spine.has_recommended & (spine.SANCTION_DATE < spine.rec_RECOMMENDATION_DATE)
    out += _emit(spine, mask,
        detector_id="TEMPORAL_SANCTION_BEFORE_RECOMMENDATION", tag=c["tag"], severity=c["severity"],
        confidence=c["confidence"], stage="sanction", financial_exposure=lambda r: r.SANCTION_AMOUNT,
        observed=lambda r: {"sanction_date": iso(r.SANCTION_DATE), "recommendation_date": iso(r.rec_RECOMMENDATION_DATE)},
        threshold=lambda r: {"source": c["guideline_source"]},
        deviation=lambda r: f"sanctioned {iso(r.SANCTION_DATE)} but recommended later, {iso(r.rec_RECOMMENDATION_DATE)}")

    c = cfg["detectors"]["TEMPORAL_COMPLETION_BEFORE_SANCTION"]
    mask = spine.has_completed & spine.has_sanctioned & (spine.comp_ACTUAL_END_DATE < spine.SANCTION_DATE)
    out += _emit(spine, mask,
        detector_id="TEMPORAL_COMPLETION_BEFORE_SANCTION", tag=c["tag"], severity=c["severity"],
        confidence=c["confidence"], stage="execution", financial_exposure=lambda r: r.comp_ACTUAL_AMOUNT,
        observed=lambda r: {"actual_end_date": iso(r.comp_ACTUAL_END_DATE), "sanction_date": iso(r.SANCTION_DATE)},
        threshold=lambda r: {"source": c["guideline_source"]},
        deviation=lambda r: f"completed {iso(r.comp_ACTUAL_END_DATE)} but sanctioned later, {iso(r.SANCTION_DATE)}")

    c = cfg["detectors"]["TEMPORAL_PAYMENT_BEFORE_SANCTION"]
    mask = spine.has_expenditure & spine.has_sanctioned & (spine.exp_first_date < spine.SANCTION_DATE)
    out += _emit(spine, mask,
        detector_id="TEMPORAL_PAYMENT_BEFORE_SANCTION", tag=c["tag"], severity=c["severity"],
        confidence=c["confidence"], stage="payment", financial_exposure=lambda r: r.exp_total_disbursed,
        observed=lambda r: {"first_expenditure_date": iso(r.exp_first_date), "sanction_date": iso(r.SANCTION_DATE)},
        threshold=lambda r: {"source": c["guideline_source"]},
        deviation=lambda r: f"first disbursement {iso(r.exp_first_date)} but sanctioned later, {iso(r.SANCTION_DATE)}")

    return out


def detect_ghost_asset(spine, cfg):
    c = cfg["detectors"]["GHOST_ASSET"]
    mask = spine.has_completed & spine.has_expenditure & spine.exp_any_success & spine.comp_ATTACH_ID.isna()
    return _emit(spine, mask,
        detector_id="GHOST_ASSET", tag=c["tag"], severity=c["severity"], confidence=c["confidence"], stage="payment",
        financial_exposure=lambda r: r.exp_total_disbursed,
        observed=lambda r: {"completed": True, "actual_end_date": iso(r.comp_ACTUAL_END_DATE),
                             "actual_amount": r.comp_ACTUAL_AMOUNT, "total_disbursed": r.exp_total_disbursed,
                             "disbursement_rows": int(r.exp_row_count), "file_attached": False},
        threshold=lambda r: {"guideline_days": None, "source": c["guideline_source"]},
        deviation=lambda r: f"work marked complete with ₹{r.exp_total_disbursed:,.0f} paid across "
                             f"{int(r.exp_row_count)} disbursement(s), no supporting file attached to the completion record")


def detect_over_allocation(spine, cfg):
    """MP-level aggregate check: sum(RECOMMENDED_AMOUNT) vs ALLOCATED_AMT,
    matched by CONSTITUENCY (one MP per Lok Sabha seat) + SCOPE_TENURE.
    Lok Sabha only - this project doesn't cover Rajya Sabha (see
    engine/ingest.py, filtered before the spine is even built).
    Flags the single largest work per over-allocated MP as the representative
    finding - not every one of their works - so the finding count reflects
    "how many MPs are over," not "how many works that MP happens to have."
    """
    from engine.paths import DATA_INTERIM
    c = cfg["detectors"]["OVER_ALLOCATION"]
    allocated = pd.read_parquet(DATA_INTERIM / "allocated.parquet")

    rec = spine[spine.has_recommended].copy()
    totals = rec.groupby(["CONSTITUENCY", "SCOPE_TENURE"])["rec_RECOMMENDED_AMOUNT"].sum()
    alloc = allocated.groupby(["CONSTITUENCY", "SCOPE_TENURE"])["ALLOCATED_AMT"].sum()

    merged = pd.concat([totals.rename("total_recommended"), alloc.rename("allocated_amt")], axis=1).dropna()
    over = merged[merged.total_recommended > merged.allocated_amt]

    findings = []
    for key, row in over.iterrows():
        candidates = rec[(rec["CONSTITUENCY"] == key[0]) & (rec["SCOPE_TENURE"] == key[1])]
        if candidates.empty:
            continue
        top = candidates.loc[candidates.rec_RECOMMENDED_AMOUNT.idxmax()]
        overage = row.total_recommended - row.allocated_amt
        findings.append(build_finding(
            top, detector_id="OVER_ALLOCATION", tag=c["tag"], severity=c["severity"], confidence=c["confidence"],
            financial_exposure=overage, stage="recommendation",
            observed={"total_recommended": float(row.total_recommended), "allocated_amt": float(row.allocated_amt),
                      "overage": float(overage), "works_counted": int(len(candidates))},
            threshold={"source": c["guideline_source"]},
            deviation=f"₹{row.total_recommended:,.0f} recommended against a ₹{row.allocated_amt:,.0f} "
                      f"allocation - ₹{overage:,.0f} over limit across {len(candidates)} recommended work(s)",
        ))
    return findings


def detect_statutory_sc_st_deficit(spine, cfg):
    """MP-level statutory compliance check: MPLADS Guideline Rule 2.5 mandates
    at least 15% of annual funds for Scheduled Caste (SC) areas and 7.5% for
    Scheduled Tribe (ST) areas.
    Identifies SC/ST targeted works via:
    1. Constituency reservation suffix: '(SC)' or '(ST)'
    2. Description and activity keyword matches (e.g. 'SC', 'ST', 'SCHEDULED CASTE',
       'SCHEDULED TRIBE', 'TRIBAL', 'BASTI', 'ADIVASI', 'ASHRAM SHALA', 'AMBEDKAR').
    Evaluates MPs whose total portfolio recommendations exceed min_evaluated_amount.
    Flags the MP's single largest non-SC/ST work with the shortfall amount as exposure.
    """
    c = cfg["detectors"].get("STATUTORY_SC_ST_DEFICIT")
    if not c:
        return []

    min_amt = c.get("min_evaluated_amount", 20000000)
    sc_target = c.get("sc_target_pct", 15.0)
    st_target = c.get("st_target_pct", 7.5)

    rec = spine[spine.has_recommended & spine["rec_RECOMMENDED_AMOUNT"].notna()].copy()
    if rec.empty:
        return []

    # Detect SC and ST designation
    constituency_upper = rec["CONSTITUENCY"].astype(str).str.upper()
    is_sc_seat = constituency_upper.str.endswith("(SC)")
    is_st_seat = constituency_upper.str.endswith("(ST)")

    desc_upper = (rec["rec_WORK_DESCRIPTION"].fillna("").astype(str) + " " +
                  rec["rec_ACTIVITY_NAME_CLEAN"].fillna("").astype(str)).str.upper()

    sc_pattern = r'\b(SC|SCHEDULED CASTE|HARIJAN|VALMIKI|AMBEDKAR|DALIT)\b'
    st_pattern = r'\b(ST|SCHEDULED TRIBE|TRIBAL|ADIVASI|GIRIDHAR|ASHRAM SHALA)\b'

    has_sc_keywords = desc_upper.str.contains(sc_pattern, regex=True)
    has_st_keywords = desc_upper.str.contains(st_pattern, regex=True)

    rec["is_sc"] = is_sc_seat | (has_sc_keywords & ~is_st_seat)
    rec["is_st"] = is_st_seat | (has_st_keywords & ~is_sc_seat)

    # Calculate MP portfolio sums per tenure
    mp_groups = rec.groupby(["MP_NAME", "SCOPE_TENURE"])
    findings = []

    for (mp_name, tenure), grp in mp_groups:
        total_amt = grp["rec_RECOMMENDED_AMOUNT"].sum()
        if total_amt < min_amt:
            continue

        sc_amt = grp.loc[grp["is_sc"], "rec_RECOMMENDED_AMOUNT"].sum()
        st_amt = grp.loc[grp["is_st"], "rec_RECOMMENDED_AMOUNT"].sum()

        sc_pct = (sc_amt / total_amt) * 100.0 if total_amt else 0.0
        st_pct = (st_amt / total_amt) * 100.0 if total_amt else 0.0

        sc_deficit = max(0.0, (sc_target - sc_pct) * total_amt / 100.0)
        st_deficit = max(0.0, (st_target - st_pct) * total_amt / 100.0)
        total_shortfall = sc_deficit + st_deficit

        # Flag if either SC < 15% or ST < 7.5% with significant deficit (> ₹10L)
        if (sc_pct < sc_target or st_pct < st_target) and total_shortfall >= 1000000:
            rep_work = grp.loc[grp["rec_RECOMMENDED_AMOUNT"].idxmax()]
            findings.append(build_finding(
                rep_work,
                detector_id="STATUTORY_SC_ST_DEFICIT",
                tag=c["tag"],
                severity=c["severity"],
                confidence=c["confidence"],
                financial_exposure=total_shortfall,
                stage="recommendation",
                observed={
                    "total_recommended": float(total_amt),
                    "sc_amount": float(sc_amt),
                    "sc_percentage": round(float(sc_pct), 2),
                    "st_amount": float(st_amt),
                    "st_percentage": round(float(st_pct), 2),
                    "sc_shortfall": float(sc_deficit),
                    "st_shortfall": float(st_deficit),
                    "total_shortfall": float(total_shortfall),
                },
                threshold={
                    "sc_target_pct": sc_target,
                    "st_target_pct": st_target,
                    "source": c["guideline_source"],
                },
                deviation=(
                    f"MP portfolio allocated {sc_pct:.1f}% to SC (target 15%) and {st_pct:.1f}% to ST (target 7.5%) "
                    f"out of ₹{total_amt:,.0f} recommended — ₹{total_shortfall:,.0f} cumulative quota shortfall"
                ),
            ))

    return findings


def modified_z_scores(values: pd.Series) -> pd.Series:
    median = values.median()
    mad = (values - median).abs().median()
    if mad == 0:
        return pd.Series(0.0, index=values.index)
    return 0.6745 * (values - median) / mad


def detect_cost_outlier(spine, cfg):
    """Robust (median+MAD) modified z-score of SANCTION_AMOUNT within peer
    groups of (cleaned activity type, state). n>=min_peers required per group
    or the group is skipped entirely - not enough peers to judge "unusual"."""
    c = cfg["detectors"]["COST_OUTLIER"]
    base = spine[spine.has_sanctioned].copy()
    activity_col = "san_ACTIVITY_NAME_CLEAN" if "san_ACTIVITY_NAME_CLEAN" in base.columns else "rec_ACTIVITY_NAME_CLEAN"
    # itertuples() can't expose leading-underscore column names as attributes
    # (pandas reserves that shape for its own positional fallback names) -
    # peer_key/zscore, not _peer_key/_z.
    base["peer_key"] = list(zip(base[activity_col], base["STATE_NAME"]))

    group_sizes = base.groupby("peer_key")["SANCTION_AMOUNT"].transform("size")
    eligible = base[group_sizes >= c["min_peers"]].copy()
    eligible["zscore"] = eligible.groupby("peer_key")["SANCTION_AMOUNT"].transform(modified_z_scores)

    threshold = c["modified_z_threshold"]
    # positive-only: the problem statement's concern is cost OVERRUNS. An
    # unusually cheap work is a different (weaker, differently-actionable)
    # signal than one that costs far more than its peers - conflating them
    # under "cost outlier" also doubled the flag count for no clear benefit.
    hits = eligible[eligible.zscore > threshold]

    sev_edges = c["severity_z"]

    def sev(z):
        if z <= sev_edges[0]: return "low"
        if z <= sev_edges[1]: return "medium"
        return "high"

    findings = []
    for row in hits.itertuples():
        peer_key = row.peer_key
        peer_group = eligible[eligible.peer_key == peer_key]["SANCTION_AMOUNT"]
        findings.append(build_finding(
            row, detector_id="COST_OUTLIER", tag=c["tag"], severity=sev(row.zscore), confidence=c["confidence"],
            financial_exposure=row.SANCTION_AMOUNT, stage="sanction",
            observed={"sanction_amount": row.SANCTION_AMOUNT, "modified_z_score": round(float(row.zscore), 2)},
            threshold={"modified_z_threshold": threshold, "min_peers": c["min_peers"], "source": c["guideline_source"]},
            peer_benchmark={"peer_activity": peer_key[0], "peer_state": peer_key[1],
                            "n_peers": int(len(peer_group)), "peer_median_amount": float(peer_group.median()),
                            "peer_mad": float((peer_group - peer_group.median()).abs().median())},
            deviation=f"₹{row.SANCTION_AMOUNT:,.0f} is {abs(row.zscore):.1f}x the typical spread for "
                      f"'{peer_key[0]}' works in {peer_key[1]} (peer median ₹{peer_group.median():,.0f}, "
                      f"{len(peer_group)} peers)",
        ))
    return findings


def detect_duplicate_work(spine, cfg):
    """Exact-match on normalised WORK_DESCRIPTION within (constituency, cleaned
    activity), confined to SMALL groups only.

    Went through two rejected designs before this one - hand-checking real
    hits at every step, per the brief's own instruction, is what caught both:
    fuzzy similarity (even at 95%+) mostly matched an MP legitimately
    recommending the same *type* of work at different real villages using a
    shared template - the place name is a small fraction of a long templated
    sentence, so even a real location difference barely moves a similarity
    score. Switching to an EXACT text match removed that failure mode, but
    exposed a second one: normal BULK PROCUREMENT (e.g. 22 identical benches
    bought in one order, each getting its own work entry) is *supposed* to
    produce many rows with identical descriptions - that's correct system
    usage, not duplication. The signal that actually discriminates a likely
    accidental double-entry from either legitimate pattern is group size: a
    real duplicate is a pair (or a small handful), not a large batch. Capping
    the group size at `max_group_size` is what makes this detector fire on
    small, specific matches instead of routine bulk orders - verified this
    drops the flag count by 92% (40,650 -> ~3,000) while the surviving hits
    read as genuinely worth a side-by-side look (see docs/SCHEMA.md).
    """
    c = cfg["detectors"]["DUPLICATE_WORK"]
    min_len = c["min_description_length"]
    max_group_size = c["max_group_size"]
    activity_col = "rec_ACTIVITY_NAME_CLEAN"

    base = spine[spine.has_recommended & spine.rec_WORK_DESCRIPTION.notna()].copy()
    norm = (base.rec_WORK_DESCRIPTION.astype(str).str.strip().str.casefold()
            .str.replace(r"\s+", " ", regex=True))
    long_enough = norm.str.len() >= min_len
    not_just_category = norm != base[activity_col].astype(str).str.casefold()
    base = base[long_enough & not_just_category].copy()
    base["_norm_desc"] = norm[long_enough & not_just_category]
    base["_block"] = list(zip(base["CONSTITUENCY_ID"], base[activity_col], base["_norm_desc"]))

    group_sizes = base.groupby("_block")["_norm_desc"].transform("size")
    hits = base[(group_sizes >= 2) & (group_sizes <= max_group_size)]
    if hits.empty:
        return []

    findings = []
    for _block, grp in hits.groupby("_block"):
        work_numbers = grp.WORK_RECOMMENDATION_DTL_ID.astype("int64").astype(str).tolist()
        for row in grp.itertuples():
            others = [w for w in work_numbers if w != str(int(row.WORK_RECOMMENDATION_DTL_ID))]
            findings.append(build_finding(
                row, detector_id="DUPLICATE_WORK", tag=c["tag"],
                severity="high" if len(others) == 1 else "medium",   # a pair is a sharper signal than a small cluster
                confidence=c["confidence"], financial_exposure=row.rec_RECOMMENDED_AMOUNT, stage="recommendation",
                observed={"matched_work_count": len(others), "matched_works": others,
                          "recommended_amount": row.rec_RECOMMENDED_AMOUNT},
                threshold={"min_description_length": min_len, "max_group_size": max_group_size,
                           "source": c["guideline_source"]},
                deviation=f"identical description to work #{others[0]}"
                          + (f" and {len(others)-1} other work(s)" if len(others) > 1 else "")
                          + " in the same constituency and activity category",
            ))
    return findings


DETECTORS = [
    detect_stalled_at_sanction, detect_sanction_delay, detect_stalled_at_execution,
    detect_execution_delay, detect_temporal_impossible, detect_ghost_asset,
    detect_paid_not_complete, detect_stuck_status, detect_over_allocation,
    detect_statutory_sc_st_deficit, detect_cost_outlier, detect_duplicate_work,
]


def run() -> list[dict]:
    spine = pd.read_parquet(DATA_PROCESSED / "spine.parquet")
    cfg = load_config()
    spine = prepare_spine(spine, cfg)

    findings = []
    for fn in DETECTORS:
        f = fn(spine, cfg)
        findings += f
        by_detector = {}
        for finding in f:
            by_detector.setdefault(finding["detector"], 0)
            by_detector[finding["detector"]] += 1
        for det, n in sorted(by_detector.items()):
            print(f"  {det:42} {n:>8,}")

    print(f"\n  total findings: {len(findings):,}")
    return findings


def demo():
    findings = run()

    required_top = {"finding_id", "work_number", "detector", "tag", "severity", "confidence",
                     "financial_exposure", "evidence", "entities", "suppressed",
                     "suppression_reason", "routed_to", "stage"}
    required_entities = {"state", "constituency", "constituency_id", "district", "lgd_code",
                          "mp_name", "implementing_agency", "vendor", "vendor_count",
                          "scope_house", "scope_tenure"}

    ghost_caveat_seen = False
    by_detector_scope: dict[tuple[str, str], int] = {}
    by_confidence: dict[str, int] = {}
    for f in findings:
        assert required_top <= f.keys(), f"finding missing keys: {required_top - f.keys()}"
        assert required_entities <= f["entities"].keys(), "entities missing keys"
        assert f["severity"] in ("low", "medium", "high"), f"bad severity {f['severity']}"
        assert f["confidence"] in ("rule", "statistical", "llm"), f"bad confidence {f['confidence']}"
        assert pd.notna(f["financial_exposure"]), "financial_exposure is NaN"
        assert f["entities"]["constituency_id"] is not None, (
            f"null constituency_id on {f['finding_id']} - every work in the spine "
            f"should resolve one (see link.py's coalesce), this should never happen"
        )
        if f["detector"] == "GHOST_ASSET":
            if "not verified to be photographic" in f["evidence"]["threshold"]["source"]:
                ghost_caveat_seen = True
        key = (f["detector"], f["entities"]["scope_tenure"])
        by_detector_scope[key] = by_detector_scope.get(key, 0) + 1
        by_confidence[f["confidence"]] = by_confidence.get(f["confidence"], 0) + 1

    assert ghost_caveat_seen or not any(f["detector"] == "GHOST_ASSET" for f in findings), \
        "GHOST_ASSET caveat text did not survive into evidence.threshold.source"

    print("\n  by confidence tier:", by_confidence)
    print("\n  per-detector counts by SCOPE_TENURE:")
    for (det, tenure), n in sorted(by_detector_scope.items()):
        print(f"    {det:42} {tenure:16} {n:>8,}")

    distinct_works = len({(f["work_number"], f["entities"]["scope_house"], f["entities"]["scope_tenure"]) for f in findings})
    spine_n = len(pd.read_parquet(DATA_PROCESSED / "spine.parquet"))
    print(f"\n  distinct flagged works: {distinct_works:,} / {spine_n:,} = {distinct_works/spine_n*100:.1f}% breach rate")

    print(f"\ndetectors self-check: PASS  ({len(findings):,} total findings, all required keys present)")


if __name__ == "__main__":
    demo()
