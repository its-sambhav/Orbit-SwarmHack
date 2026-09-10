"""Build the state-level boundary GeoJSON by dissolving (unioning) the
existing PC-level boundaries (data/geo/india_pc_2019_simplified.geojson),
grouped by state - rather than sourcing a second boundary file from a
different provider. Two independently-drawn boundary sets almost never align
pixel-for-pixel, which shows up as visible gaps/overlaps at every state
border; dissolving our own PC polygons guarantees the state map lines up
exactly with the constituency map, since it's built from the same vertices.

Name reconciliation (st_name in the geojson -> STATE_NAME in the pipeline)
is shared with geo_crosswalk.py via geo_names.py - see that module for the
hand-verified mapping and why no other join key exists (also docs/SCHEMA.md's
geography section).

Simplified polygons from independent per-feature simplification don't share
identical vertices along a common border, leaving hairline gaps when
unioned - the standard buffer-out/union/buffer-in trick closes most of them,
and every state still came out with dozens to hundreds of leftover
microscopic holes (verified: the single largest hole anywhere, in Gujarat,
is 0.0046% of that state's area - simplification noise, not a real enclave;
no Indian state has a real hole at anywhere near this scale in this
dataset's granularity). Rather than chase the buffer size that fully
prevents them, every interior ring is stripped outright after dissolving.
"""
import json

import pandas as pd
from shapely.geometry import MultiPolygon, Polygon, mapping, shape
from shapely.ops import unary_union

from engine.geo_names import our_state_for
from engine.paths import DATA_PROCESSED, ROOT

GEOJSON_PATH = ROOT / "data" / "geo" / "india_pc_2019_simplified.geojson"
OUT_PATH = ROOT / "data" / "geo" / "india_states_simplified.geojson"
CROSSWALK_PATH = ROOT / "data" / "geo" / "constituency_crosswalk.json"
DISTRICT_OUT_PATH = ROOT / "data" / "geo" / "india_districts_simplified.geojson"

SLIVER_EPSILON = 0.004  # degrees (~440m) - closes most simplification gaps without visibly distorting the coastline at national-map zoom; remove_holes() below is the guaranteed cleanup for whatever this doesn't close
SIMPLIFY_TOLERANCE = 0.0015  # degrees (~165m) - buffering by SLIVER_EPSILON approximates each curve with arc segments, which multiplies vertex count far past the source data's own resolution (one district measured at 4,339 vertices pre-simplify, a 64MB file for all 800); Douglas-Peucker back down to a UI-map-appropriate density, well under the ~440m buffer distance itself so it can't reintroduce the gaps that buffer closed


def target_state(props: dict) -> str:
    return our_state_for(props["pc_name"], props["st_name"])


def remove_holes(geom):
    """Drop every interior ring - see module docstring for why this is safe
    here (no real hole this large exists in any dissolved state)."""
    if not geom.is_valid:
        geom = geom.buffer(0)
    parts = geom.geoms if geom.geom_type == "MultiPolygon" else [geom]
    cleaned = [Polygon(p.exterior) for p in parts if not p.exterior.is_empty]
    return MultiPolygon(cleaned) if len(cleaned) > 1 else cleaned[0]


def finish(dissolved):
    """The shared cleanup + simplify step every dissolved geometry goes
    through, in this order: holes out, then simplify - simplifying first
    would sometimes turn small holes into self-intersections."""
    cleaned = remove_holes(dissolved)
    return cleaned.simplify(SIMPLIFY_TOLERANCE, preserve_topology=True)


def build_state_geojson() -> dict:
    geo = json.loads(GEOJSON_PATH.read_text())

    groups: dict[str, list] = {}
    for f in geo["features"]:
        groups.setdefault(target_state(f["properties"]), []).append(shape(f["geometry"]))

    features = []
    for state, geoms in sorted(groups.items()):
        buffered = [g.buffer(SLIVER_EPSILON) for g in geoms]
        dissolved = unary_union(buffered).buffer(-SLIVER_EPSILON)
        dissolved = finish(dissolved)
        features.append({
            "type": "Feature",
            "properties": {"state": state, "pc_count": len(geoms)},
            "geometry": mapping(dissolved),
        })

    out = {"type": "FeatureCollection", "features": features}
    OUT_PATH.write_text(json.dumps(out))
    print(f"  wrote {OUT_PATH} ({len(features)} states, dissolved from {len(geo['features'])} PCs)")
    return out


