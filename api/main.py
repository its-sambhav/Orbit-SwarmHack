"""Read-only API over the precomputed MPLADS engine outputs.

    uvicorn api.main:app --reload --port 8000

Nothing here computes a detector or re-runs the pipeline - every route
reads findings/work_risk/constituency_risk/spine that engine/run_pipeline.py
already produced. The one exception, /api/narrative, calls Claude to format
(never generate) reasoning already present in a finding's evidence - see
api/narrative.py for the validator that enforces this.
"""
import base64
import json
import math
import re

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from api.data import get_store, SCOPES, SCOPE_LABELS, GEO_DIR
from api.narrative import generate_narrative
from api import reports as reports_store
from engine import rollup

app = FastAPI(title="MPLADS Anomaly Review API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # prototype - single local demo, not multi-tenant
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static/geo", StaticFiles(directory=str(GEO_DIR)), name="geo")


def clean(obj):
    """Recursively swap NaN/NaT/numpy scalars for JSON-safe plain Python values."""
    if isinstance(obj, dict):
        return {k: clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, np.ndarray)):
        return [clean(v) for v in obj]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        return None if math.isnan(obj) else float(obj)
    if isinstance(obj, pd.Timestamp):
        return None if pd.isna(obj) else obj.date().isoformat()
    if isinstance(obj, float) and math.isnan(obj):
        return None
    if obj is pd.NaT:
        return None
    return obj


def stage_counts(sp: pd.DataFrame) -> dict:
    """Ongoing/pending-approval/pending-payment counts from the same real
    has_recommended/has_sanctioned/has_completed/exp_total_disbursed spine
    booleans the funnel already uses - not a fabricated status enum. Shared
    by the State/District dashboards' KPI cards."""
    return {
        "ongoing": int((sp["has_sanctioned"] & ~sp["has_completed"]).sum()),
        "pending_approvals": int((sp["has_recommended"] & ~sp["has_sanctioned"]).sum()),
        "pending_payments": int((sp["has_sanctioned"] & (sp["exp_total_disbursed"] == 0)).sum()),
    }


def delayed_count(findings_slice: pd.DataFrame) -> int:
    """Distinct works carrying the TIME DELAY tag within an already-scoped
    findings slice - the real, already-computed delay signal (see
    config/detectors.yaml's 6 time-delay detectors), not a second invented
    delay definition."""
    return int(findings_slice.loc[findings_slice["tag"] == "TIME DELAY", "work_number"].nunique())


@app.get("/api/meta")
def get_meta():
    s = get_store()
    in_scope_spine = s.spine[s.spine["SCOPE_TENURE"].isin(s.demo_scopes)]
    in_scope_flagged = s.work_risk[s.work_risk["in_demo_scope"]]
    return clean({
        "as_of_date": s.cfg["as_of_date"],
        "scopes": [{"value": v, "label": SCOPE_LABELS[v]} for v in SCOPES],
        "demo_scopes": s.demo_scopes,
        "tags": sorted(s.findings["tag"].unique().tolist()),
        "severities": ["low", "medium", "high"],
        "stages": sorted(s.findings["stage"].unique().tolist()),
        "detectors": sorted(s.findings["detector"].unique().tolist()),
        "national": {
            "total_works": len(s.spine),
            "total_findings": len(s.findings),
            "flagged_works": len(s.work_risk),
            "total_states": int(in_scope_spine["STATE_NAME"].nunique()),
            "breach_rate_all_scope": round(len(s.work_risk) / len(s.spine) * 100, 1),
            "breach_rate_in_scope": round(len(in_scope_flagged) / len(in_scope_spine) * 100, 1),
            "queue_size": min(s.cfg["queue"]["max_queue_size"],
                               int((in_scope_flagged["total_exposure"] >= s.cfg["queue"]["materiality_floor"]).sum())),
            "materiality_floor": s.cfg["queue"]["materiality_floor"],
        },
        # bounds for the date-range filter (Overview + Map's India/State/
        # District views) - recommendation date, the one date field present
        # on essentially every work, see Store.__init__.
        "date_min": s.date_min, "date_max": s.date_max,
    })


@app.get("/api/funnel")
def get_funnel(scope: str = Query("all"), date_from: str | None = None, date_to: str | None = None):
    s = get_store()
    sp, wr, *_ = s.risk_tables(scope, date_from, date_to)
    # total_amount = best-known value per work (sanctioned amount once sanctioned,
    # else the original recommended amount) - not a sum of every stage, which would
    # multi-count a single work's money across recommended+sanctioned+completed.
    total_amount = sp["SANCTION_AMOUNT"].fillna(sp["rec_RECOMMENDED_AMOUNT"]).sum()
    # allocation is a lifetime-per-MP figure, not tied to any one work's
    # recommendation date - never narrowed by the date filter.
    alloc = s.allocated if scope == "all" else s.allocated[s.allocated["SCOPE_TENURE"] == scope]
    completion_rate = float(sp["has_completed"].sum() / sp["has_sanctioned"].sum() * 100) if sp["has_sanctioned"].sum() else None
    works_flagged = len(wr)
    # distinct works whose worst finding is high-severity (not a raw finding
    # count, which would multi-count a work with more than one high finding).
    high_risk = wr[wr["max_severity"] == "high"]
    return clean({
        "scope": scope, "date_from": date_from, "date_to": date_to,
        "total_works": len(sp),
        "total_amount": float(total_amount),
        "allocated": float(alloc["ALLOCATED_AMT"].sum()),
        "works_flagged": works_flagged,
        "breach_rate": round(works_flagged / len(sp), 4) if len(sp) else None,
        "recommended": int(sp["has_recommended"].sum()),
        "recommended_amount": float(sp.loc[sp["has_recommended"], "rec_RECOMMENDED_AMOUNT"].sum()),
        "sanctioned": int(sp["has_sanctioned"].sum()),
        "sanctioned_amount": float(sp.loc[sp["has_sanctioned"], "SANCTION_AMOUNT"].sum()),
        "completed": int(sp["has_completed"].sum()),
        "completed_amount": float(sp.loc[sp["has_completed"], "comp_ACTUAL_AMOUNT"].sum()),
        "paid": float(sp["exp_total_disbursed"].sum()),
        "paid_count": int(sp["has_expenditure"].sum()),
        "high_risk_count": int(len(high_risk)),
        "high_risk_amount": float(high_risk["total_exposure"].sum()),
        "completion_rate": completion_rate,
        "never_sanctioned": int((sp["has_recommended"] & ~sp["has_sanctioned"]).sum()),
        "sanctioned_never_completed": int((sp["has_sanctioned"] & ~sp["has_completed"]).sum()),
    })


