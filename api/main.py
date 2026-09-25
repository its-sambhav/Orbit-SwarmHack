"""Read-only API over the precomputed MPLADS engine outputs.

    uvicorn api.main:app --reload --port 8000

Nothing here computes a detector or re-runs the pipeline - every route
reads findings/work_risk/constituency_risk/spine that engine/run_pipeline.py
already produced. The exceptions: /api/narrative calls an LLM (via OpenRouter)
to format (never generate) reasoning already present in a finding's evidence -
see api/narrative.py for the validator that enforces this; /api/predict_risk
and /api/work/{n}/ai_assessment call the trained scikit-learn model in
engine/predictive.py (a real, separate signal from the rule-based detectors -
predicts delay risk, it doesn't detect anything that already happened).
"""
import base64
import json
import math
import re
from contextlib import asynccontextmanager
from typing import Literal

import numpy as np
import pandas as pd
from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from api.data import get_store, SCOPES, SCOPE_LABELS, GEO_DIR
from api.narrative import generate_narrative
from api import translate as translate_service
from engine.predictive import predict_work_risk
from engine.predictive import get_model as get_delay_model
from engine.risk_model import predict as predict_risk_model, get_model as get_risk_model
from api import reports as reports_store
from api import finding_status as finding_status_store
from api import comments as comments_store
from api import alerts as alerts_store
from api import auth
from api.sector_categories import CATEGORIES
from engine import rollup
from engine.detectors import load_tags

