"""Stage 7: persist findings.jsonl / findings.parquet / work_risk.parquet /
constituency_risk.parquet / mplads.duckdb (one table per parquet file).
"""
import json

import duckdb
import pandas as pd

from engine.paths import DATA_FINDINGS


def write_findings(findings: list[dict]) -> pd.DataFrame:
    ids = [f["finding_id"] for f in findings]
    dup_count = len(ids) - len(set(ids))
    assert dup_count == 0, f"{dup_count} duplicate finding_id(s) - refusing to export silently"

    with open(DATA_FINDINGS / "findings.jsonl", "w") as f:
        for finding in findings:
            f.write(json.dumps(finding, default=str) + "\n")

    try:
        df = pd.DataFrame(findings)
        df.to_parquet(DATA_FINDINGS / "findings.parquet", engine="pyarrow", index=False)
    except Exception as e:
        # evidence.observed/threshold have different keys per detector (a
        # STALLED_AT_SANCTION observed dict and a GHOST_ASSET one share no
        # keys) - pyarrow's struct inference can choke on that. Flatten
        # instead of losing the export.
        print(f"  nested parquet write failed ({e}); falling back to flattened columns")
        df = pd.json_normalize(findings, sep="_")
        df.to_parquet(DATA_FINDINGS / "findings.parquet", engine="pyarrow", index=False)

    print(f"  wrote findings.jsonl + findings.parquet ({len(findings):,} rows)")
    return df


def write_parquet(df: pd.DataFrame, name: str) -> None:
    df.to_parquet(DATA_FINDINGS / f"{name}.parquet", engine="pyarrow", index=False)
    print(f"  wrote {name}.parquet ({len(df):,} rows, {len(df.columns)} cols)")


def write_duckdb(tables: dict[str, str]) -> None:
    """tables: {table_name: parquet_filename}"""
    con = duckdb.connect(str(DATA_FINDINGS / "mplads.duckdb"))
    for table_name, fname in tables.items():
        con.execute(f"CREATE OR REPLACE TABLE {table_name} AS SELECT * FROM read_parquet(?)",
                    [str(DATA_FINDINGS / fname)])
    con.close()
    print(f"  wrote mplads.duckdb ({', '.join(tables)})")


def run(findings: list[dict], work_risk: pd.DataFrame, constituency_risk: pd.DataFrame) -> None:
    write_findings(findings)
    write_parquet(work_risk, "work_risk")
    write_parquet(constituency_risk, "constituency_risk")
    write_duckdb({"findings": "findings.parquet", "work_risk": "work_risk.parquet",
                  "constituency_risk": "constituency_risk.parquet"})


def demo():
    from engine.link import run as link_run
    from engine.detectors import run as detectors_run, load_config as load_detector_config
    from engine.score import run as score_run
    from engine.rollup import run as rollup_run

    link_run()
    cfg = load_detector_config()
    findings = score_run(detectors_run(), cfg)
    work_risk, constituency_risk = rollup_run(findings, cfg)
    run(findings, work_risk, constituency_risk)

    # round-trip checks
    jsonl_lines = sum(1 for _ in open(DATA_FINDINGS / "findings.jsonl"))
    findings_pq = pd.read_parquet(DATA_FINDINGS / "findings.parquet")
    assert jsonl_lines == len(findings_pq) == len(findings), (
        f"row-count mismatch: jsonl={jsonl_lines} parquet={len(findings_pq)} source={len(findings)}"
    )

    work_risk_pq = pd.read_parquet(DATA_FINDINGS / "work_risk.parquet")
    assert len(work_risk_pq) == len(work_risk), "work_risk.parquet round-trip row count mismatch"

    constituency_risk_pq = pd.read_parquet(DATA_FINDINGS / "constituency_risk.parquet")
    assert len(constituency_risk_pq) == len(constituency_risk), "constituency_risk.parquet round-trip row count mismatch"

    con = duckdb.connect(str(DATA_FINDINGS / "mplads.duckdb"))
    for table, expected in [("findings", len(findings)), ("work_risk", len(work_risk)),
                             ("constituency_risk", len(constituency_risk))]:
        n = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        assert n == expected, f"duckdb.{table} has {n} rows, expected {expected}"
    con.close()

    print(f"\nexport self-check: PASS  (jsonl={jsonl_lines:,} parquet={len(findings_pq):,} "
          f"duckdb tables match source row counts)")


if __name__ == "__main__":
    demo()