@app.get("/api/analytics")
def get_analytics(scope: str = Query("18th Lok Sabha"), date_from: str | None = None, date_to: str | None = None):
    """Aggregate finding counts for the MoSPI landing page's analytics charts -
    severity/tag/stage distributions plus the top states by risk. Every number
    is a live groupby over the in-memory findings/state_risk tables, nothing
    precomputed or hardcoded per scope."""
    s = get_store()
    f = s.findings_for_scope(scope)
    if date_from:
        f = f[f["date"] >= pd.Timestamp(date_from)]
    if date_to:
        f = f[f["date"] <= pd.Timestamp(date_to)]
    _, _, sr, _, _ = s.risk_tables(scope, date_from, date_to)
    sr = sr.sort_values("risk_score", ascending=False).head(5)
    return clean({
        "scope": scope, "date_from": date_from, "date_to": date_to,
        "severity_counts": {k: int(v) for k, v in f["severity"].value_counts().items()},
        "tag_counts": {k: int(v) for k, v in f["tag"].value_counts().items()},
        "stage_counts": {k: int(v) for k, v in f["stage"].value_counts().items()},
        "top_states": [{
            "state": r["state"], "works_flagged": int(r["works_flagged"]),
            "breach_rate": round(float(r["breach_rate"]), 4),
            "risk_score": round(float(r["risk_score"]), 2),
        } for _, r in sr.iterrows()],
    })


@app.get("/api/constituencies")
def get_constituencies(scope: str = Query("all")):
    s = get_store()
    cr = s.constituency_risk_for_scope(scope)
    out = []
    for _, row in cr.iterrows():
        cid = str(int(row["CONSTITUENCY_ID"]))
        out.append({
            "constituency_id": cid,
            "pc_id": s.crosswalk.get(cid),
            "constituency": row["constituency"],
            "state": row["state"],
            "works_total": int(row["works_total"]),
            "works_flagged": int(row["works_flagged"]),
            "breach_rate": round(float(row["breach_rate"]), 4),
            "total_exposure": float(row["total_exposure"]),
            "risk_score": round(float(row["risk_score"]), 2),
            "tag_counts": json.loads(row["tag_counts"]) if row["tag_counts"] else {},
        })
    matched = sum(1 for r in out if r["pc_id"] is not None)
    return clean({
        "scope": scope, "count": len(out),
        "geo_matched": matched, "geo_unmatched": len(out) - matched,
        "items": out,
    })


@app.get("/api/queue")
def get_queue(
    scope: str = Query("all"),
    tag: str | None = None,
    severity: str | None = None,
    state: str | None = None,
    stage: str | None = None,
    min_amount: float | None = None,
    max_amount: float | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int = 50,
    offset: int = 0,
):
    s = get_store()
    wr = s.work_risk if scope == "all" else s.work_risk[s.work_risk["scope_tenure"] == scope]
    if date_from:
        wr = wr[wr["date"] >= pd.Timestamp(date_from)]
    if date_to:
        wr = wr[wr["date"] <= pd.Timestamp(date_to)]

    if tag:
        wr = wr[wr["tags"].apply(lambda t: tag in t)]
    if severity:
        wr = wr[wr["max_severity"] == severity]
    if state:
        wr = wr[wr["STATE_NAME"].str.casefold() == state.casefold()]
    if min_amount is not None:
        wr = wr[wr["total_exposure"] >= min_amount]
    if max_amount is not None:
        wr = wr[wr["total_exposure"] <= max_amount]
    if stage:
        stage_works = set(s.findings.loc[s.findings["stage"] == stage, "work_number"])
        wr = wr[wr["work_number"].isin(stage_works)]

    wr = wr.sort_values("priority", ascending=False)
    total = len(wr)
    page = wr.iloc[offset:offset + limit]

    # primary routed_to per work = the routed_to of its highest-priority finding
    top_finding = (s.findings.sort_values("priority_score", ascending=False)
                   .drop_duplicates(subset=["work_number", "scope_house", "scope_tenure"]))
    routed = top_finding.set_index(["work_number", "scope_house", "scope_tenure"])["routed_to"]

    items = []
    for _, row in page.iterrows():
        key = (row["work_number"], row["scope_house"], row["scope_tenure"])
        items.append({
            "work_number": row["work_number"], "scope_house": row["scope_house"],
            "scope_tenure": row["scope_tenure"], "constituency": row["CONSTITUENCY"],
            "state": row["STATE_NAME"], "mp_name": row["MP_NAME"],
            "tags": list(row["tags"]), "max_severity": row["max_severity"],
            "finding_count": int(row["finding_count"]), "total_exposure": float(row["total_exposure"]),
            "priority": round(float(row["priority"]), 2),
            "routed_to": routed.get(key, None),
        })
    return clean({"scope": scope, "total": total, "offset": offset, "limit": limit, "items": items})


