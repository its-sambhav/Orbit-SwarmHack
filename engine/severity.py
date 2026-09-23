"""One continuous severity scale shared by engine/detectors.py (which
measures it) and engine/score.py (which turns it into strength and
priority).

severity_score x is in [0, 1], stored to 4 decimals. The low/medium/high
labels are bands of it:
    low [0, 0.3333)   medium [0.3333, 0.6667)   high [0.6667, 1]
A detector still decides the label with its own rule (peer P95, 1.5x the
fixed limit, ...); x only records how far into that band the finding is, so
two "medium" findings are no longer scored identically. The band edges sit
on the same 4-decimal grid x is stored on, so rounding can never move a
finding into a different band.
"""
import numpy as np

SEVERITIES = ["low", "medium", "high"]
SEV_RANK = {"low": 0, "medium": 1, "high": 2}
STEP = 1 / 3                       # one band - what corroboration adds
EDGE_MEDIUM, EDGE_HIGH = 0.3333, 0.6667
BAND = {"low": (0.0, 0.3332), "medium": (EDGE_MEDIUM, 0.6666), "high": (EDGE_HIGH, 1.0)}
# the curve's anchor points in engine/score.py - a finding here scores
# exactly the old fixed weight for its label
CENTRE = {"low": 1 / 6, "medium": 1 / 2, "high": 5 / 6}


def quantize(x: float) -> float:
    return round(float(x), 4)


def band_of(x: float) -> str:
    x = quantize(x)
    return "high" if x >= EDGE_HIGH else "medium" if x >= EDGE_MEDIUM else "low"


def band_center(label: str) -> float:
    return CENTRE[label]


def clamp_to_band(x: float | None, label: str) -> float:
    """x kept inside `label`'s band - the label is the detector's decision
    and x can't contradict it. Missing x -> the band centre."""
    lo, hi = BAND[label]
    if x is None or not np.isfinite(x):
        return band_center(label)
    return quantize(min(max(float(x), lo), hi))


def top_of(label: str) -> float:
    """Highest x that still reads as `label` (for caps like "statistical
    findings stop at medium")."""
    return BAND[label][1]


def ramp(v: float, xs: list[float], ys: list[float]) -> float:
    """Piecewise-linear v -> x through (xs, ys), flat past either end. xs
    that tie or run backwards (e.g. a peer group whose P95 equals its P99)
    are nudged to strictly increasing so the mapping stays defined."""
    xs = np.maximum.accumulate(np.asarray(xs, dtype=float))
    xs = xs + np.arange(len(xs)) * 1e-9
    return float(np.interp(v, xs, ys))
