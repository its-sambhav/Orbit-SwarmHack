"""Read-only accessor for the latest alert digest engine/alerts.py writes
after every pipeline run - the one thing this module does is read that
already-built JSON file back."""
import json

from engine.paths import DATA_ALERTS

LATEST_PATH = DATA_ALERTS / "latest.json"


def get_latest_digest() -> dict | None:
    if not LATEST_PATH.exists():
        return None
    return json.loads(LATEST_PATH.read_text())
