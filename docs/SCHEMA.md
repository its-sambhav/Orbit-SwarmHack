# MPLADS Data Schema & Pipeline Ground Truth

This documents what ingest/normalise/link found by direct profiling of the
six source CSVs, and the decisions that follow. For data provenance and the
two added `SCOPE_*` columns, read `README.md` first — not repeated here.

## The join key is a composite, not a single column

`WORK_RECOMMENDATION_DTL_ID` is the only cross-table identifier, but it is
**not globally unique in `works_recommended.csv`**: low ID numbers collide
across `SCOPE_HOUSE`/`SCOPE_TENURE` (e.g. ID `1437` is simultaneously an
unrelated 18th-LS 2025 community-hall recommendation and an already-sanctioned
RS-Sitting 2023 street-lighting work). 2,290 rows share a bare ID with
another row (1,145 "excess" beyond first occurrence). `works_sanctioned.csv`,
`works_completed.csv`, and aggregated `expenditure...csv` each verified to
have zero cross-scope collisions — but joining them to `recommended` on bare
ID would still be wrong, since the collision lives on the `recommended` side.

**The engine's real primary/join key everywhere:**

    WORK_KEY = (WORK_RECOMMENDATION_DTL_ID, SCOPE_HOUSE, SCOPE_TENURE)

Deduplicating `recommended` on `WORK_KEY` brings 254,534 rows to 254,363
distinct keys — 342 rows (171 genuine residual pairs) remain duplicated even
within one exact scope, believed to be live-database drift between fetch
retries (README caveat 5). Tie-break: prefer the row with non-null
`SANCTION_DATE`, then higher `Sno`, keep first, log the drop count.

`expenditure.WORK_RECOMMENDATION_DTL_ID` is not unique (178,839 distinct /
279,739 rows) purely because a work has multiple disbursement rows — zero
cross-scope collisions there, safe to resolve with `groupby(WORK_KEY).sum()`
before joining.

`completed.WORK_ID` and `expenditure.WORK_ID` are both unrelated to each
other and to `WORK_RECOMMENDATION_DTL_ID`. `expenditure.WORK_ID` is
mechanically the trailing number of `WORK_KEY`'s ID component;
`completed.WORK_ID` is a small unrelated internal integer. Neither is used
for joining.

## Lifecycle spine coverage (recompute every run, never hardcode)

| Edge | Coverage | Reading |
|---|---:|---|
| `sanctioned → recommended` | 99.502% (215,233/216,310) | ~0.5% genuine orphans |
| `completed → sanctioned` | 100.000% | every completed work is sanctioned |
| `expenditure → sanctioned` | 100.000% | every disbursed work is sanctioned |
| `expenditure → completed` | 72.667% | expected — expenditure covers ongoing work too |

`completed`/`expenditure` are always subsets of `sanctioned`, so
**`recommended ∪ sanctioned` is the entire universe** (254,363 + 1,077 =
255,440 keys). The spine roots at that **union**, not at `recommended`
alone — rooting at `recommended` would silently drop the 1,077
sanctioned-but-never-recommended works, some of the most irregular records
in the dataset. Source database is live (README caveat 5); print, don't
hardcode.

Note on `expenditure → completed`: the 72.667% above is a **row-level**
figure (what fraction of 279,739 raw disbursement rows belong to a
completed work). `link.py` prints a **work-level** figure instead (what
fraction of 178,839 distinct expenditure-linked works are completed) —
verified at 74.188%, not a bug. They differ because not-yet-completed works
average more disbursement rows each (1.656) than completed ones (1.532),
so the two denominators weight works differently. Expect ~1–2pp of gap
between this document and a live run for that specific edge; the other
three coverage edges match to 3 decimal places since they're not sensitive
to this effect.

## Status / stage vocabulary

- `WORK_STAGE` (`recommended`+`sanctioned`): `Physical Inspection`,
  `Pending for Sanction`, `Vendor Identification`,
  `Work partially Completed`, `Work Completed` (terminal), `Time Estimation`,
  or null (`recommended` only, 1,385 rows = withdrawn). No
  `"Forwarded to Implementing District"` value exists in this data.
- `WORK_STATUS` (`expenditure` only): `Payment Success` (274,390) /
  `Payment In-Progress` (5,349) — the dataset's real payment-state field;
  there is no separate `PAYMENT_STATUS` column.
- `FLAG` correlates 1:1 with null `WORK_STAGE`, no independent signal, unused.
- `FILE_STATUS` (only non-null value is literally `True`) is 100%
  co-null/co-populated with `ATTACH_ID`. Populated means "some file is
  attached" — **nothing in this dataset confirms the file is a photo, or
  verifies its content.** This caveat is carried verbatim into every
  `GHOST_ASSET` finding.

