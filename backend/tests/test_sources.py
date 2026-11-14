import time
from pathlib import Path

import httpx
import numpy as np
import pytest
from astropy.table import Table

from app import sources
from app.catalogs import position_at
from app.frames import target_grid
from app.sources import (
    BRIGHT_SNR,
    FWHM_PX,
    MATCH_RADIUS_ARCSEC,
    THRESHOLD_SIGMA,
    CatalogStar,
    allwise_stars,
    cached_query,
    detect,
    field_catalogs,
    find_sources,
    gaia_stars,
    label,
)

FIXTURES = Path(__file__).parent / "fixtures"
# Real answers for a 0.03° cone around WISE 0855-0714 (Gaia DR3 TAP CSV, IRSA Gator VOTable).
GAIA = gaia_stars((FIXTURES / "gaia_wise0855_cone.csv").read_text())
ALLWISE = allwise_stars(Table.read(FIXTURES / "allwise_wise0855_cone.xml", format="votable"))
RA, DEC, SIZE_DEG = 133.795, -7.245, 0.05
MJD = 60800.7


def _sky(shape, stars, seed=1):
    """Unit Gaussian noise with Gaussian stars of the SPHEREx grid PSF at (x, y, amplitude)."""
    y, x = np.mgrid[: shape[0], : shape[1]]
    image = np.random.default_rng(seed).normal(0.0, 1.0, shape)
    sigma = FWHM_PX / 2.3548
    for sx, sy, amplitude in stars:
        image += amplitude * np.exp(-((x - sx) ** 2 + (y - sy) ** 2) / (2 * sigma**2))
    return image


def _pixel(grid, ra, dec):
    x, y = grid.world_to_pixel_values(ra, dec)
    return float(x), float(y)


def test_finds_every_injected_star_at_its_position_brightest_first():
    stars = [(10.3, 12.6, 40.0), (40.0, 30.2, 80.0), (25.7, 44.1, 20.0)]
    image = _sky((60, 60), stars)
    image[:, :4] = np.nan  # outside the cutout

    found, capped = detect(image)

    assert not capped
    assert [d.peak for d in found] == sorted((d.peak for d in found), reverse=True)
    for detection, (x, y, _) in zip(found, sorted(stars, key=lambda s: -s[2]), strict=True):
        assert abs(detection.x - x) < 0.25 and abs(detection.y - y) < 0.25
    assert found[0].snr > 50


def test_noise_alone_gives_no_source_and_the_cap_keeps_the_highest_peaks(monkeypatch):
    assert detect(_sky((60, 60), [])) == ([], False)

    monkeypatch.setattr(sources, "MAX_SOURCES", 2)
    found, capped = detect(_sky((60, 60), [(10, 10, 30.0), (30, 30, 90.0), (50, 50, 60.0)]))

    assert capped
    assert [round(d.peak, -1) for d in found] == [90.0, 60.0]


def test_labels_gaia_allwise_and_needs_verification_with_real_catalogue_answers():
    grid, shape = target_grid(RA, DEC, SIZE_DEG)
    gaia = min(GAIA, key=lambda s: s.mag)
    gaia_xy = _pixel(grid, *position_at(gaia.motion, MJD))
    # An AllWISE source with no Gaia DR3 star near it.
    wise = next(
        w
        for w in ALLWISE
        if min(np.hypot((w.ra - g.ra) * np.cos(np.radians(DEC)), w.dec - g.dec) for g in GAIA)
        > 3 * MATCH_RADIUS_ARCSEC / 3600
        and 3 < _pixel(grid, w.ra, w.dec)[0] < shape[1] - 3
        and 3 < _pixel(grid, w.ra, w.dec)[1] < shape[0] - 3
    )
    wise_xy = _pixel(grid, wise.ra, wise.dec)
    # A spot without any catalogue source within three match radii.
    empty = next(
        (x, y)
        for x in range(3, shape[1] - 3)
        for y in range(3, shape[0] - 3)
        if all(
            np.hypot(x - px, y - py) > 4.5
            for px, py in [_pixel(grid, s.ra, s.dec) for s in [*GAIA, *ALLWISE]]
        )
    )
    image = _sky(shape, [(*gaia_xy, 200.0), (*wise_xy, 100.0), (*empty, 50.0)])
    detections, _ = detect(image)

    labelled = label(detections, grid, shape, MJD, GAIA, ALLWISE)

    by_match = {s.match: s for s in labelled}
    assert by_match["gaia"].catalog_id == gaia.catalog_id
    assert by_match["gaia"].separation_arcsec < 2.0
    assert (by_match["gaia"].catalog_band, by_match["gaia"].catalog_mag) == (
        "G",
        round(gaia.mag, 3),
    )
    assert by_match["allwise"].catalog_id == wise.catalog_id
    assert by_match["allwise"].catalog_band == "W1"
    assert by_match["none"].catalog_id is None
    # Pixel positions refer to the PNG, whose top row is north (row 0 of the array is south).
    assert by_match["none"].x == pytest.approx(empty[0], abs=0.3)
    assert by_match["none"].y == pytest.approx(shape[0] - 1 - empty[1], abs=0.3)
    ra, dec = grid.pixel_to_world_values(*empty)
    assert by_match["none"].ra == pytest.approx(float(ra), abs=1e-4)
    assert by_match["none"].dec == pytest.approx(float(dec), abs=1e-4)


