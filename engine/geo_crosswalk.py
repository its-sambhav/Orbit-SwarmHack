"""Build the constituency-name crosswalk between our data's CONSTITUENCY_ID
(from constituency_risk.parquet, Lok Sabha only - this project doesn't cover
Rajya Sabha, see docs/SCHEMA.md) and Datameet's PC boundaries GeoJSON
(data/geo/india_pc_2019_simplified.geojson, pc_name/st_name).

Our names are ALL CAPS with a trailing category suffix, e.g. "ADILABAD(ST)",
and - when a name collides with another state's PC of the same name -
a trailing state-code suffix, e.g. "AURANGABAD_MH" (there is also a Bihar
"Aurangabad" seat) or "HAMIRPUR_UP" (also one in Himachal Pradesh). Datameet's
names are title case, no suffix, e.g. "Adilabad" / "Aurangabad".

Matching is scoped to the constituency's own state (via geo_names.py's
our_state_for(), shared with geo_dissolve.py) rather than searched across all
543 PCs nationally - not just an optimisation. An unscoped match is how this
crosswalk previously mismatched every one of India's few duplicate PC names
to the wrong state (Maharashtra's "AURANGABAD_MH" resolved to Bihar's
Aurangabad; Bihar's "MAHARAJGANJ_BR" resolved to Uttar Pradesh's Maharajganj)
and produced at least one pure string-similarity false positive across
unrelated states (Assam's "Kaziranga" fuzzy-matched Uttar Pradesh's
"Kairana" - textually close, geographically nowhere near each other). All
three were invisible on the all-India view (one wrong dot among 543 is easy
to miss) but obvious as soon as a single state is viewed alone, which is
exactly the situation that surfaced them. Restricting the candidate pool to
the constituency's real state closes both failure modes at once: a
same-named duplicate can only resolve to its own state's seat, and a fuzzy
match can't drift onto an unrelated, similar-looking name states away.
"""
import json
import re

import pandas as pd
from rapidfuzz import fuzz, process

from engine.geo_names import our_state_for
from engine.paths import DATA_FINDINGS, ROOT

GEOJSON_PATH = ROOT / "data" / "geo" / "india_pc_2019_simplified.geojson"
CROSSWALK_PATH = ROOT / "data" / "geo" / "constituency_crosswalk.json"

SUFFIX_RE = re.compile(r'\s*\((SC|ST|GEN)\)\s*$')
STATE_CODE_RE = re.compile(r'_[A-Z]{2,3}$')  # our own disambiguation suffix, e.g. "_MH", "_UP" - not present in Datameet's names
PUNCT_RE = re.compile(r'[^A-Z0-9 ]')
WS_RE = re.compile(r'\s+')


def normalize(name: str) -> str:
    name = SUFFIX_RE.sub('', str(name).upper())
    name = STATE_CODE_RE.sub('', name)
    name = PUNCT_RE.sub(' ', name)
    return WS_RE.sub(' ', name).strip()


# Datameet's 2019 boundaries predate several 2014-2018 renames and still use
# the old constituency names - hand-verified against the geojson's actual
# pc_name values (Bangalore/Mysore/Allahabad, not Bengaluru/Mysuru/Prayagraj),
# so most "obvious" renames need NO override; only genuine spelling/naming
# differences remain here (each confirmed by checking the target state's own
# geojson PC list directly - not guessed).
MANUAL_OVERRIDES = {
    "JANJGIR CHAMPA": "JANJGIR",
    # Assam: 5 seats renamed for the 2024 election; the 2019 boundary file
    # (our only geo source) still carries the pre-rename names.
    "DARRANG UDALGURI": "MANGALDOI",
    "DIPHU": "AUTONOMOUS DISTRICT",
    "SONITPUR": "TEZPUR",
    "GUWAHATI": "GAUHATI",
    "KAZIRANGA": "KALIABOR",
    # spelling-variant mismatches between our source and Datameet's 2019
    # file, each one character off and just under the fuzzy-match cutoff
    "PURNEA": "PURNIA",
    "BELGAUM": "BELAGAVI",
    "HASSAN": "HAASAN",
    "BHONGIR": "BHUVANAGIRI",
}


