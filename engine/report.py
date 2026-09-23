"""Writes the detection-change deliverables from the real outputs:

    python -m engine.report

- reports/anomaly_detection_report.md: before/after findings per tag and per
  severity, flagged works per 1,000, old-to-new tag mapping
- reports/verification_needed.md: every `verified: false` value in the config

"Before" is reports/baseline_before_rerun.json (the old detectors re-run on
the same data before this change); "after" is data/findings/findings.parquet.
"""
import json

import pandas as pd
import yaml

from engine.paths import CONFIG_DIR, DATA_FINDINGS, DATA_PROCESSED, ROOT

REPORTS = ROOT / "reports"
TENURES = ["18th Lok Sabha", "17th Lok Sabha"]


def after_stats() -> dict:
    f = pd.read_parquet(DATA_FINDINGS / "findings.parquet")
    f = f[~f["suppressed"].astype(bool)]
    f["tenure"] = f["entities"].apply(lambda e: e["scope_tenure"])
    f["family"] = f["evidence"].apply(lambda e: e["family"])
    sp = pd.read_parquet(DATA_PROCESSED / "spine.parquet", columns=["SCOPE_TENURE"])
    works = f[["work_number", "tenure"]].drop_duplicates()
    # works flagged by something other than record-keeping alone
    substantive = f[~f["family"].isin(["documentation", "data_integrity"])][["work_number", "tenure"]].drop_duplicates()
    out = {
        "total_findings": len(f),
        "by_tag": f.groupby("tag").size().to_dict(),
        "by_severity": f.groupby("severity").size().to_dict(),
        "by_tag_severity": {f"{a}|{b}": int(n) for (a, b), n in f.groupby(["tag", "severity"]).size().items()},
        "by_tag_tenure": {f"{a}|{b}": int(n) for (a, b), n in f.groupby(["tag", "tenure"]).size().items()},
        "flagged_works": len(works),
        "flagged_per_1000": round(len(works) / len(sp) * 1000, 1),
        "substantive_per_1000": round(len(substantive) / len(sp) * 1000, 1),
    }
    for t in TENURES:
        n = int((sp.SCOPE_TENURE == t).sum())
        out[f"flagged_per_1000_{t}"] = round(int((works.tenure == t).sum()) / n * 1000, 1)
        out[f"substantive_per_1000_{t}"] = round(int((substantive.tenure == t).sum()) / n * 1000, 1)
        out[f"high_works_per_1000_{t}"] = round(
            f[(f.tenure == t) & (f.severity == "high")]["work_number"].nunique() / n * 1000, 1)
    wr = pd.read_parquet(DATA_FINDINGS / "work_risk.parquet")
    out["queue_size"] = int(wr["in_queue"].sum()) if "in_queue" in wr else None
    return out


def unverified_items() -> list[tuple[str, str]]:
    items = []

    def walk(node, path):
        if isinstance(node, dict):
            if node.get("verified") is False:
                shown = node.get("value", node.get("windows", node.get("patterns", "")))
                items.append((path, f"{shown}" + (f" - {node['note'].strip()}" if node.get("note") else "")))
            for k, v in node.items():
                walk(v, f"{path}.{k}" if path else k)

    walk(yaml.safe_load((CONFIG_DIR / "detectors.yaml").read_text(encoding="utf-8")), "detectors.yaml")
    tags = yaml.safe_load((CONFIG_DIR / "tags.yaml").read_text(encoding="utf-8"))["tags"]
    for key, t in tags.items():
        if not t["verified"]:
            items.append((f"tags.yaml.{key}", f"{t['name']} - source: {t['source']}"))
    return items


