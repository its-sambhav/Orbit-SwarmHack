"""Path constants shared by every pipeline stage. No logic, nothing to self-check."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"
DATA_INTERIM = ROOT / "data" / "interim"
DATA_PROCESSED = ROOT / "data" / "processed"
DATA_FINDINGS = ROOT / "data" / "findings"

for _d in (DATA_INTERIM, DATA_PROCESSED, DATA_FINDINGS):
    _d.mkdir(parents=True, exist_ok=True)
