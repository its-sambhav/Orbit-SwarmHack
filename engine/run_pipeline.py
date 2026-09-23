"""Orchestrator: ingest -> normalise -> link -> detectors -> score -> rollup -> export.

    python -m engine.run_pipeline

Every stage is also runnable on its own (`python -m engine.<stage>`).
After export: the regression snapshot check, the hand-check sheet, and a
refit of the two ranking/prediction models so they match this run's findings.
"""
import time
from collections import Counter

from engine import ingest, normalise, link, detectors, score, rollup, export, validation, risk_model, predictive, alerts


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
    findings = detectors.run(cfg=cfg)

    print("\n=== 5/7 score ===")
    findings = score.run(findings, cfg)
    validation.regression_check(findings, cfg["validation"]["regression_max_change"])

    print("\n=== 6/7 rollup ===")
    anomaly = risk_model.anomaly_scores(spine)
    work_risk, constituency_risk, district_risk, state_risk = rollup.run(findings, cfg, anomaly)

    print("\n=== 7/7 export ===")
    previous_ids = alerts.load_previous_finding_ids()
    export.run(findings, work_risk, constituency_risk, district_risk, state_risk)
    alerts.run(findings, previous_ids, cfg["as_of_date"])
    validation.export_hand_check_sheet(findings, cfg)

    print("\n=== models (ranking/prediction only) ===")
    risk_model.train_model()
    predictive.train_model()
    risk_model.train_label_model()

    elapsed = time.time() - t0
    live = [f for f in findings if not f["suppressed"]]
    print(f"\n{'=' * 60}\nPIPELINE SUMMARY\n{'=' * 60}")
    print(f"  spine (works, all scopes):     {len(spine):,}")
    print(f"  total findings:                {len(findings):,}  ({len(findings) - len(live):,} suppressed)")
    print(f"  works with >=1 finding:        {len(work_risk):,}  ({len(work_risk) / len(spine) * 1000:.1f} per 1,000)")
    print(f"  by severity:                   {dict(Counter(f['severity'] for f in live))}")
    for tag, n in sorted(Counter(f["tag"] for f in live).items(), key=lambda kv: -kv[1]):
        print(f"    {tag:45} {n:>8,}")
    print(f"  run time:                      {elapsed:.1f}s\n{'=' * 60}")


if __name__ == "__main__":
    main()