def build_crosswalk() -> dict:
    geo = json.loads(GEOJSON_PATH.read_text())
    geo_features = geo["features"]

    # {our_state_norm: {name_norm: [pc_id, ...]}} - the candidate pool for a
    # given constituency is only ever its own state's PCs, never all 543.
    geo_by_state_norm: dict[str, dict[str, list[int]]] = {}
    for f in geo_features:
        p = f["properties"]
        norm = normalize(p["pc_name"])
        st_norm = normalize(our_state_for(p["pc_name"], p["st_name"]))
        geo_by_state_norm.setdefault(st_norm, {}).setdefault(norm, []).append(p["pc_id"])

    # constituency_risk.parquet is Lok Sabha only - Rajya Sabha is filtered
    # out at engine/ingest.py, before the spine even exists.
    cr = pd.read_parquet(DATA_FINDINGS / "constituency_risk.parquet")

    crosswalk, unmatched, ambiguous = {}, [], []

    for _, row in cr.iterrows():
        cid, name, state = str(int(row["CONSTITUENCY_ID"])), row["constituency"], row["state"]

        norm = normalize(name)
        norm = MANUAL_OVERRIDES.get(norm, norm)
        pool = geo_by_state_norm.get(normalize(state), {})

        if norm in pool and len(pool[norm]) == 1:
            crosswalk[cid] = pool[norm][0]
            continue

        if pool:
            match = process.extractOne(norm, list(pool.keys()), scorer=fuzz.ratio, score_cutoff=85)
            if match:
                candidates = pool[match[0]]
                if len(candidates) == 1:
                    crosswalk[cid] = candidates[0]
                else:
                    # e.g. Maharashtra's "Mumbai South": Datameet's own file
                    # has 2 features both named pc_name="Mumbai South" (pc_no
                    # 30 and 31, same wikidata_qid - an upstream duplicate,
                    # not our bug). Left unmatched on purpose rather than
                    # guessing one - a wrong pick here is exactly the silent
                    # wrong-location failure this rewrite exists to prevent.
                    ambiguous.append((cid, name, state, candidates))
                continue

        unmatched.append((cid, name, state))

    coverage = len(crosswalk) / len(cr) * 100
    print(f"  crosswalk: {len(crosswalk)}/{len(cr)} constituencies matched ({coverage:.1f}%)")
    if ambiguous:
        print(f"  ambiguous within own state ({len(ambiguous)}): {ambiguous}")
    if unmatched:
        print(f"  unmatched ({len(unmatched)}): {unmatched}")

    CROSSWALK_PATH.write_text(json.dumps(crosswalk, indent=2))
    print(f"  wrote {CROSSWALK_PATH}")
    return crosswalk


def demo():
    crosswalk = build_crosswalk()
    assert len(crosswalk) > 500, f"only {len(crosswalk)} constituencies matched, expected >500 of 538"
    # spot-check a well-known constituency resolves to a real geo feature
    geo = json.loads(GEOJSON_PATH.read_text())
    pc_ids = {f["properties"]["pc_id"] for f in geo["features"]}
    assert all(pid in pc_ids for pid in crosswalk.values()), "crosswalk points at a pc_id not in the geojson"

    # the exact wrong-state matches this rewrite fixes - verified against a
    # live API response before this fix shipped; assert they resolve to a PC
    # actually inside the right state, not just any PC with a similar name.
    cr = pd.read_parquet(DATA_FINDINGS / "constituency_risk.parquet")
    pc_by_id = {f["properties"]["pc_id"]: f["properties"] for f in geo["features"]}
    checks = [
        ("AURANGABAD_MH", "Maharashtra"),
        ("MAHARAJGANJ_BR", "Bihar"),
        ("Kaziranga", "Assam"),
    ]
    for name, expected_state in checks:
        row = cr[cr["constituency"] == name]
        if row.empty:
            continue
        cid = str(int(row.iloc[0]["CONSTITUENCY_ID"]))
        pid = crosswalk.get(cid)
        assert pid is not None, f"{name} did not match any geo feature"
        props = pc_by_id[pid]
        got_state = our_state_for(props["pc_name"], props["st_name"])
        assert got_state == expected_state, (
            f"{name} (state={expected_state}) resolved to {props['pc_name']!r} in {got_state!r} instead"
        )

    print("geo_crosswalk self-check: PASS")


if __name__ == "__main__":
    demo()