def test_the_brightest_catalogue_source_within_the_radius_beats_a_closer_faint_one():
    grid, shape = target_grid(RA, DEC, SIZE_DEG)
    detections, _ = detect(_sky(shape, [(14.0, 14.0, 100.0)]))
    ra, dec = (float(v) for v in grid.pixel_to_world_values(14.0, 14.0))
    stars = [
        CatalogStar("Gaia DR3 1", ra, dec + 1 / 3600, 19.4),
        CatalogStar("Gaia DR3 2", ra, dec - 4 / 3600, 12.3),
        CatalogStar("Gaia DR3 3", ra, dec + 2 * MATCH_RADIUS_ARCSEC / 3600, 5.0),
    ]

    (source,) = label(detections, grid, shape, MJD, stars, [])

    assert (source.match, source.catalog_id, source.catalog_mag) == ("gaia", "Gaia DR3 2", 12.3)
    assert source.separation_arcsec == pytest.approx(4.0, abs=0.6)


def test_a_missing_catalogue_leaves_unmatched_sources_unknown():
    grid, shape = target_grid(RA, DEC, SIZE_DEG)
    gaia = min(GAIA, key=lambda s: s.mag)
    detections, _ = detect(
        _sky(shape, [(*_pixel(grid, *position_at(gaia.motion, MJD)), 200.0), (5.0, 5.0, 80.0)])
    )

    assert {s.match for s in label(detections, grid, shape, MJD, None, None)} == {"unknown"}
    assert [s.match for s in label(detections, grid, shape, MJD, GAIA, None)] == [
        "gaia",
        "unknown",
    ]
    assert [s.match for s in label(detections, grid, shape, MJD, None, [])] == [
        "unknown",
        "unknown",
    ]


def test_catalogue_failures_and_timeouts_give_none_instead_of_an_exception(monkeypatch, tmp_path):
    def slow(*_):
        time.sleep(1.0)
        raise httpx.ConnectError("too late")

    monkeypatch.setattr(sources, "CATALOG_TIMEOUT_S", 0.2)
    monkeypatch.setattr(sources, "query_gaia", slow)
    started = time.monotonic()

    assert field_catalogs(RA, DEC, 0.04, tmp_path) == (None, None)
    assert time.monotonic() - started < 0.9
    assert not (tmp_path / "catalogs").exists()


def test_find_sources_reports_counts_and_an_unavailable_catalogue(monkeypatch, tmp_path):
    grid, shape = target_grid(RA, DEC, SIZE_DEG)
    images = [_sky(shape, [(10.0, 12.0, 60.0)], seed=seed) for seed in (1, 2)]
    monkeypatch.setattr(sources, "query_gaia", lambda *_: [])

    found, checks = find_sources(images, [MJD, MJD + 180], grid, shape, RA, DEC, SIZE_DEG, tmp_path)

    assert [[s.match for s in frame] for frame in found] == [["unknown"], ["unknown"]]
    assert [(c.code, c.severity) for c in checks] == [
        ("SOURCES", "info"),
        ("SOURCES_CATALOG_UNAVAILABLE", "info"),
    ]
    assert "2 detections in 2 frames" in checks[0].detail
    assert "AllWISE unavailable" in checks[0].detail
    assert "about 2010" in checks[0].detail
    assert checks[1].detail.startswith("AllWISE did not answer")