@app.get("/api/work/{work_number}")
def get_work(work_number: str, scope_house: str, scope_tenure: str):
    s = get_store()
    work = s.work(work_number, scope_house, scope_tenure)
    if work is None:
        raise HTTPException(404, f"no work {work_number} in {scope_house}/{scope_tenure}")
    findings = s.findings_for_work(work_number, scope_house, scope_tenure)

    # named authority per stage - a real, distinct entity at each one, not the
    # same name repeated. IA_NAME_CLEAN (engine/link.py's exp_top_ia) is the
    # specific engineering office that executed the work, carried in from the
    # expenditure table's largest disbursement row - genuinely different from
    # both the district IDA that sanctioned it and the vendor that got paid.
    lifecycle = {
        "recommended": {"date": work.get("rec_RECOMMENDATION_DATE"), "amount": work.get("rec_RECOMMENDED_AMOUNT"),
                         "authority": work.get("MP_NAME"), "authority_role": "Member of Parliament"},
        "sanctioned": {"date": work.get("SANCTION_DATE"), "amount": work.get("SANCTION_AMOUNT"),
                        "authority": work.get("IDA_NAME_CLEAN"), "authority_role": "District IDA"},
        "completed": {"date": work.get("comp_ACTUAL_END_DATE"), "amount": work.get("comp_ACTUAL_AMOUNT"),
                       "authority": work.get("exp_top_ia"), "authority_role": "Implementing agency"},
        "payment": {"first_date": work.get("exp_first_date"), "last_date": work.get("exp_last_date"),
                    "total_disbursed": work.get("exp_total_disbursed"),
                    "disbursement_rows": work.get("exp_row_count"),
                    "authority": work.get("exp_top_vendor"), "authority_role": "Vendor",
                    "vendor_count": work.get("exp_vendor_count")},
    }
    return clean({
        "work_number": work_number, "scope_house": scope_house, "scope_tenure": scope_tenure,
        "state": work.get("STATE_NAME"), "constituency": work.get("CONSTITUENCY"),
        "district": work.get("DISTRICT"),
        "constituency_id": work.get("CONSTITUENCY_ID"), "mp_name": work.get("MP_NAME"),
        "work_stage": work.get("WORK_STAGE_RESOLVED"),
        "has_recommended": work.get("has_recommended"), "has_sanctioned": work.get("has_sanctioned"),
        "has_completed": work.get("has_completed"), "has_expenditure": work.get("has_expenditure"),
        "lifecycle": lifecycle,
        "findings": findings,
    })


@app.post("/api/narrative")
def post_narrative(work_number: str, scope_house: str, scope_tenure: str, finding_id: str):
    s = get_store()
    findings = s.findings_for_work(work_number, scope_house, scope_tenure)
    finding = next((f for f in findings if f["finding_id"] == finding_id), None)
    if finding is None:
        raise HTTPException(404, f"no finding {finding_id} on that work")
    result = generate_narrative(finding)
    return clean(result)


@app.get("/api/constituency/{constituency_id}")
def get_constituency(constituency_id: str, scope: str = Query("18th Lok Sabha"), date_from: str | None = None, date_to: str | None = None):
    s = get_store()
    spine, wr_all, _, _, cr = s.risk_tables(scope, date_from, date_to)
    row = cr[cr["CONSTITUENCY_ID"].astype("Int64").astype(str) == constituency_id]
    if row.empty:
        raise HTTPException(404, f"no constituency {constituency_id} in scope {scope}")
    row = row.iloc[0]

    sp = spine[spine["CONSTITUENCY_ID"].astype("Int64").astype(str) == constituency_id]
    completion_rate = float(sp["has_completed"].sum() / sp["has_sanctioned"].sum() * 100) if sp["has_sanctioned"].sum() else None

    # national/state comparisons over the same scope+date slice, before narrowing to this seat.
    national_completion = float(spine["has_completed"].sum() / spine["has_sanctioned"].sum() * 100) if spine["has_sanctioned"].sum() else None
    state_sp = spine[spine["STATE_NAME"] == row["state"]]
    state_completion = float(state_sp["has_completed"].sum() / state_sp["has_sanctioned"].sum() * 100) if state_sp["has_sanctioned"].sum() else None

    # allocation is a lifetime-per-MP figure, not tied to any one work's
    # recommendation date - never narrowed by the date filter.
    alloc = s.allocated[(s.allocated["CONSTITUENCY"].str.casefold() == str(row["constituency"]).casefold())
                         & (s.allocated["SCOPE_TENURE"] == scope)]
    allocated_amt = float(alloc["ALLOCATED_AMT"].sum()) if not alloc.empty else None

    findings = s.findings_for_scope(scope)
    findings = findings[findings["constituency_id"].astype("Int64").astype(str) == constituency_id]
    if date_from:
        findings = findings[findings["date"] >= pd.Timestamp(date_from)]
    if date_to:
        findings = findings[findings["date"] <= pd.Timestamp(date_to)]
    tag_breakdown = findings["tag"].value_counts().to_dict()

    mp_names = sp["MP_NAME"].dropna().unique().tolist()
    mp_name = mp_names[0] if mp_names else None

    wr = wr_all[wr_all["CONSTITUENCY_ID"].astype("Int64").astype(str) == constituency_id].sort_values("priority", ascending=False)
    ranked = [{
        "work_number": r["work_number"], "scope_house": r["scope_house"], "scope_tenure": r["scope_tenure"],
        "tags": list(r["tags"]), "max_severity": r["max_severity"], "total_exposure": float(r["total_exposure"]),
        "priority": round(float(r["priority"]), 2),
    } for _, r in wr.iterrows()]

    return clean({
        "constituency_id": constituency_id, "constituency": row["constituency"], "state": row["state"],
        "mp_name": mp_name, "scope": scope, "date_from": date_from, "date_to": date_to,
        "pc_id": s.crosswalk.get(constituency_id),
        "scorecard": {
            "allocated": allocated_amt,
            "recommended": float(sp["rec_RECOMMENDED_AMOUNT"].sum()),
            "sanctioned": float(sp["SANCTION_AMOUNT"].sum()),
            "completed": float(sp["comp_ACTUAL_AMOUNT"].sum()),
            "paid": float(sp["exp_total_disbursed"].sum()),
            "recommended_count": int(sp["has_recommended"].sum()), "sanctioned_count": int(sp["has_sanctioned"].sum()),
            "completed_count": int(sp["has_completed"].sum()), "paid_count": int(sp["has_expenditure"].sum()),
            "high_risk_count": int((wr["max_severity"] == "high").sum()),
            "high_risk_amount": float(wr.loc[wr["max_severity"] == "high", "total_exposure"].sum()),
            "works_total": int(row["works_total"]), "works_flagged": int(row["works_flagged"]),
            "breach_rate": round(float(row["breach_rate"]), 4),
            "completion_rate": completion_rate,
            "national_median_completion_rate": national_completion,
            "state_median_completion_rate": state_completion,
        },
        "tag_breakdown": tag_breakdown,
        "findings": ranked,
    })