def table(rows: list[list], header: list[str]) -> str:
    out = ["| " + " | ".join(header) + " |", "|" + "|".join(["---"] * len(header)) + "|"]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def main():
    before = json.loads((REPORTS / "baseline_before_rerun.json").read_text(encoding="utf-8"))
    after = after_stats()
    tags_cfg = yaml.safe_load((CONFIG_DIR / "tags.yaml").read_text(encoding="utf-8"))
    names = {k: t["name"] for k, t in tags_cfg["tags"].items()}

    def sev_row(stats, tag):
        g = {s: stats["by_tag_severity"].get(f"{tag}|{s}", 0) for s in ("high", "medium", "low")}
        return [tag, f"{stats['by_tag'].get(tag, 0):,}", f"{g['high']:,}", f"{g['medium']:,}", f"{g['low']:,}"]

    lines = ["# Anomaly detection upgrade - before / after", "",
             "Same data (as of 2026-09-10), old detectors vs new. A flag means an official should look at the "
             "work; it never means fraud.", "", "## Headline", "",
             table([
                 ["Total findings", f"{before['total_findings']:,}", f"{after['total_findings']:,}"],
                 ["High-severity findings", f"{before['by_severity'].get('high', 0):,}", f"{after['by_severity'].get('high', 0):,}"],
                 ["Medium", f"{before['by_severity'].get('medium', 0):,}", f"{after['by_severity'].get('medium', 0):,}"],
                 ["Low", f"{before['by_severity'].get('low', 0):,}", f"{after['by_severity'].get('low', 0):,}"],
                 ["Flagged works per 1,000 (all)", before["flagged_per_1000"], after["flagged_per_1000"]],
                 ["  18th Lok Sabha", before["flagged_per_1000_18th Lok Sabha"], after["flagged_per_1000_18th Lok Sabha"]],
                 ["  17th Lok Sabha", before["flagged_per_1000_17th Lok Sabha"], after["flagged_per_1000_17th Lok Sabha"]],
                 ["Flagged per 1,000 excluding record-keeping-only works", "-", after["substantive_per_1000"]],
                 ["  18th Lok Sabha", "-", after["substantive_per_1000_18th Lok Sabha"]],
                 ["Works with a high finding per 1,000, 18th LS", "-", after["high_works_per_1000_18th Lok Sabha"]],
                 ["Review queue (18th LS, >= Rs 5 lakh)", "-", after["queue_size"]],
             ], ["", "Before", "After"]), "",
             "## Before - findings per tag and severity", "",
             table([sev_row(before, t) for t in sorted(before["by_tag"])], ["Tag", "Total", "High", "Medium", "Low"]), "",
             "## After - findings per tag and severity", "",
             table([sev_row(after, t) for t in sorted(after["by_tag"], key=lambda t: -after["by_tag"][t])],
                   ["Tag", "Total", "High", "Medium", "Low"]), "",
             "## After - per tenure", "",
             table([[t, f"{after['by_tag_tenure'].get(f'{t}|18th Lok Sabha', 0):,}",
                     f"{after['by_tag_tenure'].get(f'{t}|17th Lok Sabha', 0):,}"]
                    for t in sorted(after["by_tag"], key=lambda t: -after["by_tag"][t])],
                   ["Tag", "18th Lok Sabha", "17th Lok Sabha"]), "",
             "## Old tag -> new tags", "",
             table([[old, ", ".join(names[k] for k in new)] for old, new in tags_cfg["old_tag_mapping"].items()],
                   ["Old tag", "New tags"]), ""]
    (REPORTS / "anomaly_detection_report.md").write_text("\n".join(lines), encoding="utf-8")

    items = unverified_items()
    ver = ["# Values to confirm (`verified: false`)", "",
           "Each of these came from the spec or was inferred from the data, and has not been checked against "
           "the 2023 MPLADS guidelines or another official document.", "",
           table([[p, v.replace("|", "\\|")] for p, v in items], ["Where", "Value / source"]), ""]
    (REPORTS / "verification_needed.md").write_text("\n".join(ver), encoding="utf-8")
    json.dump(after, open(REPORTS / "after.json", "w"), indent=2, default=int)
    print(f"wrote reports/anomaly_detection_report.md, reports/verification_needed.md ({len(items)} items)")


if __name__ == "__main__":
    main()