def test_no_source_means_no_catalogue_query_and_no_check(monkeypatch, tmp_path):
    grid, shape = target_grid(RA, DEC, SIZE_DEG)

    def never(*_):
        raise AssertionError("queried")

    monkeypatch.setattr(sources, "field_catalogs", never)

    assert find_sources([_sky(shape, [])], [MJD], grid, shape, RA, DEC, SIZE_DEG, tmp_path) == (
        [[]],
        [],
    )


def test_a_catalogue_answer_is_cached_per_field(tmp_path):
    first = cached_query(tmp_path, "gaia", lambda *_: GAIA, RA, DEC, 0.04)

    def down(*_):
        raise httpx.ConnectError("down")

    assert cached_query(tmp_path, "gaia", down, RA, DEC, 0.04) == first == GAIA
    with pytest.raises(httpx.ConnectError):
        cached_query(tmp_path, "gaia", down, RA, DEC, 0.05)


def test_a_resolved_neighbour_closer_than_two_and_a_half_fwhm_is_kept():
    found, _ = detect(_sky((40, 40), [(15.0, 20.0, 60.0), (19.5, 20.0, 30.0)]))

    assert len(found) == 2
    assert sorted(d.x for d in found) == [
        pytest.approx(15.0, abs=0.3),
        pytest.approx(19.5, abs=0.3),
    ]


def test_every_listed_detection_stands_five_sigma_above_the_noise():
    stars = [(8.0 + 6 * i, 10.0 + 5 * (i % 4), 4.0 + 1.5 * i) for i in range(8)]
    found, _ = detect(_sky((60, 60), stars, seed=7))

    assert found
    assert min(d.snr for d in found) >= THRESHOLD_SIGMA


def test_a_bright_saturated_star_matches_its_catalogue_star_a_few_pixels_away():
    grid, shape = target_grid(RA, DEC, SIZE_DEG)
    detections, _ = detect(_sky(shape, [(14.0, 14.0, 2 * BRIGHT_SNR), (21.0, 7.0, 50.0)]))
    bright = next(d for d in detections if d.snr >= BRIGHT_SNR)
    faint = next(d for d in detections if d.snr < BRIGHT_SNR)
    off = 2.0 * MATCH_RADIUS_ARCSEC / 3600  # inside 3 px, outside 1 px
    ra_b, dec_b = (float(v) for v in grid.pixel_to_world_values(bright.x, bright.y))
    ra_f, dec_f = (float(v) for v in grid.pixel_to_world_values(faint.x, faint.y))
    stars = [
        CatalogStar("Gaia DR3 bright", ra_b, dec_b + off, 8.2),
        CatalogStar("Gaia DR3 background", ra_b, dec_b - 3 / 3600, 20.6),
        CatalogStar("Gaia DR3 offset", ra_f, dec_f + off, 12.0),
    ]

    labels = {s.snr >= BRIGHT_SNR: s for s in label(detections, grid, shape, MJD, stars, [])}

    assert (labels[True].match, labels[True].catalog_id) == ("gaia", "Gaia DR3 bright")
    assert labels[False].match == "none"


def test_a_cut_catalogue_leaves_unmatched_sources_unknown(monkeypatch):
    grid, shape = target_grid(RA, DEC, SIZE_DEG)
    detections, _ = detect(_sky(shape, [(5.0, 5.0, 80.0)]))
    far = [
        CatalogStar("Gaia DR3 far", RA + 1, DEC, 10.0),
        CatalogStar("Gaia DR3 far2", RA + 2, DEC, 11.0),
    ]

    assert [s.match for s in label(detections, grid, shape, MJD, far, [])] == ["none"]
    monkeypatch.setattr(sources, "MAX_CATALOG_ROWS", 2)
    assert [s.match for s in label(detections, grid, shape, MJD, far, [])] == ["unknown"]