@app.get("/api/states")
def get_states(scope: str = Query("all"), date_from: str | None = None, date_to: str | None = None):
    """State Nodal Authority role picker + the state-breakdown table on the
    MoSPI dashboard. Covers all 4 scopes uniformly (STATE_NAME is populated
    regardless of house, unlike CONSTITUENCY - see docs/SCHEMA.md)."""
    s = get_store()
    _, _, sr, _, _ = s.risk_tables(scope, date_from, date_to)
    sr = sr.sort_values("risk_score", ascending=False)
    items = [{
        "state": r["state"], "districts": int(r["districts"]),
        "works_total": int(r["works_total"]), "works_flagged": int(r["works_flagged"]),
        "breach_rate": round(float(r["breach_rate"]), 4), "total_exposure": float(r["total_exposure"]),
        "risk_score": round(float(r["risk_score"]), 2),
    } for _, r in sr.iterrows()]
    return clean({"scope": scope, "date_from": date_from, "date_to": date_to, "count": len(items), "items": items})


@app.get("/api/state/{state_name}")
def get_state(state_name: str, scope: str = Query("18th Lok Sabha"), date_from: str | None = None, date_to: str | None = None):
    s = get_store()
    spine, wr_all, sr, dr, _ = s.risk_tables(scope, date_from, date_to)
    row = sr[sr["state"].str.casefold() == state_name.casefold()]
    if row.empty:
        raise HTTPException(404, f"no state '{state_name}' in scope {scope}")
    row = row.iloc[0]

    sp = spine[spine["STATE_NAME"].str.casefold() == state_name.casefold()]
    funnel = {"recommended": int(sp["has_recommended"].sum()), "sanctioned": int(sp["has_sanctioned"].sum()),
              "completed": int(sp["has_completed"].sum())}
    completion_rate = float(sp["has_completed"].sum() / sp["has_sanctioned"].sum() * 100) if sp["has_sanctioned"].sum() else None
    # national comparison over the same scope+date slice, before narrowing to this state.
    national_completion = float(spine["has_completed"].sum() / spine["has_sanctioned"].sum() * 100) if spine["has_sanctioned"].sum() else None
    # allocation is a lifetime-per-MP figure, not tied to any one work's
    # recommendation date - never narrowed by the date filter. scope="all"
    # sums both tenures rather than matching a SCOPE_TENURE value that never
    # actually appears in the data.
    state_alloc = s.allocated[s.allocated["STATE_NAME"].str.casefold() == state_name.casefold()]
    alloc = state_alloc if scope == "all" else state_alloc[state_alloc["SCOPE_TENURE"] == scope]

    f = s.findings_for_scope(scope)
    f = f[f["state"].str.casefold() == state_name.casefold()]
    if date_from:
        f = f[f["date"] >= pd.Timestamp(date_from)]
    if date_to:
        f = f[f["date"] <= pd.Timestamp(date_to)]
    tag_breakdown = f["tag"].value_counts().to_dict()
    delayed_by_district = f.loc[f["tag"] == "TIME DELAY"].groupby("district")["work_number"].nunique()

    districts = dr[dr["state"].str.casefold() == state_name.casefold()].sort_values("risk_score", ascending=False)
    district_items = []
    for _, r in districts.iterrows():
        d_sp = sp[sp["DISTRICT"] == r["district"]]
        sanctioned_amt = float(d_sp.loc[d_sp["has_sanctioned"], "SANCTION_AMOUNT"].sum())
        paid_amt = float(d_sp["exp_total_disbursed"].sum())
        district_items.append({
            "district": r["district"], "works_total": int(r["works_total"]), "works_flagged": int(r["works_flagged"]),
            "breach_rate": round(float(r["breach_rate"]), 4), "total_exposure": float(r["total_exposure"]),
            "risk_score": round(float(r["risk_score"]), 2),
            "delayed": int(delayed_by_district.get(r["district"], 0)),
            "sanctioned_amount": sanctioned_amt, "paid_amount": paid_amt,
            "utilization_rate": round(paid_amt / sanctioned_amt, 4) if sanctioned_amt else None,
            **stage_counts(d_sp),
        })

    wr = wr_all[wr_all["STATE_NAME"].str.casefold() == state_name.casefold()].sort_values("priority", ascending=False)
    queue = [{
        "work_number": r["work_number"], "scope_house": r["scope_house"], "scope_tenure": r["scope_tenure"],
        "district": r["DISTRICT"], "constituency": r["CONSTITUENCY"], "mp_name": r["MP_NAME"],
        "tags": list(r["tags"]), "max_severity": r["max_severity"], "total_exposure": float(r["total_exposure"]),
        "priority": round(float(r["priority"]), 2),
    } for _, r in wr.head(200).iterrows()]

    return clean({
        "state": row["state"], "scope": scope, "date_from": date_from, "date_to": date_to, "funnel": funnel,
        "works_total": int(row["works_total"]), "works_flagged": int(row["works_flagged"]),
        "breach_rate": round(float(row["breach_rate"]), 4), "total_exposure": float(row["total_exposure"]),
        "risk_score": round(float(row["risk_score"]), 2),
        "scorecard": {
            "allocated": float(alloc["ALLOCATED_AMT"].sum()) if not alloc.empty else None,
            "recommended": float(sp.loc[sp["has_recommended"], "rec_RECOMMENDED_AMOUNT"].sum()),
            "sanctioned": float(sp.loc[sp["has_sanctioned"], "SANCTION_AMOUNT"].sum()),
            "completed": float(sp.loc[sp["has_completed"], "comp_ACTUAL_AMOUNT"].sum()),
            "paid": float(sp["exp_total_disbursed"].sum()),
            "recommended_count": int(sp["has_recommended"].sum()), "sanctioned_count": int(sp["has_sanctioned"].sum()),
            "completed_count": int(sp["has_completed"].sum()), "paid_count": int(sp["has_expenditure"].sum()),
            "high_risk_count": int((wr["max_severity"] == "high").sum()),
            "high_risk_amount": float(wr.loc[wr["max_severity"] == "high", "total_exposure"].sum()),
            "works_total": int(row["works_total"]), "works_flagged": int(row["works_flagged"]),
            "breach_rate": round(float(row["breach_rate"]), 4),
            "delayed": delayed_count(f),
            **stage_counts(sp),
            "completion_rate": completion_rate,
            "national_median_completion_rate": national_completion,
        },
        "districts": district_items, "tag_breakdown": tag_breakdown, "queue": queue,
    })


