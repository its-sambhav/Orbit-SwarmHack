"""Shared state-name reconciliation between our pipeline's STATE_NAME
vocabulary and Datameet's 2019 PC boundaries GeoJSON st_name vocabulary
(data/geo/india_pc_2019_simplified.geojson) - the file predates several
since-renamed/since-split states and UTs. Used by both geo_dissolve.py
(state boundaries) and geo_crosswalk.py (constituency matching) so the two
share one hand-verified mapping instead of drifting apart.

  - "Andaman & Nicobar" -> "Andaman And Nicobar Islands"
  - "Orissa" -> "Odisha" (Datameet's file predates the rename)
  - "Dadra & Nagar Haveli" + "Daman & Diu" both -> "The Dadra And Nagar
    Haveli And Daman And Diu" (merged into one UT in 2020, after this
    boundary file was drawn)
  - "Jammu & Kashmir" splits in two: the "Ladakh" PC seat (pc_id 104)
    belongs to our "Ladakh", the other 5 PCs to our "Jammu And Kashmir" -
    Ladakh became a separate UT in 2019, after this file was drawn, but its
    old PC seat is still separable by name.
  - every other st_name already matches STATE_NAME exactly.
"""

GEOJSON_TO_OUR_STATE = {
    "Andaman & Nicobar": "Andaman And Nicobar Islands",
    "Orissa": "Odisha",
    "Dadra & Nagar Haveli": "The Dadra And Nagar Haveli And Daman And Diu",
    "Daman & Diu": "The Dadra And Nagar Haveli And Daman And Diu",
    "Jammu & Kashmir": "Jammu And Kashmir",
}


def our_state_for(pc_name: str, st_name: str) -> str:
    """Which of our STATE_NAME values a given geojson PC feature belongs to."""
    if pc_name == "Ladakh" and st_name == "Jammu & Kashmir":
        return "Ladakh"
    return GEOJSON_TO_OUR_STATE.get(st_name, st_name)