## Geography

Only `STATE_NAME`, `CONSTITUENCY` (name), `CONSTITUENCY_ID` (numeric,
stable) exist — zero `DISTRICT`/LGD fields anywhere, confirmed.
`CONSTITUENCY_ID` exists only in recommended/sanctioned/completed — absent
from expenditure/allocated/calamity. Every work in the spine is guaranteed
a non-null `CONSTITUENCY_ID`, because the spine roots at `recommended ∪
sanctioned` and both of those tables carry the column — coalesce
`rec_CONSTITUENCY_ID.fillna(san_CONSTITUENCY_ID).fillna(comp_CONSTITUENCY_ID)`
(values verified identical across tables for the same constituency).
`entities.district`/`lgd_code` are always `null` — never fabricated.

## `allocated_limit_for_hon_ble_mps.csv`

One lifetime row per `(MP_NAME, SCOPE_TENURE)`, confirmed — never >1 row per
group. Not broken out by financial year.

## Peer-grouping key: `ACTIVITY_NAME` cleanup

No `WORK_NAME` column exists. `WORK_CATEGORY` is a clean but too-coarse
4-value picklist (98.2% in `Normal/Others`). `ACTIVITY_NAME` is contaminated
with a prepended work-identifier in most rows:

    ACTIVITY_PREFIX_RE = r'^(?:WS/\t?\s*[A-Z]+\d+/\d{4}-\d{4}/\d+|NA)-'

(Generalized from a naive `MP\d+`-only pattern, which misses non-`MP` member
codes like `EXLS003` and, because the untouched string still carries the
row's unique trailing work-ID, turns each miss into a spurious singleton
category.) This regex achieves **exactly 100.000%** strip rate on
`recommended`/`sanctioned`/`completed`, verified directly; `expenditure`'s
copy is already clean (0% match, harmless no-op). After stripping, the real
category vocabulary is small and stable: recommended 122, sanctioned 121,
completed 114, expenditure 120. **`ACTIVITY_NAME_CLEAN` is the correct
peer-grouping key** for any future cost/outlier detector.

## Entity resolution targets (Slice 2 — normalisation only in Slice 1)

- **`VENDOR_NAME`** (`expenditure` only, 68,733 distinct raw, 0% null): real
  duplication confirmed (`SS CONSTRUCTION`/`Ss Construction`/
  `S S CONSTRUCTION`/`S S Construction`/`ss construction` etc. — one vendor,
  many spellings; ~7,214 rows carry an `M/S`-style prefix). **`VENDOR_ID` is
  not a usable shortcut** — verified it has *more* distinct values than
  `VENDOR_NAME` (76,445 vs 68,733), and `"S S CONSTRUCTION"` alone maps to 5
  different `VENDOR_ID`s. Fuzzy clustering deferred to Slice 2 — no Group A
  detector needs it; Slice 1 only normalises spelling (case/punctuation/
  `M/S`-prefix/whitespace), it does not merge distinct spellings together.
- **`IA_NAME`** (`expenditure` only, 13,073 distinct, 0% null): specific
  implementing engineering office, different from `IDA_NAME`/`VENDOR_NAME`.
  Same treatment as `VENDOR_NAME` — normalised in Slice 1, clustered in
  Slice 2.
- **`IDA_NAME`** (district sanctioning authority, ~775–779 distinct, 0%
  null, pattern `DISTRICT(TITLE DISTRICT_IDA)`): has a stable
  `MAGISTRAE`/`MAGISTRATE` misspelling that never collides within one
  district. Whitespace normalisation only, no fuzzy clustering planned even
  in Slice 2 — not worth the effort the other two targets warrant.

## Dates

`RECOMMENDATION_DATE`, `SANCTION_DATE` (both tables), `EXPENDITURE_DATE`,
`CRT_DT`, `ACTUAL_END_DATE`: format `%d-%b-%Y`, 100% parseable.
`TENURE_START_DATE`/`TENURE_END_DATE`: format `%b %d, %Y %I:%M:%S %p`.
`RECOMMENDATION_DATE` is 0% null in both tables. `SANCTION_DATE` is 15.44%
null in `recommended` (not-yet-sanctioned rows) but 0% null in `sanctioned`
— the spine uses **`sanctioned`'s copy as sole authoritative source**;
`recommended`'s own copies are carried through with a `rec_` prefix for
audit only, never used downstream.

## Amounts