@app.get("/api/mps")
def get_mps(
    scope: str = Query("all"),
    status: str | None = None,
    q: str | None = None,
    limit: int = 2000,
    offset: int = 0,
):
    """MP Audits directory - every (MP_NAME, SCOPE_TENURE) on record, real
    aggregate stats per MP, filterable by tenure/status/free-text search."""
    s = get_store()
    df = s.mp_directory
    if scope != "all":
        df = df[df["SCOPE_TENURE"] == scope]
    if status:
        df = df[df["status"].str.casefold() == status.casefold()]
    if q:
        ql = q.casefold()
        mask = (df["MP_NAME"].str.casefold().str.contains(ql, na=False)
                | df["constituency"].astype(str).str.casefold().str.contains(ql, na=False)
                | df["state"].astype(str).str.casefold().str.contains(ql, na=False))
        df = df[mask]
    df = df.sort_values("MP_NAME")
    total = len(df)
    page = df.iloc[offset:offset + limit]

    items = [{
        "mp_name": r["MP_NAME"], "scope_tenure": r["SCOPE_TENURE"], "status": r["status"],
        "state": r["state"], "constituency": r["constituency"],
        "works_total": int(r["works_total"]), "works_flagged": int(r["works_flagged"]),
        "breach_rate": round(float(r["breach_rate"]), 4) if pd.notna(r["breach_rate"]) else None,
        "total_exposure": float(r["total_exposure"]),
        "allocated_amt": float(r["ALLOCATED_AMT"]) if pd.notna(r["ALLOCATED_AMT"]) else None,
    } for _, r in page.iterrows()]
    return clean({"scope": scope, "status": status, "q": q, "total": total, "offset": offset, "limit": limit, "items": items})


@app.get("/api/mp/{mp_name}")
def get_mp(mp_name: str, scope: str = Query("18th Lok Sabha"), date_from: str | None = None, date_to: str | None = None):
    s = get_store()
    row = s.mp_directory[(s.mp_directory["MP_NAME"].str.casefold() == mp_name.casefold())
                          & (s.mp_directory["SCOPE_TENURE"] == scope)]
    if row.empty:
        raise HTTPException(404, f"no MP '{mp_name}' on record for {scope}")
    row = row.iloc[0]

    # every work this MP recommended, not just the flagged ones.
    sp_all = s.spine[(s.spine["MP_NAME"].str.casefold() == mp_name.casefold()) & (s.spine["SCOPE_TENURE"] == scope)]
    # the seat's own identity doesn't depend on the date filter - resolved
    # from the MP's full record, not the (possibly empty) date-narrowed slice.
    cid_vals = sp_all["CONSTITUENCY_ID"].dropna().unique().tolist()
    constituency_id = str(int(cid_vals[0])) if cid_vals else None
    pc_id = s.crosswalk.get(constituency_id) if constituency_id else None

    sp = sp_all
    if date_from:
        sp = sp[sp["rec_RECOMMENDATION_DATE"] >= pd.Timestamp(date_from)]
    if date_to:
        sp = sp[sp["rec_RECOMMENDATION_DATE"] <= pd.Timestamp(date_to)]
    sp = sp.sort_values("rec_RECOMMENDATION_DATE", ascending=False)

    work_numbers = set(sp["work_number"])
    mp_findings = s.findings[(s.findings["scope_tenure"] == scope) & (s.findings["work_number"].isin(work_numbers))]
    sev_order = {"low": 1, "medium": 2, "high": 3}
    tag_by_work, sev_by_work = {}, {}
    for wn, grp in mp_findings.groupby("work_number"):
        tag_by_work[wn] = sorted(grp["tag"].unique().tolist())
        sev_by_work[wn] = max(grp["severity"], key=lambda v: sev_order[v])

    # ACTIVITY_NAME_CLEAN coalesced the same way each work's own "activity"
    # field already is below - the peer-grouping key documented in
    # docs/SCHEMA.md, not the near-useless 4-value WORK_CATEGORY picklist
    # (98.2% in one bucket). Top-10 by count + an "Other" bucket, for the
    # development-category donut - ~120 real categories is too many to chart.
    activity = sp["rec_ACTIVITY_NAME_CLEAN"].where(
        sp["rec_ACTIVITY_NAME_CLEAN"].notna(), sp["san_ACTIVITY_NAME_CLEAN"])
    activity_counts = activity.dropna().value_counts()
    top_activities = activity_counts.head(10)
    other_count = int(activity_counts.iloc[10:].sum())
    activity_breakdown = [{"label": k, "value": int(v)} for k, v in top_activities.items()]
    if other_count:
        activity_breakdown.append({"label": "Other", "value": other_count})

    recommended_works = [{
        "work_number": r.work_number,
        "activity": r.rec_ACTIVITY_NAME_CLEAN if pd.notna(r.rec_ACTIVITY_NAME_CLEAN) else (
            r.san_ACTIVITY_NAME_CLEAN if pd.notna(r.san_ACTIVITY_NAME_CLEAN) else None),
        "constituency": r.CONSTITUENCY, "district": r.DISTRICT,
        "recommended_date": r.rec_RECOMMENDATION_DATE, "recommended_amount": r.rec_RECOMMENDED_AMOUNT,
        "stage": r.WORK_STAGE_RESOLVED,
        "has_sanctioned": bool(r.has_sanctioned), "has_completed": bool(r.has_completed),
        "tags": tag_by_work.get(r.work_number, []), "max_severity": sev_by_work.get(r.work_number),
    } for r in sp.itertuples()]

    works_total = len(sp)
    works_flagged = mp_findings["work_number"].nunique()
    sanctioned_n = int(sp["has_sanctioned"].sum())
    completed_n = int(sp["has_completed"].sum())
    completion_rate = float(completed_n / sanctioned_n * 100) if sanctioned_n else None

    return clean({
        "mp_name": row["MP_NAME"], "scope_tenure": scope, "status": row["status"],
        "state": row["state"], "constituency": row["constituency"],
        "constituency_id": constituency_id, "pc_id": pc_id,
        "date_from": date_from, "date_to": date_to,
        "tenure_start": row["TENURE_START_DATE"], "tenure_end": row["TENURE_END_DATE"],
        "scorecard": {
            # allocation is a lifetime-per-MP figure, not tied to any one
            # work's recommendation date - never narrowed by the date filter.
            "allocated": float(row["ALLOCATED_AMT"]) if pd.notna(row["ALLOCATED_AMT"]) else None,
            "recommended": float(sp.loc[sp["has_recommended"], "rec_RECOMMENDED_AMOUNT"].sum()),
            "sanctioned": float(sp.loc[sp["has_sanctioned"], "SANCTION_AMOUNT"].sum()),
            "completed": float(sp.loc[sp["has_completed"], "comp_ACTUAL_AMOUNT"].sum()),
            "paid": float(sp["exp_total_disbursed"].sum()),
            "recommended_count": works_total, "sanctioned_count": sanctioned_n, "completed_count": completed_n,
            "paid_count": int(sp["has_expenditure"].sum()),
            "works_total": works_total, "works_flagged": int(works_flagged),
            "breach_rate": round(works_flagged / works_total, 4) if works_total else None,
            "pending_approvals": int((sp["has_recommended"] & ~sp["has_sanctioned"]).sum()),
            "delayed": delayed_count(mp_findings),
            "completion_rate": completion_rate,
        },
        "activity_breakdown": activity_breakdown,
        "recommended_works": recommended_works,
    })


