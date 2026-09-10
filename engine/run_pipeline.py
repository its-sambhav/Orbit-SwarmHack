"""Orchestrator: ingest -> normalise -> link -> detectors -> score -> rollup -> export.

    python3 -m engine.run_pipeline

No CLI flags - every stage is independently runnable via `python3 -m engine.<stage>`
for iterative dev. No separate self-check here - this is glue over 7 stages
that each already assert their own invariants; a duplicate check here would
just re-verify what they've already verified.
"""
import time

from engine import ingest, normalise, link, detectors, score, rollup, export


def main():
    t0 = time.time()

    print("=== 1/7 ingest ===")
    ingest.run()

    print("\n=== 2/7 normalise ===")
    normalise.run()

    print("\n=== 3/7 link ===")
    spine = link.run()

    print("\n=== 4/7 detectors ===")
    cfg = detectors.load_config()
    findings = detectors.run()

    print("\n=== 5/7 score ===")
    findings = score.run(findings, cfg)

    print("\n=== 6/7 rollup ===")
    work_risk, constituency_risk, district_risk, state_risk = rollup.run(findings, cfg)

    print("\n=== 7/7 export ===")
    export.run(findings, work_risk, constituency_risk, district_risk, state_risk)

    elapsed = time.time() - t0
    print(f"\n{'=' * 60}")
    print("PIPELINE SUMMARY")
    print(f"{'=' * 60}")
    print(f"  spine (works, all scopes):     {len(spine):,}")
    print(f"  total findings:                {len(findings):,}")
    print(f"  works with >=1 finding:        {len(work_risk):,}")
    print(f"  breach rate (all-scope):       {len(work_risk) / len(spine) * 100:.1f}%")
    demo_scopes = cfg["queue"]["demo_scopes"]
    in_scope_n = int((spine["SCOPE_TENURE"].isin(demo_scopes)).sum())
    in_scope_flagged = int(work_risk["in_demo_scope"].sum())
    print(f"  breach rate (in-scope {demo_scopes}): {in_scope_flagged / in_scope_n * 100:.1f}%")
    print(f"  constituencies covered:        {len(constituency_risk):,}")
    print(f"  districts covered:             {len(district_risk):,}")
    print(f"  states covered:                {len(state_risk):,}")
    print(f"  run time:                      {elapsed:.1f}s")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
