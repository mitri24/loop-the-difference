"""Demo targets from the challenge statement (README.md).

Values from CDS Sesame/SIMBAD (J2000 ICRS position, proper motion in mas/yr with
pmRA including cos δ), fetched 2026-11-13. They are an OFFLINE FALLBACK only: the
live resolver is used first. Re-verify with ``scripts/precache_demo.py --check``.
"""

from __future__ import annotations

from .schemas import Target

DEMO_TARGETS: dict[str, dict] = {
    "barnard": {
        "label": "Barnard's Star",
        "why": 'Highest proper motion star (10.4"/yr): moves ~1.7 SPHEREx pixels per year.',
        "suggested_band": "D2",
        "target": Target(
            name="Barnard's Star",
            ra=269.4520769586187,
            dec=4.69336496657667,
            epoch_jyear=2000.0,
            pm_ra_mas_yr=-801.551,
            pm_dec_mas_yr=10362.394,
            source="SIMBAD via Sesame (cached)",
        ),
    },
    "eps-indi-b": {
        "label": "Epsilon Indi B",
        "why": 'Pair of brown dwarfs orbiting a nearby star; 4.7"/yr proper motion.',
        "suggested_band": "D3",
        "target": Target(
            name="eps Ind B",
            ra=331.04414658852124,
            dec=-56.78284419511611,
            epoch_jyear=2000.0,
            pm_ra_mas_yr=3981.977,
            pm_dec_mas_yr=-2466.832,
            source="SIMBAD via Sesame (cached)",
        ),
    },
    "wise-0855": {
        "label": "WISE 0855-0714",
        "why": 'Coldest known brown dwarf, 8.2"/yr. Very faint below 4 µm: look in D6.',
        "suggested_band": "D6",
        "target": Target(
            name="WISE J085510.83-071442.5",
            ra=133.81890825,
            dec=-7.247048,
            epoch_jyear=2000.0,
            pm_ra_mas_yr=-8123.7,
            pm_dec_mas_yr=673.2,
            source="SIMBAD via Sesame (cached)",
        ),
    },
    "rw-aur": {
        "label": "RW Aurigae",
        "why": "Young variable star with dimming events: look for brightness changes.",
        "suggested_band": "D3",
        "target": Target(
            name="RW Aur",
            ra=76.95652603458,
            dec=30.40143817389,
            epoch_jyear=2000.0,
            pm_ra_mas_yr=7.23,
            pm_dec_mas_yr=-20.33,
            source="SIMBAD via Sesame (cached)",
        ),
    },
    "r-dra": {
        "label": "R Draconis",
        "why": "Mira variable (period ~246 days): large infrared brightness changes.",
        "suggested_band": "D2",
        "target": Target(
            name="R Dra",
            ra=248.16761083295,
            dec=66.75497941722,
            epoch_jyear=2000.0,
            pm_ra_mas_yr=-20.643,
            pm_dec_mas_yr=6.149,
            source="SIMBAD via Sesame (cached)",
        ),
    },
}


def find_demo(name: str) -> Target | None:
    key = name.strip().lower()
    for slug, d in DEMO_TARGETS.items():
        t: Target = d["target"]
        if key in (slug, d["label"].lower(), (t.name or "").lower()):
            return t
    return None