No negatives anywhere. `SANCTION_AMOUNT` appears in both `recommended` and
`sanctioned`; cross-checked 100% identical wherever both populated — spine
uses `sanctioned`'s copy as authoritative, same rule as `SANCTION_DATE`.
Zero-amount rows exist (7 in `SANCTION_AMOUNT`, 12 in `ALLOCATED_AMT`) —
small, not a headline finding on their own.

## `AVERAGE_RATING` (`completed` only)

99.996% are literal `0.0` — functionally unrated, not a real low score.
Treat `0.0` as missing in any logic touching it. No Group A detector uses
this field.

## `_totals.csv` — known issues in the validation file itself

32 rows describe 25 distinct `(TABLE,HOUSE,TENURE)` combos after exact
dedup. **One pair is not an exact duplicate**: `expenditure/Rajya
Sabha/Sitting` appears as both `12,521,502,410.69` and `12,521,582,470.69` —
a genuine ₹80,060 disagreement inside the totals file itself, verified.
Ingest's validator dedupes exact matches and flags this one pair as a
warning, not a silent pick-one-and-move-on. The README's documented 17th-LS
`works_recommended` +9-row/+0.009% drift (sums match exactly, rows added to
source after snapshot) is a pre-classified pass, not a new failure.

## Other confirmed quirks (informational)

- `Total_Amt` is 100% blank on every data row by construction — dropped at
  ingest.
- `HOUSE_OF_PARLIAMENT` (numeric: `2`=Lok Sabha, `1`=Rajya Sabha) is
  confirmed **not** redundant with `SCOPE_HOUSE` — kept as-is.

## Severity bucket calibration (added after review)

Original bucket edges (90/180/730/1460 days) were guesses. Recalibrated
against each detector's **actual hit distribution** on the real spine
(`as_of = 2026-09-10`, all-scope). Edges are each detector's own p50 (→
low/medium boundary) and p90 (→ medium/high boundary) — this targets
roughly a 50%/40%/10% low/medium/high split within each detector's hits,
so severity actually discriminates instead of collapsing into one bucket:

| Detector | n (all-scope hits) | p50 | p90 | Buckets used |
|---|---:|---:|---:|---|
| `STALLED_AT_SANCTION` (age_since_recommendation) | 26,960 | 214 | 917 | low≤214, medium≤917, high>917 |
| `SANCTION_DELAY` (sanction_delay_days) | 146,778 | 127 | 387 | low≤127, medium≤387, high>387 |
| `STALLED_AT_EXECUTION` (age_since_sanction) | 37,201 | 695 | 969 | low≤695, medium≤969, high>969 |
| `EXECUTION_DELAY` (execution_delay_days) | 37,219 | 537 | 786 | low≤537, medium≤786, high>786 |
| `PAID_NOT_COMPLETE` (age_since_sanction) | 25,519 | 716 | 976 | low≤716, medium≤976, high>976 |
| `STUCK_STATUS` (age_since_recommendation, narrowed population) | 93,761 | 994 | 1121 | low≤994, medium≤1121, high>1121 |

`GHOST_ASSET` and the three `TEMPORAL_*` detectors stay fixed `severity:
high` — they're binary guideline violations, not magnitude-continuous, so a
percentile bucket doesn't apply. These numbers move on a data refresh; if
recalibrating later, rerun the same p50/p90 computation, don't hand-edit.

## Detector volumes (verified during planning, all-scope unless noted)

For reference — the pipeline recomputes these on every run, they are not
hardcoded anywhere in the code:

| Detector | All-scope hits | In-scope hits (18th LS + RS Sitting) |
|---|---:|---:|
| `STALLED_AT_SANCTION` | 26,960 | 21,650 |
| `SANCTION_DELAY` | 146,778 | 69,162 |
| `STALLED_AT_EXECUTION` | 37,201 | 13,832 |
| `EXECUTION_DELAY` | 37,219 | 5,673 |
| `TEMPORAL_SANCTION_BEFORE_RECOMMENDATION` | 0 | 0 |
| `TEMPORAL_COMPLETION_BEFORE_SANCTION` | 0 | 0 |
| `TEMPORAL_PAYMENT_BEFORE_SANCTION` | 1 | 0 |
| `GHOST_ASSET` | 39,566 | 12,743 |
| `PAID_NOT_COMPLETE` | 25,519 | 9,472 |
| `STUCK_STATUS` (narrowed) | 93,761 | 6,145 |

Total works with ≥1 finding: 220,905 / 255,440 = 86.5% all-scope breach
rate; 101,740 / 133,484 = 76.2% in-scope. This is why the rollup layer
(`work_risk.parquet`, `constituency_risk.parquet`) and the demo-scoped,
materiality-floored, capped queue exist — raw per-finding output is a
correct detection result and an unusable review queue at this volume.