@app.get("/api/districts")
def get_districts(state: str, scope: str = Query("all")):
    """District Authority role picker, scoped to one state (a District
    Authority sits under one State Nodal Authority)."""
    s = get_store()
    dr = s.district_risk_for_scope(scope)
    rows = dr[dr["state"].str.casefold() == state.casefold()].sort_values("risk_score", ascending=False)
    items = [{
        "district": r["district"], "state": r["state"], "works_total": int(r["works_total"]),
        "works_flagged": int(r["works_flagged"]), "breach_rate": round(float(r["breach_rate"]), 4),
        "risk_score": round(float(r["risk_score"]), 2),
    } for _, r in rows.iterrows()]
    return clean({"state": state, "scope": scope, "count": len(items), "items": items})


@app.get("/api/district/{state_name}/{district_name}")
def get_district(state_name: str, district_name: str, scope: str = Query("18th Lok Sabha"), date_from: str | None = None, date_to: str | None = None):
    s = get_store()
    spine, wr_all, _, dr, _ = s.risk_tables(scope, date_from, date_to)
    row = dr[(dr["state"].str.casefold() == state_name.casefold()) & (dr["district"].str.casefold() == district_name.casefold())]
    if row.empty:
        raise HTTPException(404, f"no district '{district_name}' in state '{state_name}', scope {scope}")
    row = row.iloc[0]

    sp = spine[(spine["DISTRICT"].str.casefold() == district_name.casefold())
               & (spine["STATE_NAME"].str.casefold() == state_name.casefold())]
    funnel = {"recommended": int(sp["has_recommended"].sum()), "sanctioned": int(sp["has_sanctioned"].sum()),
              "completed": int(sp["has_completed"].sum())}
    # constituencies touched by this district's works - a district's sanctioning
    # authority (IDA) can span works recommended from more than one seat.
    constituencies = sorted(c for c in sp["CONSTITUENCY"].dropna().unique().tolist())
    # same seats, but with the join keys the map needs to draw them (pc_id via
    # the crosswalk) - lets the district page show its own constituencies on
    # the same map component the state/constituency views already use.
    const_lookup = sp[["CONSTITUENCY", "CONSTITUENCY_ID"]].dropna().drop_duplicates(subset="CONSTITUENCY")
    constituency_details = [{
        "constituency": r.CONSTITUENCY, "constituency_id": str(int(r.CONSTITUENCY_ID)),
        "pc_id": s.crosswalk.get(str(int(r.CONSTITUENCY_ID))),
    } for r in const_lookup.itertuples()]

    completion_rate = float(sp["has_completed"].sum() / sp["has_sanctioned"].sum() * 100) if sp["has_sanctioned"].sum() else None
    # the district sanctioning authority (IDA) name, verbatim from the source
    # data (see docs/SCHEMA.md) - one district normally has exactly one, kept
    # as a list rather than assuming that in case the data ever disagrees.
    district_authority = sorted(sp["IDA_NAME_CLEAN"].dropna().unique().tolist())
    # every MP whose recommendations touch this district, paired with which
    # constituency - a district can span more than one seat's MP (DISTRICT is
    # derived from the sanctioning IDA, not the MP's own constituency, so a
    # handful of a seat's works can be sanctioned through a neighbouring
    # district's authority - e.g. a boundary-adjacent work). Ranked by how
    # many of this district's works that MP actually recommended, with the
    # count carried through, so a real 100+-work incumbent and a 1-2-work
    # administrative edge case aren't shown as equally-weighted "the
    # district's MPs" - verified against real Rajasthan data during review.
    mp_sp = sp.dropna(subset=["MP_NAME", "CONSTITUENCY", "CONSTITUENCY_ID"])
    mps = sorted(
        mp_sp.groupby(["MP_NAME", "CONSTITUENCY", "CONSTITUENCY_ID"]).size().items(),
        key=lambda kv: kv[1], reverse=True,
    )
    # allocation is a lifetime-per-MP figure, not tied to any one work's
    # recommendation date - never narrowed by the date filter.
    district_alloc = s.allocated[s.allocated["CONSTITUENCY"].isin(constituencies)
                                  & (s.allocated["STATE_NAME"].str.casefold() == state_name.casefold())]
    alloc = district_alloc if scope == "all" else district_alloc[district_alloc["SCOPE_TENURE"] == scope]

    wr = wr_all[(wr_all["DISTRICT"].str.casefold() == district_name.casefold())
                & (wr_all["STATE_NAME"].str.casefold() == state_name.casefold())].sort_values("priority", ascending=False)
    queue = [{
        "work_number": r["work_number"], "scope_house": r["scope_house"], "scope_tenure": r["scope_tenure"],
        "constituency": r["CONSTITUENCY"], "mp_name": r["MP_NAME"], "tags": list(r["tags"]),
        "max_severity": r["max_severity"], "total_exposure": float(r["total_exposure"]),
        "priority": round(float(r["priority"]), 2),
    } for _, r in wr.iterrows()]

    f = s.findings_for_scope(scope)
    f = f[f["district"].astype(str).str.casefold() == district_name.casefold()]
    if date_from:
        f = f[f["date"] >= pd.Timestamp(date_from)]
    if date_to:
        f = f[f["date"] <= pd.Timestamp(date_to)]
    tag_breakdown = f["tag"].value_counts().to_dict()

    # implementing-agency performance within this district (spec 2.E) -
    # exp_top_ia is only populated once a work has any expenditure (~70% of
    # works nationally), so agency_sp is a real subset of sp, not a bug.
    agency_sp = sp[sp["exp_top_ia"].notna()]
    delayed_by_agency = (wr[wr["tags"].apply(lambda t: "TIME DELAY" in t)].groupby("exp_top_ia")["work_number"].nunique()
                          if len(wr) else pd.Series(dtype="int64"))
    agency_performance = []
    if len(agency_sp):
        completion_days = (agency_sp["comp_ACTUAL_END_DATE"] - agency_sp["SANCTION_DATE"]).dt.days
        agency_perf = agency_sp.assign(
            _completed=agency_sp["has_completed"],
            _ongoing=agency_sp["has_sanctioned"] & ~agency_sp["has_completed"],
            _completion_days=completion_days,
        ).groupby("exp_top_ia").agg(
            works_total=("WORK_RECOMMENDATION_DTL_ID", "size"),
            completed=("_completed", "sum"),
            ongoing=("_ongoing", "sum"),
            expenditure=("exp_total_disbursed", "sum"),
            avg_completion_days=("_completion_days", "mean"),
        ).reset_index().sort_values("works_total", ascending=False).head(50)
        agency_performance = [{
            "agency": r["exp_top_ia"], "works_total": int(r["works_total"]), "completed": int(r["completed"]),
            "ongoing": int(r["ongoing"]), "delayed": int(delayed_by_agency.get(r["exp_top_ia"], 0)),
            "expenditure": float(r["expenditure"]),
            "avg_completion_days": round(float(r["avg_completion_days"]), 1) if pd.notna(r["avg_completion_days"]) else None,
        } for _, r in agency_perf.iterrows()]

    return clean({
        "district": row["district"], "state": row["state"], "scope": scope,
        "date_from": date_from, "date_to": date_to, "funnel": funnel,
        "constituencies": constituencies,
        "constituency_details": constituency_details,
        "works_total": int(row["works_total"]), "works_flagged": int(row["works_flagged"]),
        "breach_rate": round(float(row["breach_rate"]), 4), "total_exposure": float(row["total_exposure"]),
        "risk_score": round(float(row["risk_score"]), 2),
        "total_states": len(s.state_risk_for_scope(scope)),
        "district_authority": district_authority,
        "mps": [
            {"mp_name": mp, "constituency": c, "constituency_id": str(int(cid)), "works_count": int(n)}
            for (mp, c, cid), n in mps
        ],
        "boundary": s.district_boundary(state_name, district_name),
        "agency_performance": agency_performance,
        "scorecard": {
            "allocated": float(alloc["ALLOCATED_AMT"].sum()) if not alloc.empty else None,
            "recommended": float(sp.loc[sp["has_recommended"], "rec_RECOMMENDED_AMOUNT"].sum()),
            "sanctioned": float(sp.loc[sp["has_sanctioned"], "SANCTION_AMOUNT"].sum()),
            "completed": float(sp.loc[sp["has_completed"], "comp_ACTUAL_AMOUNT"].sum()),
            "paid": float(sp["exp_total_disbursed"].sum()),
            "recommended_count": int(sp["has_recommended"].sum()), "sanctioned_count": int(sp["has_sanctioned"].sum()),
            "completed_count": int(sp["has_completed"].sum()), "paid_count": int(sp["has_expenditure"].sum()),
            "high_risk_count": int((wr["max_severity"] == "high").sum()),
            "high_risk_amount": float(wr.loc[wr["max_severity"] == "high", "total_exposure"].sum()),
            "works_total": int(row["works_total"]), "works_flagged": int(row["works_flagged"]),
            "delayed": delayed_count(f),
            **stage_counts(sp),
            "completion_rate": completion_rate,
        },
        "tag_breakdown": tag_breakdown, "queue": queue,
    })