TAG_REGISTRY = load_tags()["tags"]
# every delay-type tag (the "timing" family in config/tags.yaml) - what the
# dashboards' "delayed" counts mean
TIMING_TAGS = {t["name"] for t in TAG_REGISTRY.values() if t["family"] == "timing"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # api/data.py's own docstring says the Store loads "once at process
    # start" - without this it actually only loaded lazily, on whichever
    # request happened to arrive first, so a real user's first page load
    # (not `uvicorn`'s own startup) silently ate the one-time ~20s cost of
    # reading every parquet file into memory. This just makes that already-
    # documented intent real: uvicorn now won't report ready / accept
    # traffic until the data is loaded, instead of the first visitor's
    # request doing it. No response, route, or behavior changes.
    get_store()
    # same reasoning extended to both ML models behind /ai_assessment -
    # otherwise the first real call to that endpoint pays for lazy-training
    # two joblib artifacts back-to-back on one request thread.
    get_delay_model()
    get_risk_model()
    # fail fast at boot, not on the first login attempt, if the secret that
    # signs every auth token was never configured.
    auth._secret()
    yield


app = FastAPI(title="MPLADS Anomaly Review API", lifespan=lifespan)

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


TAG_FAMILY = {t["name"]: t["family"] for t in TAG_REGISTRY.values()}
_SEV_RANK = {"low": 0, "medium": 1, "high": 2}
_WORK_KEY = ["work_number", "scope_house", "scope_tenure"]


def tag_summary(findings_slice: pd.DataFrame) -> dict:
    """Findings by tag, counted in WORKS, not findings - one work can carry
    several tags, so the per-tag counts add up to more than the number of
    flagged works (which is why this is a ranked bar list, not a donut).
    Each tag's works are split by the worst severity that tag has on the
    work. `flagged_works` is the distinct works with any finding here - the
    denominator for each tag's share."""
    f = findings_slice
    if f.empty:
        return {"flagged_works": 0, "items": []}
    per_work = (f.assign(_r=f["severity"].map(_SEV_RANK))
                .groupby(["tag", *_WORK_KEY])["_r"].max().reset_index())
    items = []
    for tag, g in per_work.groupby("tag"):
        c = g["_r"].value_counts()
        items.append({"tag": tag, "family": TAG_FAMILY.get(tag), "works": int(len(g)),
                      "high": int(c.get(2, 0)), "medium": int(c.get(1, 0)), "low": int(c.get(0, 0))})
    items.sort(key=lambda i: (-i["works"], i["tag"]))
    return {"flagged_works": int(f[_WORK_KEY].drop_duplicates().shape[0]), "items": items}


def pipeline_summary(sp: pd.DataFrame, wr: pd.DataFrame) -> dict:
    """Where works are NOW - each work in exactly one stage, so the stages
    add up to the total: awaiting sanction (recommended, not sanctioned),
    in progress (sanctioned, not completed), completed. For each stage, how
    many of its works are flagged (substantive findings only, same rule as
    every "works flagged" figure), plus the two conversion rates between
    stages."""
    sanctioned = sp["has_sanctioned"].astype(bool)
    completed = sp["has_completed"].astype(bool)
    stage = pd.Series(np.select([completed, sanctioned], ["completed", "in_progress"], "awaiting_sanction"),
                      index=sp.index)
    flagged_keys = wr.loc[wr["is_substantive"].astype(bool), _WORK_KEY] if "is_substantive" in wr else wr[_WORK_KEY]
    keys = sp[["work_number", "SCOPE_HOUSE", "SCOPE_TENURE"]].rename(
        columns={"SCOPE_HOUSE": "scope_house", "SCOPE_TENURE": "scope_tenure"})
    is_flagged = keys.merge(flagged_keys.drop_duplicates().assign(_f=True), on=_WORK_KEY, how="left")["_f"] \
        .fillna(False).astype(bool).to_numpy()
    stages = []
    for key in ("awaiting_sanction", "in_progress", "completed"):
        m = (stage == key).to_numpy()
        stages.append({"key": key, "works": int(m.sum()), "flagged": int((m & is_flagged).sum())})
    recommended, n_sanctioned = int(sp["has_recommended"].sum()), int(sanctioned.sum())
    return {
        "total": int(len(sp)),
        "stages": stages,
        "sanction_rate": round(n_sanctioned / recommended, 4) if recommended else None,
        "completion_rate": round(int(completed.sum()) / n_sanctioned, 4) if n_sanctioned else None,
    }


def delayed_count(findings_slice: pd.DataFrame) -> int:
    """Distinct works carrying any timing-family tag (Delay in Sanction,
    Delay in Completion, ... - config/tags.yaml) within an already-scoped
    findings slice, not a second invented delay definition."""
    return int(findings_slice.loc[findings_slice["tag"].isin(TIMING_TAGS), "work_number"].nunique())


def category_breakdown(sp: pd.DataFrame, wr: pd.DataFrame) -> list[dict]:
    """Recommended/sanctioned/high-risk/completed counts+amounts, split by
    the 5 sector categories in api/sector_categories.py, for the "Project
    Lifecycle & Risk Breakdown" chart. `sp`/`wr` are the same already
    scope+filter-narrowed spine/work_risk slices the caller's own scorecard
    uses - same source columns as get_funnel(), just grouped by CATEGORY
    first, so this always foots to that scorecard's own totals."""
    out = []
    for cat in CATEGORIES:
        csp = sp[sp["CATEGORY"] == cat]
        cwr = wr[wr["category"] == cat]
        high_risk = cwr[cwr["max_severity"] == "high"]
        out.append({
            "sector": cat,
            "recommended": int(csp["has_recommended"].sum()),
            "recommended_amount": float(csp.loc[csp["has_recommended"], "rec_RECOMMENDED_AMOUNT"].sum()),
            "sanctioned": int(csp["has_sanctioned"].sum()),
            "sanctioned_amount": float(csp.loc[csp["has_sanctioned"], "SANCTION_AMOUNT"].sum()),
            "high_risk": int(len(high_risk)),
            "high_risk_amount": float(high_risk["total_exposure"].sum()),
            "completed": int(csp["has_completed"].sum()),
            "completed_amount": float(csp.loc[csp["has_completed"], "comp_ACTUAL_AMOUNT"].sum()),
        })
    return out


class LoginRequest(BaseModel):
    role: Literal["mospi", "state", "district", "agency", "mp"]
    password: str
    entity: str | None = None  # e.g. a state name, "State|District", an MP name, an agency name - None for mospi


@app.post("/api/auth/login")
def login(body: LoginRequest):
    if not auth.verify_password(body.role, body.password):
        raise HTTPException(401, "incorrect password")
    if body.role != "mospi" and not (body.entity or "").strip():
        raise HTTPException(400, "entity is required for this role")
    entity = None if body.role == "mospi" else body.entity.strip()
    token = auth.issue_token(body.role, entity)
    return {"token": token, "role": body.role, "entity": entity, "expires_in_seconds": auth.TOKEN_TTL_SECONDS}


@app.get("/api/meta")
def get_meta():
    s = get_store()
    in_scope_spine = s.spine[s.spine["SCOPE_TENURE"].isin(s.demo_scopes)]
    in_scope_flagged = s.work_risk[s.work_risk["in_demo_scope"] & s.work_risk["is_substantive"]]
    return clean({
        "as_of_date": s.cfg["as_of_date"],
        "scopes": [{"value": v, "label": SCOPE_LABELS[v]} for v in SCOPES],
        "demo_scopes": s.demo_scopes,
        "tags": [t["name"] for t in TAG_REGISTRY.values()],
        "tag_registry": [{"key": k, "name": t["name"], "source": t["source"], "verified": t["verified"],
                          "family": t["family"]} for k, t in TAG_REGISTRY.items()],
        "severities": ["low", "medium", "high"],
        "stages": sorted(s.findings["stage"].unique().tolist()),
        "detectors": sorted(s.findings["detector"].unique().tolist()),
        "national": {
            "total_works": len(s.spine),
            "total_findings": len(s.findings),
            "flagged_works": int(s.work_risk["is_substantive"].sum()),
            "total_states": int(in_scope_spine["STATE_NAME"].nunique()),
            "breach_rate_all_scope": round(int(s.work_risk["is_substantive"].sum()) / len(s.spine) * 100, 1),
            "breach_rate_in_scope": round(len(in_scope_flagged) / len(in_scope_spine) * 100, 1),
            "queue_size": int(s.work_risk["in_queue"].sum()) if "in_queue" in s.work_risk else None,
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
    # "flagged" = materially flagged (is_substantive) - a work whose only
    # finding is a missing scanned file (documentation) or a date-entry
    # mismatch (data_integrity) isn't counted as needing review, though it's
    # still visible on its own case file. See rollup.py's NON_SUBSTANTIVE_FAMILIES.
    works_flagged = int(wr["is_substantive"].sum())
    documentation_only_count = int((~wr["is_substantive"]).sum())
    # distinct works whose worst finding is high-severity (not a raw finding
    # count, which would multi-count a work with more than one high finding).
    high_risk = wr[wr["max_severity"] == "high"]
    return clean({
        "scope": scope, "date_from": date_from, "date_to": date_to,
        "total_works": len(sp),
        "total_amount": float(total_amount),
        "allocated": float(alloc["ALLOCATED_AMT"].sum()),
        "works_flagged": works_flagged,
        "documentation_only_count": documentation_only_count,
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
        "category_breakdown": category_breakdown(sp, wr),
        "pipeline": pipeline_summary(sp, wr),
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
        "tag_summary": tag_summary(f),
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


def top_finding_lookup(s):
    """Per-work lookup keyed on this work's single highest-priority finding -
    used to label a review-queue card with a plain-English reason it was
    flagged (evidence.deviation, e.g. "649 days - slower than 90% of 30,717
    comparable works...") rather than just an abstract tag chip
    (STATUTORY COMPLIANCE, AGENCY CONCENTRATION) that names a category but
    never says what actually happened. Shared by /api/queue and
    /api/constituency/{id}, the two endpoints that render this kind of card."""
    top = (s.findings.sort_values("priority_score", ascending=False)
           .drop_duplicates(subset=["work_number", "scope_house", "scope_tenure"])
           .set_index(["work_number", "scope_house", "scope_tenure"]))
    routed = top["routed_to"]
    headline = top["evidence"].apply(lambda e: e.get("deviation") if isinstance(e, dict) else None)
    return routed, headline


@app.get("/api/queue")
def get_queue(
    scope: str = Query("all"),
    q: str | None = None,
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

    if q:
        # a reviewer types a work number, an MP/constituency name, or a
        # word from the work's own description - one case-insensitive
        # substring match across all of them, not a separate field picker,
        # since this is the "full" queue browser and a reviewer rarely
        # knows in advance which field their search term lives in.
        needle = q.strip().casefold()
        if needle:
            haystack = (
                wr["work_number"].astype(str) + " " + wr["CONSTITUENCY"].fillna("") + " "
                + wr["STATE_NAME"].fillna("") + " " + wr["MP_NAME"].fillna("") + " "
                + wr["work_description"].fillna("")
            ).str.casefold()
            wr = wr[haystack.str.contains(needle, regex=False)]
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

    # priority decides the order; the isolation-forest anomaly score only
    # reorders works inside the same priority band (engine/risk_model.py)
    band = s.cfg["queue"]["anomaly_reorder_band"]
    wr = wr.assign(_band=np.floor(wr["priority"] / band))
    order = ["_band"] + (["anomaly_score"] if "anomaly_score" in wr else []) + ["priority"]
    wr = wr.sort_values(order, ascending=False, na_position="last")
    total = len(wr)
    page = wr.iloc[offset:offset + limit]

    routed, headline = top_finding_lookup(s)

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
            "headline": headline.get(key, None),
            "work_description": row.get("work_description"),
            "lifecycle_stage": row.get("lifecycle_stage"),
        })
    return clean({"scope": scope, "total": total, "offset": offset, "limit": limit, "items": items})


@app.get("/api/work/{work_number}")
def get_work(
    work_number: str, scope_house: str, scope_tenure: str,
    claims: dict = Depends(auth.get_current_claims),
):
    s = get_store()
    work = s.work(work_number, scope_house, scope_tenure)
    if work is None:
        raise HTTPException(404, f"no work {work_number} in {scope_house}/{scope_tenure}")
    auth.check_work_access(claims, work)
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
    # rec_/san_/comp_ each carry their own copy of the free-text description
    # from that stage's own source row - coalesced the same way this file
    # already coalesces activity names, since a work not yet sanctioned/
    # completed only has the recommendation-stage copy populated.
    work_description = next(
        (work.get(c) for c in ("rec_WORK_DESCRIPTION", "san_WORK_DESCRIPTION", "comp_WORK_DESCRIPTION")
         if pd.notna(work.get(c))),
        None,
    )

    return clean({
        "work_number": work_number, "scope_house": scope_house, "scope_tenure": scope_tenure,
        "state": work.get("STATE_NAME"), "constituency": work.get("CONSTITUENCY"),
        "district": work.get("DISTRICT"),
        "constituency_id": work.get("CONSTITUENCY_ID"), "mp_name": work.get("MP_NAME"),
        "work_stage": work.get("WORK_STAGE_RESOLVED"),
        "work_description": work_description,
        "has_recommended": work.get("has_recommended"), "has_sanctioned": work.get("has_sanctioned"),
        "has_completed": work.get("has_completed"), "has_expenditure": work.get("has_expenditure"),
        "lifecycle": lifecycle,
        "findings": findings,
    })


@app.post("/api/narrative")
def post_narrative(
    work_number: str, scope_house: str, scope_tenure: str, finding_id: str,
    claims: dict = Depends(auth.get_current_claims),
):
    s = get_store()
    work = s.work(work_number, scope_house, scope_tenure)
    if work is None:
        raise HTTPException(404, f"no work {work_number} in {scope_house}/{scope_tenure}")
    auth.check_work_access(claims, work)
    findings = s.findings_for_work(work_number, scope_house, scope_tenure)
    finding = next((f for f in findings if f["finding_id"] == finding_id), None)
    if finding is None:
        raise HTTPException(404, f"no finding {finding_id} on that work")
    result = generate_narrative(finding)
    return clean(result)




class CommentCreate(BaseModel):
    work_number: str
    scope_house: str
    scope_tenure: str
    body: str
    parent_id: str | None = None
    mentions: list[str] | None = None
    internal: bool = False


class CommentPatch(BaseModel):
    body: str | None = None
    pinned: bool | None = None
    resolved: bool | None = None
    internal: bool | None = None


# The case discussion on one work (api/comments.py). Access is the same check
# the case file itself uses - if you may read the work, you may read and join
# the conversation about it. Authorship is taken from the caller's own token,
# never from the request body.
@app.get("/api/comments")
def get_comments(
    work_number: str, scope_house: str, scope_tenure: str,
    claims: dict = Depends(auth.get_current_claims),
):
    work = get_store().work(work_number, scope_house, scope_tenure)
    if work is None:
        raise HTTPException(404, f"no work {work_number} in {scope_house}/{scope_tenure}")
    auth.check_work_access(claims, work)
    return {
        "items": comments_store.list_for_work(work_number, scope_house, scope_tenure, claims),
        "me": {"role": claims.get("role"), "entity": claims.get("entity")},
        "mentionable": comments_store.MENTIONABLE_ROLES,
    }


@app.post("/api/comments")
def post_comment(req: CommentCreate, claims: dict = Depends(auth.get_current_claims)):
    work = get_store().work(req.work_number, req.scope_house, req.scope_tenure)
    if work is None:
        raise HTTPException(404, f"no work {req.work_number} in {req.scope_house}/{req.scope_tenure}")
    auth.check_work_access(claims, work)
    try:
        return comments_store.add(
            req.work_number, req.scope_house, req.scope_tenure, req.body,
            claims, parent_id=req.parent_id, mentions=req.mentions,
            internal=req.internal,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.patch("/api/comments/{comment_id}")
def patch_comment(comment_id: str, req: CommentPatch, claims: dict = Depends(auth.get_current_claims)):
    try:
        return comments_store.update(comment_id, claims, body=req.body,
                                     pinned=req.pinned, resolved=req.resolved,
                                     internal=req.internal)
    except KeyError:
        raise HTTPException(404, f"no comment {comment_id}")
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


# Supporting documents on a comment. The body is read in full before it is
# stored so the size limit is enforced on what actually arrived, not on a
# Content-Length header the client chose.
@app.post("/api/comments/{comment_id}/attachments")
async def post_attachment(comment_id: str, file: UploadFile = File(...),
                          claims: dict = Depends(auth.get_current_claims)):
    data = await file.read()
    try:
        return comments_store.attach(comment_id, claims, file.filename, data)
    except KeyError:
        raise HTTPException(404, f"no comment {comment_id}")
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/comments/{comment_id}/attachments/{attachment_id}")
def get_attachment(comment_id: str, attachment_id: str,
                   claims: dict = Depends(auth.get_current_claims)):
    try:
        path, record = comments_store.find_attachment(comment_id, attachment_id, claims)
    except KeyError:
        raise HTTPException(404, "no such document")
    except PermissionError as e:
        raise HTTPException(403, str(e))
    # served as an attachment, never inline - an uploaded file should download,
    # not render itself in the reviewer's tab
    return FileResponse(path, media_type=record["content_type"],
                        filename=record["filename"],
                        content_disposition_type="attachment")


@app.delete("/api/comments/{comment_id}")
def delete_comment(comment_id: str, claims: dict = Depends(auth.get_current_claims)):
    try:
        return comments_store.remove(comment_id, claims)
    except KeyError:
        raise HTTPException(404, f"no comment {comment_id}")
    except PermissionError as e:
        raise HTTPException(403, str(e))


class TranslateRequest(BaseModel):
    lang: str
    texts: list[str]


@app.post("/api/translate")
def post_translate(req: TranslateRequest, claims: dict = Depends(auth.get_current_claims)):
    """English -> `lang` for the DATA strings on whatever page the caller is
    showing (work descriptions, place/person/agency names) - the text that
    comes out of the source CSVs in English only, so the frontend's own
    hand-written UI string table can never cover it.

    No per-role access check: the caller has already been served these exact
    strings by the endpoint that returned the rows, so translating them
    reveals nothing new. Returns only what it could translate - anything
    missing from the map stays English on screen (see api/translate.py).
    """
    return translate_service.translate(req.texts, req.lang)


class PredictRiskRequest(BaseModel):
    amount: float
    state: str
    activity: str
    month: int | None = None      # unknown month stays unknown (NaN to the model), never a guessed one
    district: str | None = None


@app.post("/api/predict_risk")
def post_predict_risk(body: PredictRiskRequest):
    """Standalone, model-only endpoint - the raw predictive signal for any
    hypothetical (amount, state, activity, month[, district]), independent
    of any one real work. Mirrors the /api/work/{n}/ai_assessment inputs so a
    state/district authority can ask "what if" before a work is even
    recommended, not just review one that already exists. `district` and
    `month` are optional; a missing one is unknown to the model, not guessed."""
    return clean(predict_work_risk(
        amount=body.amount, state=body.state, activity=body.activity, month=body.month, district=body.district,
    ))


@app.get("/api/work/{work_number}/ai_assessment")
def get_work_ai_assessment(
    work_number: str, scope_house: str, scope_tenure: str,
    claims: dict = Depends(auth.get_current_claims),
):
    """Composite read on one work: the rule-based findings already on file,
    this work's own predicted delay risk (engine/predictive.py), the
    rule-agreement and anomaly scores (engine/risk_model.py - ranking aids
    that restate the rules, not an independent risk signal), and the
    constrained LLM narrative for the most severe finding. A value the models
    could not compute comes back as null, never a stand-in number."""
    s = get_store()
    work = s.work(work_number, scope_house, scope_tenure)
    if work is None:
        raise HTTPException(404, f"no work {work_number} in {scope_house}/{scope_tenure}")
    auth.check_work_access(claims, work)
    findings = s.findings_for_work(work_number, scope_house, scope_tenure)

    # every delay-model feature read from this work's own spine row, and its
    # workload context (same-letter batch, MP / district-authority inflow
    # before its recommendation date) from the full spine
    prediction = predict_work_risk(None, None, None, work=work, history=s.spine)
    rule_agreement = predict_risk_model(work)

    severity_rank = {"high": 3, "medium": 2, "low": 1}
    top_finding = max(findings, key=lambda f: severity_rank.get(f["severity"], 0), default=None)
    narrative = generate_narrative(top_finding) if top_finding else None

    return clean({
        "work_number": work_number,
        "rule_based_findings": [
            {"finding_id": f["finding_id"], "detector": f["detector"], "tag": f["tag"], "severity": f["severity"]}
            for f in findings
        ],
        "predicted_delay_risk": prediction,
        "rule_agreement": rule_agreement,
        "top_finding_narrative": narrative,
    })


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
    routed, headline = top_finding_lookup(s)
    ranked = [{
        "work_number": r["work_number"], "scope_house": r["scope_house"], "scope_tenure": r["scope_tenure"],
        "district": r.get("DISTRICT"),
        "tags": list(r["tags"]), "max_severity": r["max_severity"], "total_exposure": float(r["total_exposure"]),
        "priority": round(float(r["priority"]), 2),
        "routed_to": routed.get((r["work_number"], r["scope_house"], r["scope_tenure"]), None),
        "headline": headline.get((r["work_number"], r["scope_house"], r["scope_tenure"]), None),
        "work_description": r.get("work_description"),
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
            "risk_score": round(float(row["risk_score"]), 2),
            **stage_counts(sp),
            "completion_rate": completion_rate,
            "national_median_completion_rate": national_completion,
            "state_median_completion_rate": state_completion,
        },
        "category_breakdown": category_breakdown(sp, wr),
        "tag_summary": tag_summary(findings), "pipeline": pipeline_summary(sp, wr),
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
def get_state(
    state_name: str, scope: str = Query("18th Lok Sabha"), date_from: str | None = None, date_to: str | None = None,
    claims: dict = Depends(auth.require_role("state")),
):
    auth.check_entity(claims, state_name)
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
    delayed_by_district = f.loc[f["tag"].isin(TIMING_TAGS)].groupby("district")["work_number"].nunique()

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
    routed, headline = top_finding_lookup(s)
    queue = [{
        "work_number": r["work_number"], "scope_house": r["scope_house"], "scope_tenure": r["scope_tenure"],
        "district": r["DISTRICT"], "constituency": r["CONSTITUENCY"], "mp_name": r["MP_NAME"],
        "tags": list(r["tags"]), "max_severity": r["max_severity"], "total_exposure": float(r["total_exposure"]),
        "priority": round(float(r["priority"]), 2),
        "routed_to": routed.get((r["work_number"], r["scope_house"], r["scope_tenure"]), None),
        "headline": headline.get((r["work_number"], r["scope_house"], r["scope_tenure"]), None),
        "work_description": r.get("work_description"),
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
        "category_breakdown": category_breakdown(sp, wr),
        "tag_summary": tag_summary(f), "pipeline": pipeline_summary(sp, wr),
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
def get_mp(
    mp_name: str, scope: str = Query("18th Lok Sabha"), date_from: str | None = None, date_to: str | None = None,
    claims: dict = Depends(auth.require_role("mp")),
):
    auth.check_entity(claims, mp_name)
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
    wr = s.work_risk_for_scope(scope)
    wr = wr[wr["work_number"].isin(work_numbers)]
    # substantive only - see rollup.py's NON_SUBSTANTIVE_FAMILIES; a work
    # flagged only for a missing scan or a date-entry mismatch doesn't count
    # toward this MP's "works flagged" headline number.
    works_flagged = int(wr["is_substantive"].sum())
    sanctioned_n = int(sp["has_sanctioned"].sum())
    completed_n = int(sp["has_completed"].sum())
    completion_rate = float(completed_n / sanctioned_n * 100) if sanctioned_n else None

    # the seat's own engine risk_score (the constituency rollup), so the map
    # never has to derive one on the client - None if the seat has no row
    cr = s.constituency_risk_for_scope(scope)
    seat = cr[cr["CONSTITUENCY_ID"].astype("Int64").astype(str) == constituency_id] if constituency_id else cr.iloc[0:0]
    seat_risk_score = round(float(seat.iloc[0]["risk_score"]), 2) if len(seat) else None

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
            "risk_score": seat_risk_score,
            "delayed": delayed_count(mp_findings),
            **stage_counts(sp),
            "completion_rate": completion_rate,
        },
        "category_breakdown": category_breakdown(sp, wr),
        "tag_summary": tag_summary(mp_findings), "pipeline": pipeline_summary(sp, wr),
        "tag_breakdown": mp_findings["tag"].value_counts().to_dict(),
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
def get_district(
    state_name: str, district_name: str, scope: str = Query("18th Lok Sabha"),
    date_from: str | None = None, date_to: str | None = None,
    claims: dict = Depends(auth.get_current_claims),
):
    # a State Nodal Authority drills into its own districts (StateView.jsx's
    # own district panel), not just the district's own role dashboard or
    # MoSPI's drill-down - check_entity narrows a district token to its one
    # district, and a state token to just its own state (any district in it).
    if claims["role"] not in ("mospi", "district", "state"):
        raise HTTPException(403, "this endpoint requires the 'district', 'state', or 'mospi' role")
    if claims["role"] == "district":
        auth.check_entity(claims, f"{state_name}|{district_name}")
    elif claims["role"] == "state":
        auth.check_entity(claims, state_name)
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
    routed, headline = top_finding_lookup(s)
    queue = [{
        "work_number": r["work_number"], "scope_house": r["scope_house"], "scope_tenure": r["scope_tenure"],
        "constituency": r["CONSTITUENCY"], "mp_name": r["MP_NAME"], "tags": list(r["tags"]),
        "max_severity": r["max_severity"], "total_exposure": float(r["total_exposure"]),
        "priority": round(float(r["priority"]), 2),
        "routed_to": routed.get((r["work_number"], r["scope_house"], r["scope_tenure"]), None),
        "headline": headline.get((r["work_number"], r["scope_house"], r["scope_tenure"]), None),
        "work_description": r.get("work_description"),
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
    delayed_by_agency = (wr[wr["tags"].apply(lambda t: any(x in TIMING_TAGS for x in t))].groupby("exp_top_ia")["work_number"].nunique()
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
        # the engine's own agency rollup (engine/rollup.build_agency_risk),
        # run over just this district's works: substantive flagged count,
        # breach rate and risk_score per agency. Shrinkage uses the national
        # agency table's estimated prior strength - a handful of agencies in
        # one district is too few to estimate it from.
        scopes = SCOPES if scope == "all" else [scope]
        national_ar = s.agency_risk_for_scope(scope)
        m = float(national_ar["shrinkage_m"].iloc[0]) if "shrinkage_m" in national_ar and len(national_ar) else 50.0
        district_ar = rollup.build_agency_risk(wr.assign(in_demo_scope=True), sp, scopes,
                                               {**s.cfg, "rollup": {**s.cfg.get("rollup", {}), "shrinkage_m": m}})
        agency_risk = district_ar.set_index("agency")
        agency_performance = [{
            "agency": r["exp_top_ia"], "works_total": int(r["works_total"]), "completed": int(r["completed"]),
            "ongoing": int(r["ongoing"]), "delayed": int(delayed_by_agency.get(r["exp_top_ia"], 0)),
            "works_flagged": int(agency_risk.at[r["exp_top_ia"], "works_flagged"]) if r["exp_top_ia"] in agency_risk.index else 0,
            "breach_rate": round(float(agency_risk.at[r["exp_top_ia"], "breach_rate"]), 4) if r["exp_top_ia"] in agency_risk.index else None,
            "risk_score": round(float(agency_risk.at[r["exp_top_ia"], "risk_score"]), 2) if r["exp_top_ia"] in agency_risk.index else None,
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
        "category_breakdown": category_breakdown(sp, wr),
        "tag_summary": tag_summary(f), "pipeline": pipeline_summary(sp, wr),
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
def get_agency(
    agency_name: str, scope: str = Query("18th Lok Sabha"), date_from: str | None = None, date_to: str | None = None,
    claims: dict = Depends(auth.get_current_claims),
):
    # a District Authority routinely drills into an agency it doesn't
    # itself administer (DistrictView.jsx's own agency panel links here) -
    # any valid district token may view any agency's own aggregate
    # performance; restricting further would need a live membership check
    # against that district's own agency_performance table, more than this
    # pass's minimal auth needs.
    if claims["role"] not in ("mospi", "agency", "district"):
        raise HTTPException(403, "this endpoint requires the 'agency', 'district', or 'mospi' role")
    if claims["role"] == "agency":
        auth.check_entity(claims, agency_name)
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

    routed, headline = top_finding_lookup(s)
    queue = [{
        "work_number": r["work_number"], "scope_house": r["scope_house"], "scope_tenure": r["scope_tenure"],
        "state": r["STATE_NAME"], "district": r["DISTRICT"], "constituency": r["CONSTITUENCY"], "mp_name": r["MP_NAME"],
        "tags": list(r["tags"]), "max_severity": r["max_severity"], "total_exposure": float(r["total_exposure"]),
        "priority": round(float(r["priority"]), 2),
        "routed_to": routed.get((r["work_number"], r["scope_house"], r["scope_tenure"]), None),
        "headline": headline.get((r["work_number"], r["scope_house"], r["scope_tenure"]), None),
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
        "category_breakdown": category_breakdown(sp, wr),
        "tag_summary": tag_summary(f), "pipeline": pipeline_summary(sp, wr),
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


class FindingStatusUpdate(BaseModel):
    work_number: str
    scope_house: str
    scope_tenure: str
    status: Literal["verified", "dismissed", "under_investigation"]
    reviewer_name: str
    note: str | None = None


@app.get("/api/findings/status")
def get_finding_statuses():
    return clean({"items": finding_status_store.list_statuses()})


@app.post("/api/findings/{finding_id}/status")
def set_finding_status(finding_id: str, body: FindingStatusUpdate):
    s = get_store()
    findings = s.findings_for_work(body.work_number, body.scope_house, body.scope_tenure)
    if not any(f["finding_id"] == finding_id for f in findings):
        raise HTTPException(404, f"no finding '{finding_id}' on work {body.work_number}")
    if not body.reviewer_name.strip():
        raise HTTPException(400, "reviewer_name is required")
    return clean(finding_status_store.set_status(
        finding_id=finding_id, work_number=body.work_number, scope_house=body.scope_house,
        scope_tenure=body.scope_tenure, status=body.status,
        reviewer_name=body.reviewer_name.strip(), note=body.note,
    ))


@app.get("/api/alerts/latest")
def get_latest_alert_digest():
    digest = alerts_store.get_latest_digest()
    if digest is None:
        raise HTTPException(404, "no alert digest yet - run `python -m engine.export` at least once")
    return clean(digest)


# Comment mentions as alerts. A comment mentioning a desk alerts the office of
# that desk responsible for the work - the same check that decides who may
# open the case file - so "District Authority" on a Patna work reaches the
# Patna district desk and no other district.
_ROLE_NAME_FIELD = {"state": "STATE_NAME", "district": "DISTRICT", "mp": "MP_NAME", "agency": "exp_top_ia"}


@app.get("/api/mentions")
def get_mentions(limit: int = Query(20, ge=1, le=100), claims: dict = Depends(auth.get_current_claims)):
    store = get_store()
    seen_at = comments_store.mentions_seen_at(claims)
    name_field = _ROLE_NAME_FIELD.get(claims["role"])
    items = []
    for row in comments_store.mentions_for(claims):
        work = store.work(row["work_number"], row["scope_house"], row["scope_tenure"])
        if work is None:
            continue
        try:
            auth.check_work_access(claims, work)
        except HTTPException:
            continue
        items.append({
            "comment_id": row["id"],
            "work_number": row["work_number"],
            "scope_house": row["scope_house"],
            "scope_tenure": row["scope_tenure"],
            "author_role": comments_store.MENTIONABLE_ROLES.get(row["author_role"], row["author_role"]),
            "author_entity": (str(row["author_entity"]).split("|")[-1] if row.get("author_entity") else None),
            "body": row["body"][:200],
            "created_at": row["created_at"],
            "unread": seen_at is None or row["created_at"] > seen_at,
            "constituency": work.get("CONSTITUENCY"),
            "district": work.get("DISTRICT"),
            "state": work.get("STATE_NAME"),
            # what the desk's own case-file links carry as role_name
            "role_name": work.get(name_field) if name_field else None,
        })
    return clean({"items": items[:limit], "total": len(items),
                  "unread": sum(1 for i in items if i["unread"])})


@app.post("/api/mentions/seen")
def post_mentions_seen(claims: dict = Depends(auth.get_current_claims)):
    return {"seen_at": comments_store.mark_mentions_seen(claims)}


@app.get("/")
def root():
    return {"service": "MPLADS Anomaly Review API", "docs": "/docs"}
