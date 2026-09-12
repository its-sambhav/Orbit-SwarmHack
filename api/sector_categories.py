"""Buckets each work's activity into one of 5 sector categories for the
"Project Lifecycle & Risk Breakdown" chart (web/src/components/
ProjectLifecycleBarChart.jsx).

The 4-value WORK_CATEGORY column on the source data is near-useless for this
(98.4% "Normal/Others" - see docs/SCHEMA.md and api/main.py's own comment on
it). ACTIVITY_NAME_CLEAN is the real, ~120-value taxonomy of what a work
actually is (docs/SCHEMA.md calls it "the correct peer-grouping key"), but
120 categories is too many bars for one chart. These 5 names are not
invented here - they're the sector taxonomy already used by this project's
sibling SIH_FinalProject build (see its web/src/data/roleDataEngine.js) - so
this module's only job is mapping each of the real ~120 activity strings
onto that existing 5-way split, by keyword.

Every one of the 120 distinct ACTIVITY_NAME_CLEAN values present in
data/processed/spine.parquet (rec_/san_/comp_ variants) was checked by hand
against these rules - see the classifier order below: a handful of keywords
would otherwise land in the wrong bucket (an animal ambulance vs. a human
one; a school laboratory vs. a soil-testing one), which is why more specific
rules (water, then rural/agri/animal) run before the broader ones."""

INFRASTRUCTURE_ROADS = "Infrastructure & Roads"
COMMUNITY_HALLS_ASSETS = "Community Halls & Assets"
DRINKING_WATER_SANITATION = "Drinking Water & Sanitation"
HEALTHCARE_EDUCATION = "Healthcare & Education"
IRRIGATION_RURAL_DEV = "Irrigation & Rural Dev"

# fixed display order - matches roleDataEngine.js's chartSectors ordering.
CATEGORIES = [
    INFRASTRUCTURE_ROADS,
    COMMUNITY_HALLS_ASSETS,
    DRINKING_WATER_SANITATION,
    HEALTHCARE_EDUCATION,
    IRRIGATION_RURAL_DEV,
]

_WATER_KEYWORDS = (
    "tube-well", "tube well", "borewell", "water tanker", "drinking water",
    "hand pump", "handpump", "supply pipeline", "public toilet", "water tank",
    "toilet block", "sanitation equipment", "garbage collection", "sanitary pad",
    "night soil", "effluent treatment", "rainwater harvesting", "ground water recharg",
)

# checked before Healthcare & Education / Community so that an animal
# ambulance, a soil-testing lab, or a farmers' training centre don't fall
# into that bucket's broader "ambulance"/"laboratories"/"training" keywords.
_RURAL_KEYWORDS = (
    "flood control", "ponds and lakes", "irrigation", "non-conventional energy",
    "new ponds", "lift irrigation", "tree plantation", "farmers", "fisheries",
    "crops conservation", "injured animals", "shelters for animals",
    "forest conservation", "veterinary", "motor boats", "artificial insemination",
    "early warning system", "soil testing", "stubble clearing",
    "mobile labs and clinics for animals", "electric vehicle charging",
    "threshing floor", "semen bank", "weighing scale machine for agriculture",
    "biodigester", "gobar-gas", "biogas", "artificial reef", "anti-pollution",
)

_HEALTH_EDU_KEYWORDS = (
    "school and colleges", "smart board", "educational purpose", "hospital equipment",
    "fwc", "phc centers", "anm centers", "ambulance", "educational institution",
    "differently abled", "mobile dispensar", "anganwad", "laptop/computer",
    "laboratories", "training institution", "training equipment",
    "orphanage", "old-age", "correctional home",
    "prosthetic", "wheel chair", "hearing aid",
)

_COMMUNITY_KEYWORDS = (
    "community center", "community centre", "community hall", "cultural activities",
    "work shed", "covered sitting area", "boundary wall", "crematorium",
    "books and periodicals", "additional rooms and halls", "librar", "reading room",
    "public park", "rcc bench", "garden gym", "multi-gym", "playfield", "playground",
    "sports equipment", "kitchen and pantries", "stadium", "sports facilit",
    "night shelter", "hiring of office", "synthetic turf", "heritage", "archaeological",
    "hearse van", "facilitation centre", "radio station",
    "monitoring of the implementation", "hiring of vehicles",
)


def categorize_activity(name: str | None) -> str:
    """One of the 5 CATEGORIES for a raw ACTIVITY_NAME_CLEAN string. Anything
    not caught by the more specific water/rural/health/community keyword
    sets is a form of public infrastructure (roads, lighting, drainage,
    bridges, government buildings, safety/security, transit) - the largest
    real bucket, and the reasonable default for the like of it."""
    n = (name or "").lower()
    if any(k in n for k in _WATER_KEYWORDS):
        return DRINKING_WATER_SANITATION
    if any(k in n for k in _RURAL_KEYWORDS):
        return IRRIGATION_RURAL_DEV
    if any(k in n for k in _HEALTH_EDU_KEYWORDS):
        return HEALTHCARE_EDUCATION
    if any(k in n for k in _COMMUNITY_KEYWORDS):
        return COMMUNITY_HALLS_ASSETS
    return INFRASTRUCTURE_ROADS