@app.get("/api/agencies")
def get_agencies(scope: str = Query("all"), q: str | None = None, limit: int = 25, offset: int = 0):
    """Implementing Agency role picker + search. Unlike state/district/MP,
    an agency has no geographic parent to cascade through - agency identity
    is a name only (exp_top_ia, whitespace/case-normalised but never
    fuzzy-clustered - see docs/SCHEMA.md), and there are ~6,000-13,000 of
    them depending on scope, so this always requires a free-text query
    (or a hard-capped limit) rather than ever listing them all."""
    s = get_store()
    df = s.agency_risk_for_scope(scope)
    if q:
        df = df[df["agency"].str.casefold().str.contains(q.casefold(), na=False)]
    df = df.sort_values("works_total", ascending=False)
    total = len(df)
    limit = min(limit, 100)
    page = df.iloc[offset:offset + limit]
    items = [{
        "agency": r["agency"], "works_total": int(r["works_total"]), "works_flagged": int(r["works_flagged"]),
        "breach_rate": round(float(r["breach_rate"]), 4), "total_exposure": float(r["total_exposure"]),
        "risk_score": round(float(r["risk_score"]), 2),
    } for _, r in page.iterrows()]
    return clean({"scope": scope, "q": q, "total": total, "offset": offset, "limit": limit, "items": items})


