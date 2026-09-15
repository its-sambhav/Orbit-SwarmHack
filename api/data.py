"""Loads every precomputed engine output into memory once at process start.

Nothing is computed at request time beyond pandas filtering over
already-materialised data - the engine (engine/run_pipeline.py) does the real
work offline. ~250K-400K rows of tabular data is small enough to hold in
memory for a prototype's traffic.

Two things are precomputed here rather than per-request:
1. constituency_risk for each of the 5 possible scope values (4 scopes +
   "all"). The API needs the dashboard's 4-way scope toggle, which the fixed
   precomputed constituency_risk.parquet (locked to the demo-scopes union)
   can't serve - re-running rollup.py's own aggregation functions per scope
   is correct, but doing it INSIDE a request handler measured at 3+ seconds
   (a full groupby over 407K findings with custom list/dict aggregations) -
   slow enough to look like a hung request. There are only 5 possible scope
   values, so computing all 5 once at startup is strictly better than
   memoising lazily per-request.
2. A (work_number, scope_house, scope_tenure) index on spine/findings, so a
   case-file lookup is a dict/index hit instead of a boolean mask over the
   full table on every request.
"""
import json
import threading

import pandas as pd

from engine.paths import DATA_FINDINGS, DATA_PROCESSED, DATA_INTERIM, ROOT
from engine.detectors import load_config
from engine import rollup
from api.sector_categories import categorize_activity

GEO_DIR = ROOT / "data" / "geo"

# Lok Sabha only - Rajya Sabha is out of scope for this project, filtered
# at engine/ingest.py before any downstream stage (including this API) ever
# sees it.
SCOPES = ["18th Lok Sabha", "17th Lok Sabha"]
SCOPE_LABELS = {"18th Lok Sabha": "18th Lok Sabha", "17th Lok Sabha": "17th Lok Sabha"}


