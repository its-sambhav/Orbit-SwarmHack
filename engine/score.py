"""Stage 5: priority_score (additive field, not part of the required finding
shape) and routed_to, filled from config/routing.yaml keyed by each finding's
own `stage`."""
import math

import yaml

from engine.paths import CONFIG_DIR


def load_routing() -> dict:
    with open(CONFIG_DIR / "routing.yaml") as f:
        return yaml.safe_load(f)


def priority_score(finding: dict, weights: dict) -> float:
    sev = weights["severity_weight"][finding["severity"]]
    conf = weights["confidence_weight"][finding["confidence"]]
    exposure = finding["financial_exposure"] or 0
    return sev + conf + weights["exposure_weight"] * math.log10(max(exposure, 1))


def route(finding: dict, routing_cfg: dict) -> dict:
    finding["routed_to"] = routing_cfg["routes"].get(finding["stage"], routing_cfg["default"])
    return finding


def run(findings: list[dict], detector_cfg: dict) -> list[dict]:
    routing_cfg = load_routing()
    weights = detector_cfg["scoring"]
    for f in findings:
        f["priority_score"] = priority_score(f, weights)
        route(f, routing_cfg)
    print(f"  scored + routed {len(findings):,} findings")
    return findings


def demo():
    from engine.detectors import load_config as load_detector_config

    routing_cfg = load_routing()
    weights = load_detector_config()["scoring"]

    synthetic = [
        {"severity": "high", "confidence": "rule", "financial_exposure": 5_000_000, "stage": "sanction"},
        {"severity": "low", "confidence": "rule", "financial_exposure": 0, "stage": "execution"},
        {"severity": "medium", "confidence": "rule", "financial_exposure": 250_000, "stage": "payment"},
        {"severity": "high", "confidence": "rule", "financial_exposure": 1_000_000, "stage": "not_a_real_stage"},
    ]
    for f in synthetic:
        score = priority_score(f, weights)
        assert math.isfinite(score), f"priority_score not finite for {f}"
        route(f, routing_cfg)
        assert f["routed_to"] is not None, f"routed_to is null for {f}"
    assert synthetic[-1]["routed_to"] == routing_cfg["default"], "bogus stage should fall back to default route"

    print("score self-check: PASS  (synthetic findings incl. bogus stage -> falls back to default route)")


if __name__ == "__main__":
    demo()