@app.get("/api/agency/{agency_name}")
def get_agency(agency_name: str, scope: str = Query("18th Lok Sabha"), date_from: str | None = None, date_to: str | None = None):
    s = get_store()
    spine, wr_all, _, _, _ = s.risk_tables(scope, date_from, date_to)
    if date_from or date_to:
        # risk_tables()'s date-filtered wr_all is already narrowed to exactly
        # the in-scope rows - re-stamping in_demo_scope=True over all of them
        # (rather than re-deriving it) is correct, not a shortcut, since
        # there's nothing left to filter out.
        scopes = [scope] if scope != "all" else SCOPES
        ar = rollup.build_agency_risk(wr_all.assign(in_demo_scope=True), spine, scopes)
    else:
        ar = s.agency_risk_for_scope(scope)
    row = ar[ar["agency"].str.casefold() == agency_name.casefold()]
    if row.empty:
        raise HTTPException(404, f"no agency '{agency_name}' in scope {scope}")
    row = row.iloc[0]
    agency_real_name = row["agency"]

    sp = spine[spine["exp_top_ia"].str.casefold() == agency_name.casefold()]
    wr = wr_all[wr_all["exp_top_ia"].str.casefold() == agency_name.casefold()].sort_values("priority", ascending=False)

    f = s.findings_for_scope(scope)
    f = f[f["work_number"].isin(set(sp["work_number"]))]
    if date_from:
        f = f[f["date"] >= pd.Timestamp(date_from)]
    if date_to:
        f = f[f["date"] <= pd.Timestamp(date_to)]
    tag_breakdown = f["tag"].value_counts().to_dict()

    queue = [{
        "work_number": r["work_number"], "scope_house": r["scope_house"], "scope_tenure": r["scope_tenure"],
        "state": r["STATE_NAME"], "district": r["DISTRICT"], "constituency": r["CONSTITUENCY"], "mp_name": r["MP_NAME"],
        "tags": list(r["tags"]), "max_severity": r["max_severity"], "total_exposure": float(r["total_exposure"]),
        "priority": round(float(r["priority"]), 2),
    } for _, r in wr.iterrows()]

    return clean({
        "agency": agency_real_name, "scope": scope, "date_from": date_from, "date_to": date_to,
        "works_total": int(row["works_total"]), "works_flagged": int(row["works_flagged"]),
        "breach_rate": round(float(row["breach_rate"]), 4), "total_exposure": float(row["total_exposure"]),
        "risk_score": round(float(row["risk_score"]), 2),
        "states_touched": sorted(sp["STATE_NAME"].dropna().unique().tolist()),
        "constituencies_touched": sorted(sp["CONSTITUENCY"].dropna().unique().tolist()),
        # allocated/recommended don't apply - allocation is a per-MP lifetime
        # figure, not something an implementing agency has of its own.
        "scorecard": {
            "sanctioned": float(sp.loc[sp["has_sanctioned"], "SANCTION_AMOUNT"].sum()),
            "completed": float(sp.loc[sp["has_completed"], "comp_ACTUAL_AMOUNT"].sum()),
            "paid": float(sp["exp_total_disbursed"].sum()),
            "sanctioned_count": int(sp["has_sanctioned"].sum()), "completed_count": int(sp["has_completed"].sum()),
            "paid_count": int(sp["has_expenditure"].sum()),
            "high_risk_count": int((wr["max_severity"] == "high").sum()),
            "high_risk_amount": float(wr.loc[wr["max_severity"] == "high", "total_exposure"].sum()),
            "works_total": int(row["works_total"]), "works_flagged": int(row["works_flagged"]),
            "delayed": delayed_count(f),
            **stage_counts(sp),
        },
        "tag_breakdown": tag_breakdown, "queue": queue,
        "data_caveat": (
            "Agency identity is matched by name only (spelling/case-normalised, "
            "not deduplicated across real spelling variants of the same agency), "
            "and only assigned once a work has any recorded expenditure - a work "
            "still at Recommended or Sanctioned stage with zero disbursement has "
            "no agency attribution yet and will not appear here."
        ),
    })


class ReportCreate(BaseModel):
    level: str  # "overview" | "india" | "state" | "district" | "agency" | "constituency" | "mp"
    title: str
    scope: str
    date_from: str | None = None
    date_to: str | None = None
    state: str | None = None
    district: str | None = None
    agency: str | None = None
    summary: dict
    pdf_base64: str | None = None  # data captured from the screen at generation time


@app.get("/api/reports")
def get_reports():
    return clean({"items": reports_store.list_reports()})


@app.post("/api/reports")
def post_report(body: ReportCreate):
    fields = body.model_dump(exclude={"pdf_base64"})
    pdf_bytes = base64.b64decode(body.pdf_base64) if body.pdf_base64 else None
    return clean(reports_store.create_report(fields, pdf_bytes))


@app.delete("/api/reports/{report_id}")
def remove_report(report_id: str):
    if not reports_store.delete_report(report_id):
        raise HTTPException(404, f"no report '{report_id}'")
    return {"deleted": report_id}


@app.get("/api/reports/{report_id}/pdf")
def get_report_pdf(report_id: str):
    record = reports_store.get_report(report_id)
    if not record or not record.get("has_pdf"):
        raise HTTPException(404, f"no report pdf for '{report_id}'")
    path = reports_store.pdf_path(report_id)
    if not path.exists():
        raise HTTPException(404, f"no report pdf for '{report_id}'")
    safe_name = re.sub(r"[^\w-]+", "_", record["title"]).strip("_") or "report"
    date_stamp = record["created_at"][:10]
    return FileResponse(
        path, media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}_{date_stamp}.pdf"'},
    )


@app.get("/")
def root():
    return {"service": "MPLADS Anomaly Review API", "docs": "/docs"}