class Store:
    def __init__(self):
        self.cfg = load_config()
        self.spine = pd.read_parquet(DATA_PROCESSED / "spine.parquet")
        self.findings = pd.read_parquet(DATA_FINDINGS / "findings.parquet")
        self.work_risk = pd.read_parquet(DATA_FINDINGS / "work_risk.parquet")
        self.allocated = pd.read_parquet(DATA_INTERIM / "allocated.parquet")

        # findings' entities/evidence columns come back as dicts via pyarrow -
        # explode the fields the API filters/reads on most into flat columns
        # once, instead of re-parsing a dict per request.
        self.findings["scope_house"] = self.findings["entities"].apply(lambda e: e["scope_house"])
        self.findings["scope_tenure"] = self.findings["entities"].apply(lambda e: e["scope_tenure"])
        self.findings["state"] = self.findings["entities"].apply(lambda e: e["state"])
        self.findings["constituency_id"] = self.findings["entities"].apply(lambda e: e["constituency_id"])

        self.spine["work_number"] = self.spine["WORK_RECOMMENDATION_DTL_ID"].astype("int64").astype(str)

        # sector bucket for the "Project Lifecycle & Risk Breakdown" chart -
        # derived from ACTIVITY_NAME_CLEAN (whichever stage's copy of it
        # exists first; one work has the same activity at every stage it
        # reaches), not the near-useless 4-value WORK_CATEGORY column (98.4%
        # "Normal/Others" - see docs/SCHEMA.md). See api/sector_categories.py
        # for the category definitions and how each real activity maps to one.
        activity = self.spine["rec_ACTIVITY_NAME_CLEAN"] \
            .fillna(self.spine["san_ACTIVITY_NAME_CLEAN"]) \
            .fillna(self.spine["comp_ACTIVITY_NAME_CLEAN"])
        self.spine["CATEGORY"] = activity.apply(categorize_activity)

        # entities.district stays a deliberate null on every finding (no real
        # LGD-style district field exists - see docs/SCHEMA.md) - the derived
        # DISTRICT (parsed from IDA_NAME) lives on the spine instead, so it's
        # never confused with a real district code. Join it in here by key.
        district_lookup = self.spine.set_index(["work_number", "SCOPE_HOUSE", "SCOPE_TENURE"])["DISTRICT"]
        self.findings["district"] = self.findings.set_index(
            ["work_number", "scope_house", "scope_tenure"]
        ).index.map(district_lookup)

        # the date filter (report generator, map/overview date-range control)
        # filters on recommendation date - the one date field present on
        # essentially every spine row (unlike sanction/completion dates, which
        # only exist once a work reaches that stage). Joined onto work_risk/
        # findings the same way DISTRICT is above, so a date-range request
        # only needs a cheap boolean mask, never a recompute of this join.
        date_lookup = self.spine.set_index(["work_number", "SCOPE_HOUSE", "SCOPE_TENURE"])["rec_RECOMMENDATION_DATE"]
        self.work_risk["date"] = self.work_risk.set_index(
            ["work_number", "scope_house", "scope_tenure"]
        ).index.map(date_lookup)

        # same join, for the high-risk slice of the sector breakdown - work_risk
        # only carries flagged works, so its own CATEGORY has to come from the
        # spine the same way DISTRICT/date do above.
        category_lookup = self.spine.set_index(["work_number", "SCOPE_HOUSE", "SCOPE_TENURE"])["CATEGORY"]
        self.work_risk["category"] = self.work_risk.set_index(
            ["work_number", "scope_house", "scope_tenure"]
        ).index.map(category_lookup)

        self.findings["date"] = self.findings.set_index(
            ["work_number", "scope_house", "scope_tenure"]
        ).index.map(date_lookup)
        self.date_min = self.spine["rec_RECOMMENDATION_DATE"].min()
        self.date_max = self.spine["rec_RECOMMENDATION_DATE"].max()

        crosswalk_path = GEO_DIR / "constituency_crosswalk.json"
        self.crosswalk: dict[str, int] = json.loads(crosswalk_path.read_text()) if crosswalk_path.exists() else {}

        geojson_path = GEO_DIR / "india_pc_2019_simplified.geojson"
        self.geojson = json.loads(geojson_path.read_text()) if geojson_path.exists() else None

        # dissolved one-polygon-per-district boundaries (engine/geo_dissolve.py),
        # loaded once and indexed for O(1) lookup - a district's page needs
        # exactly one feature out of ~800, so it's served directly from a
        # request rather than making the client fetch the whole (~9MB) file
        # and filter it client-side for a single shape.
        district_geo_path = GEO_DIR / "india_districts_simplified.geojson"
        self._district_boundary: dict[tuple[str, str], dict] = {}
        if district_geo_path.exists():
            for f in json.loads(district_geo_path.read_text())["features"]:
                key = (f["properties"]["state"].casefold(), f["properties"]["district"].casefold())
                self._district_boundary[key] = f

        self.demo_scopes = self.cfg["queue"]["demo_scopes"]

        # O(1) case-file lookups instead of a boolean mask over 255K/407K rows.
        self._spine_by_key = {
            (r.work_number, r.SCOPE_HOUSE, r.SCOPE_TENURE): r._asdict()
            for r in self.spine.itertuples()
        }
        self._findings_by_key: dict[tuple, list[dict]] = {}
        for rec in self.findings.to_dict("records"):
            key = (rec["work_number"], rec["scope_house"], rec["scope_tenure"])
            self._findings_by_key.setdefault(key, []).append(rec)

        # work_risk's own groupby (tags/severity/exposure/priority per work)
        # doesn't depend on which scope is "in demo scope" - only the
        # in_demo_scope boolean column does. Build the groupby once, then just
        # re-stamp that one column per scope before handing it to the 3
        # rollup-level builders (constituency/district/state), instead of
        # re-running the full findings groupby 5x for identical output.
        base_work_risk = rollup.build_work_risk(self.findings, self.spine, self.demo_scopes)
        self._constituency_risk_by_scope: dict[str, pd.DataFrame] = {}
        self._district_risk_by_scope: dict[str, pd.DataFrame] = {}
        self._state_risk_by_scope: dict[str, pd.DataFrame] = {}
        self._agency_risk_by_scope: dict[str, pd.DataFrame] = {}
        for scope in [*SCOPES, "all"]:
            scopes = [scope] if scope != "all" else SCOPES
            wr = base_work_risk.assign(in_demo_scope=base_work_risk["scope_tenure"].isin(scopes))
            self._constituency_risk_by_scope[scope] = rollup.build_constituency_risk(wr, self.spine, scopes)
            self._district_risk_by_scope[scope] = rollup.build_district_risk(wr, self.spine, scopes)
            self._state_risk_by_scope[scope] = rollup.build_state_risk(wr, self.spine, scopes)
            self._agency_risk_by_scope[scope] = rollup.build_agency_risk(wr, self.spine, scopes)

        self.mp_directory = self._build_mp_directory()

    def _build_mp_directory(self) -> pd.DataFrame:
        """One row per (MP_NAME, SCOPE_TENURE) - allocated.parquet is the
        canonical MP roster (one lifetime row per MP per tenure, verified in
        docs/SCHEMA.md), joined with real aggregate stats from spine/work_risk.
        No separate MP-status field exists anywhere in the source data (no
        "deceased"/"retired" flag) - status is the one honestly derivable
        signal: whether this exact MP_NAME also holds an 18th Lok Sabha seat
        (Active) or only ever held the 17th Lok Sabha one (Former). It is
        never asserted as anything more specific (e.g. cause of a seat
        change) than that, since the data doesn't support a stronger claim."""
        sp = self.spine
        rec_amt = sp["rec_RECOMMENDED_AMOUNT"].where(sp["has_recommended"])
        san_amt = sp["SANCTION_AMOUNT"].where(sp["has_sanctioned"])
        comp_amt = sp["comp_ACTUAL_AMOUNT"].where(sp["has_completed"])
        grouped = sp.assign(_rec_amt=rec_amt, _san_amt=san_amt, _comp_amt=comp_amt).groupby(
            ["MP_NAME", "SCOPE_TENURE"], as_index=False
        ).agg(
            state=("STATE_NAME", "first"), constituency=("CONSTITUENCY", "first"),
            works_total=("WORK_RECOMMENDATION_DTL_ID", "size"),
            recommended=("has_recommended", "sum"), recommended_amount=("_rec_amt", "sum"),
            sanctioned=("has_sanctioned", "sum"), sanctioned_amount=("_san_amt", "sum"),
            completed=("has_completed", "sum"), completed_amount=("_comp_amt", "sum"),
            paid=("exp_total_disbursed", "sum"),
        )

        wr_grouped = self.work_risk.groupby(["MP_NAME", "scope_tenure"], as_index=False).agg(
            works_flagged=("work_number", "nunique"), total_exposure=("total_exposure", "sum"),
        ).rename(columns={"scope_tenure": "SCOPE_TENURE"})

        directory = grouped.merge(wr_grouped, on=["MP_NAME", "SCOPE_TENURE"], how="left")
        directory["works_flagged"] = directory["works_flagged"].fillna(0).astype(int)
        directory["total_exposure"] = directory["total_exposure"].fillna(0.0)
        directory["breach_rate"] = directory["works_flagged"] / directory["works_total"].replace(0, pd.NA)

        alloc = self.allocated[["MP_NAME", "SCOPE_TENURE", "ALLOCATED_AMT", "TENURE_START_DATE", "TENURE_END_DATE"]]
        directory = directory.merge(alloc, on=["MP_NAME", "SCOPE_TENURE"], how="left")

        active_names = set(self.allocated.loc[self.allocated["SCOPE_TENURE"] == "18th Lok Sabha", "MP_NAME"])
        directory["status"] = directory.apply(
            lambda r: "Active" if r["SCOPE_TENURE"] == "18th Lok Sabha" or r["MP_NAME"] in active_names else "Former",
            axis=1,
        )
        return directory

    def findings_for_scope(self, scope: str | None) -> pd.DataFrame:
        if not scope or scope == "all":
            return self.findings
        return self.findings[self.findings["scope_tenure"] == scope]

    def spine_for_scope(self, scope: str | None) -> pd.DataFrame:
        if not scope or scope == "all":
            return self.spine
        return self.spine[self.spine["SCOPE_TENURE"] == scope]

    def work_risk_for_scope(self, scope: str | None) -> pd.DataFrame:
        if not scope or scope == "all":
            return self.work_risk
        return self.work_risk[self.work_risk["scope_tenure"] == scope]

    def constituency_risk_for_scope(self, scope: str) -> pd.DataFrame:
        return self._constituency_risk_by_scope.get(scope, self._constituency_risk_by_scope["all"])

    def district_risk_for_scope(self, scope: str) -> pd.DataFrame:
        return self._district_risk_by_scope.get(scope, self._district_risk_by_scope["all"])

    def state_risk_for_scope(self, scope: str) -> pd.DataFrame:
        return self._state_risk_by_scope.get(scope, self._state_risk_by_scope["all"])

    def agency_risk_for_scope(self, scope: str) -> pd.DataFrame:
        return self._agency_risk_by_scope.get(scope, self._agency_risk_by_scope["all"])

    def risk_tables(self, scope: str, date_from: str | None = None, date_to: str | None = None):
        """(spine, work_risk, state_risk, district_risk, constituency_risk) for
        this scope, each narrowed to [date_from, date_to] on recommendation
        date when given. With no date filter this is the startup-precomputed
        fast path (unchanged behaviour); with one, it's the same
        rollup.build_*_risk() aggregation the offline pipeline uses, just
        re-run here over an already-small (~255K/~220K row) date-filtered
        slice - not a recompute of the expensive findings groupby, which
        doesn't depend on date and stays untouched."""
        scopes = SCOPES if scope == "all" else [scope]
        if not date_from and not date_to:
            return (
                self.spine_for_scope(scope), self.work_risk_for_scope(scope),
                self._state_risk_by_scope.get(scope, self._state_risk_by_scope["all"]),
                self._district_risk_by_scope.get(scope, self._district_risk_by_scope["all"]),
                self._constituency_risk_by_scope.get(scope, self._constituency_risk_by_scope["all"]),
            )
        spine, wr = self.spine, self.work_risk
        if date_from:
            spine = spine[spine["rec_RECOMMENDATION_DATE"] >= pd.Timestamp(date_from)]
            wr = wr[wr["date"] >= pd.Timestamp(date_from)]
        if date_to:
            spine = spine[spine["rec_RECOMMENDATION_DATE"] <= pd.Timestamp(date_to)]
            wr = wr[wr["date"] <= pd.Timestamp(date_to)]
        wr = wr.assign(in_demo_scope=wr["scope_tenure"].isin(scopes))
        state_risk = rollup.build_state_risk(wr, spine, scopes)
        district_risk = rollup.build_district_risk(wr, spine, scopes)
        constituency_risk = rollup.build_constituency_risk(wr, spine, scopes)
        return spine, wr[wr["in_demo_scope"]], state_risk, district_risk, constituency_risk

    def work(self, work_number: str, scope_house: str, scope_tenure: str) -> dict | None:
        return self._spine_by_key.get((work_number, scope_house, scope_tenure))

    def findings_for_work(self, work_number: str, scope_house: str, scope_tenure: str) -> list[dict]:
        return self._findings_by_key.get((work_number, scope_house, scope_tenure), [])

    def district_boundary(self, state: str, district: str) -> dict | None:
        return self._district_boundary.get((state.casefold(), district.casefold()))



_store: Store | None = None
_store_lock = threading.Lock()


def get_store() -> Store:
    """FastAPI's normal `def` (non-async) route handlers each run on a
    worker thread, so without this lock two requests landing before the
    first Store() finishes (e.g. the frontend's own handful of parallel
    fetches on first load) would both see `_store is None` and both start
    building it concurrently - racing on the same parquet reads and roughly
    doubling the already-slow one-time load. Double-checked locking: the
    lock is only ever taken on that first, slow build; every request after
    that reads the already-set `_store` with no locking overhead."""
    global _store
    if _store is None:
        with _store_lock:
            if _store is None:
                _store = Store()
    return _store
