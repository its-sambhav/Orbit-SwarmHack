# MPLADS Dashboard Dataset

Complete extract of all six tables behind the MPLADS public dashboard
(<https://mplads.mospi.gov.in/digigov/dashboard.html>), Ministry of Statistics
and Programme Implementation, Government of India.

**Snapshot taken:** 2026-09-10, ~00:15–01:20 IST.

**Project scope note:** the CSVs below are the full original fetch (all four
scopes, Lok Sabha and Rajya Sabha both) and are kept as-is for provenance.
The processing pipeline (`engine/`) and dashboards only cover **17th and
18th Lok Sabha** — Rajya Sabha rows are filtered out at the ingest stage
(`engine/ingest.py`) before any other stage sees them. See `docs/SCHEMA.md`
for the pipeline's own documentation of this.

## Why this exists

The dashboard's own CSV export fails in-browser: each table is served as one
un-paginated JSON response (up to ~110 MB, 60–200 s), which the page's XHR
gives up on. Fetched server-side with a long timeout, the same endpoint works.

## Source

    POST /rest/PreLoginDashboardData/getTilesReportData
    {"combo": "<state>,<constituency>,<mp>,<house>[,<tenure>]", "key": "<tile name>"}

`0` = All. `house`: `2` Lok Sabha, `1` Rajya Sabha.
`tenure`: `7` 18th LS, `5` 17th LS, `1` RS Sitting, `2` RS Retired.

The dashboard shows **one house + tenure at a time**. The default view is 18th
Lok Sabha only — roughly 42% of the data. All four scopes are swept here.

## Files

| file | records | scopes |
|---|---:|---|
| `works_recommended.csv` | 254,534 | 4 |
| `expenditure_on_completed_and_on_going_works_as_on_date.csv` | 279,739 | 4 |
| `works_sanctioned.csv` | 216,310 | 4 |
| `works_completed.csv` | 133,046 | 4 |
| `allocated_limit_for_hon_ble_mps.csv` | 1,566 | 4 |
| `amount_consented_for_calamity.csv` | 33 | 4 |
| `_totals.csv` | 32 | grand totals for validation |
| | **885,228** | |

## Provenance — read this before analysing

Every field value is **verbatim** from the API. Nothing is computed, imputed,
joined or enriched. Exactly **two columns were added**:

- `SCOPE_HOUSE` — which house was queried (`Lok Sabha` / `Rajya Sabha`)
- `SCOPE_TENURE` — which tenure filter was queried
  (`18th Lok Sabha`, `17th Lok Sabha`, `Sitting`, `Retired`)

Without these the four scopes are indistinguishable once merged into one file.

### `SCOPE_TENURE` vs `TENURE` — they are different things

Four tables also carry a **native** `TENURE` field from the API. It is *not*
the same as `SCOPE_TENURE`, and the dashboard renders it under the heading
**"Elected/Nominated"**:

| `SCOPE_TENURE` (query filter) | native `TENURE` (member type) |
|---|---|
| `18th Lok Sabha` / `17th Lok Sabha` | same value |
| `Sitting` / `Retired` | `Sitting MP` or `Nominated Rajya Sabha` |

So for Rajya Sabha: `SCOPE_TENURE` tells you whether the member is currently
sitting or retired; `TENURE` tells you whether they were elected or nominated.
`works_completed` and `amount_consented_for_calamity` have no native `TENURE`.

## Caveats

1. **`WORK_DESCRIPTION` contains embedded newlines.** Use a real CSV parser.
   `wc -l` over-counts by ~12% (885,228 records vs 964,933 physical lines).
   `pandas.read_csv` and Python's `csv` module handle it correctly.

2. **`Total_Amt` is blank on every data row.** The API appended one grand-total
   row per scope with all other fields empty. Those rows are removed from the
   tables and collected in `_totals.csv` — leaving them in would inflate counts
   and break group-bys. The column itself is kept for fidelity.

3. **Encoding.** The API serves `ISO-8859-1`; files are written UTF-8 with BOM
   so Excel opens them correctly.

4. **Numeric formatting.** JSON floats are re-serialised, so `448127.00` in the
   payload appears as `448127.0`. Values are unchanged; only the text differs.

5. **The source database is live.** Row counts drift between calls. One scope
   refetched minutes later returned one extra row.

## Validation

Two independent server-side checks per scope: record count against the
dashboard tile, and `sum(amount)` against the API's own `Total_Amt`.

**23 of 24 scopes match exactly on both.**

The exception is `works_recommended` / 17th Lok Sabha: 94,745 records captured
against a live tile count of 94,754 (9 more, +0.009%). The captured rows sum to
44,464,960,511.47, which equals that payload's own `Total_Amt` **exactly** —
so nothing was lost in transfer; those 9 works were added to the source after
this snapshot was taken.

| amount column | table |
|---|---|
| `ALLOCATED_AMT` | allocated_limit |
| `FUND_DISBURSED_AMT` | expenditure |
| `RECOMMENDED_AMOUNT` | works_recommended |
| `SANCTION_AMOUNT` | works_sanctioned |
| `ACTUAL_AMOUNT` | works_completed |
| `CONSENTED_AMOUNT` | calamity |

All amounts are in rupees.