def build_district_geojson() -> dict:
    """Same technique, one level down: a district's sanctioning authority
    (IDA) can span works recommended from more than one constituency (see
    docs/SCHEMA.md), so "the district's boundary" is the union of every
    constituency whose recommendations that IDA handles - not any single
    constituency's own shape, and not a second, differently-sourced district
    boundary file (same alignment problem the state dissolve avoids)."""
    geo = json.loads(GEOJSON_PATH.read_text())
    geoms_by_pcid = {f["properties"]["pc_id"]: shape(f["geometry"]) for f in geo["features"]}
    crosswalk: dict[str, int] = json.loads(CROSSWALK_PATH.read_text())

    spine = pd.read_parquet(DATA_PROCESSED / "spine.parquet", columns=["DISTRICT", "STATE_NAME", "CONSTITUENCY_ID"])
    spine = spine.dropna(subset=["DISTRICT", "STATE_NAME", "CONSTITUENCY_ID"])
    groups = spine.groupby(["STATE_NAME", "DISTRICT"])["CONSTITUENCY_ID"].apply(
        lambda ids: sorted({int(i) for i in ids})
    )

    features, unmatched = [], []
    for (state, district), cids in groups.items():
        pc_ids = {crosswalk.get(str(cid)) for cid in cids} - {None}
        geoms = [geoms_by_pcid[pid] for pid in pc_ids if pid in geoms_by_pcid]
        if not geoms:
            unmatched.append((state, district))
            continue
        buffered = [g.buffer(SLIVER_EPSILON) for g in geoms]
        dissolved = unary_union(buffered).buffer(-SLIVER_EPSILON)
        dissolved = finish(dissolved)
        features.append({
            "type": "Feature",
            "properties": {"state": state, "district": district, "pc_count": len(geoms)},
            "geometry": mapping(dissolved),
        })

    out = {"type": "FeatureCollection", "features": features}
    DISTRICT_OUT_PATH.write_text(json.dumps(out))
    print(f"  wrote {DISTRICT_OUT_PATH} ({len(features)} districts, {len(unmatched)} with no matched boundary)")
    if unmatched:
        print(f"  unmatched: {unmatched}")
    return out


def demo():
    out = build_state_geojson()
    assert len(out["features"]) == 36, f"expected 36 states/UTs, got {len(out['features'])}"
    pc_counts = {f["properties"]["state"]: f["properties"]["pc_count"] for f in out["features"]}
    assert pc_counts["Jammu And Kashmir"] == 5, pc_counts["Jammu And Kashmir"]
    assert pc_counts["Ladakh"] == 1, pc_counts["Ladakh"]
    assert pc_counts["The Dadra And Nagar Haveli And Daman And Diu"] == 2, pc_counts["The Dadra And Nagar Haveli And Daman And Diu"]
    total_pcs = sum(pc_counts.values())
    assert total_pcs == 543, f"dissolved PC total {total_pcs} != 543 source features"
    for f in out["features"]:
        g = shape(f["geometry"])
        assert g.is_valid, f"invalid geometry for {f['properties']['state']}"
        parts = g.geoms if g.geom_type == "MultiPolygon" else [g]
        n_holes = sum(len(p.interiors) for p in parts)
        assert n_holes == 0, f"{f['properties']['state']} still has {n_holes} interior holes"

    dout = build_district_geojson()
    assert len(dout["features"]) > 700, f"expected 700+ districts (docs/SCHEMA.md), got {len(dout['features'])}"
    for f in dout["features"]:
        g = shape(f["geometry"])
        assert g.is_valid, f"invalid geometry for {f['properties']['state']}/{f['properties']['district']}"
        parts = g.geoms if g.geom_type == "MultiPolygon" else [g]
        n_holes = sum(len(p.interiors) for p in parts)
        assert n_holes == 0, f"{f['properties']['district']} still has {n_holes} interior holes"

    print("geo_dissolve self-check: PASS")


if __name__ == "__main__":
    demo()
