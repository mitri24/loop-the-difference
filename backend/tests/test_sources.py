import time
from pathlib import Path

import httpx
import numpy as np
import pytest
from astropy.table import Table

from app import sources
from app.catalogs import position_at
from app.frames import Aligned, target_grid
from app.models import ProperMotion
from app.sources import (
    FWHM_PX,
    MATCH_RADIUS_ARCSEC,
    THRESHOLD_SIGMA,
    CatalogStar,
    allwise_stars,
    cached_query,
    catwise_stars,
    detect,
    field_catalogs,
    find_sources,
    gaia_stars,
    label,
    with_catwise_motion,
)

FIXTURES = Path(__file__).parent / "fixtures"
# Real answers for a 0.03° cone around WISE 0855-0714 (Gaia DR3 TAP CSV, IRSA Gator VOTable).
GAIA = gaia_stars((FIXTURES / "gaia_wise0855_cone.csv").read_text())
ALLWISE = allwise_stars(Table.read(FIXTURES / "allwise_wise0855_cone.xml", format="votable"))
# IRSA Gator's CatWISE2020 answer within 36″ of WISE 0855−0714's 2015 position (15 Nov 2026).
CATWISE = catwise_stars(Table.read(FIXTURES / "catwise_wise0855_cone.xml", format="votable"))
RA, DEC, SIZE_DEG = 133.795, -7.245, 0.05
MJD = 60800.7


def _star(shape, x, y, amplitude, fwhm=FWHM_PX):
    rows, cols = np.mgrid[: shape[0], : shape[1]]
    return amplitude * np.exp(-((cols - x) ** 2 + (rows - y) ** 2) / (2 * (fwhm / 2.3548) ** 2))


def _sky_image(shape, stars, seed=1):
    """Unit Gaussian noise with Gaussian stars of the SPHEREx grid PSF at (x, y, amplitude)."""
    image = np.random.default_rng(seed).normal(0.0, 1.0, shape)
    for star in stars:
        image += _star(shape, *star)
    return image


def _frame(image, covered=None):
    """Unit variance; NaN is sky outside the exposure unless `covered` says it is masked."""
    usable = np.isfinite(image)
    return Aligned(image, np.where(usable, 1.0, np.nan), usable if covered is None else covered)


def _sky(shape, stars, seed=1):
    return _frame(_sky_image(shape, stars, seed))


def _pixel(grid, ra, dec):
    x, y = grid.world_to_pixel_values(ra, dec)
    return float(x), float(y)


def test_finds_every_injected_star_at_its_position_brightest_first():
    stars = [(10.3, 12.6, 40.0), (40.0, 30.2, 80.0), (25.7, 44.1, 20.0)]
    image = _sky_image((60, 60), stars)
    image[:, :4] = np.nan  # outside the cutout

    found, capped = detect(_frame(image))

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
        CatalogStar("Gaia DR3 3", ra, dec + 4 * MATCH_RADIUS_ARCSEC / 3600, 5.0),
    ]

    (source,) = label(detections, grid, shape, MJD, stars, [])

    assert (source.match, source.catalog_id, source.catalog_mag) == ("gaia", "Gaia DR3 2", 12.3)
    assert source.separation_arcsec == pytest.approx(4.0, abs=0.6)


def _labelled_near(stars):
    """One detection at pixel (14, 14) labelled against Gaia stars (offset ″ north, G)."""
    grid, shape = target_grid(RA, DEC, SIZE_DEG)
    detections, _ = detect(_sky(shape, [(14.0, 14.0, 100.0)]))
    ra, dec = (float(v) for v in grid.pixel_to_world_values(14.0, 14.0))
    catalogue = [
        CatalogStar(f"Gaia DR3 {mag}", ra, dec + north / 3600, mag) for north, mag in stars
    ]
    (source,) = label(detections, grid, shape, MJD, catalogue, [])
    return source


def test_a_star_brighter_than_g10_claims_a_detection_up_to_3_px_away():
    source = _labelled_near([(12.0, 8.2)])
    assert (source.match, source.catalog_id) == ("gaia", "Gaia DR3 8.2")
    assert source.separation_arcsec == pytest.approx(12.0, abs=0.6)


@pytest.mark.parametrize("mag", [15.0, 10.0, None])
def test_a_star_not_brighter_than_g10_12_arcsec_away_does_not_match(mag):
    assert _labelled_near([(12.0, mag)]).match == "none"


def test_a_bright_star_3_px_away_beats_a_faint_one_close_by():
    assert _labelled_near([(4.0, 19.0), (-12.0, 8.0)]).catalog_id == "Gaia DR3 8.0"


def test_the_bright_radius_applies_to_allwise_below_w1_8():
    grid, shape = target_grid(RA, DEC, SIZE_DEG)
    detections, _ = detect(_sky(shape, [(14.0, 14.0, 100.0)]))
    ra, dec = (float(v) for v in grid.pixel_to_world_values(14.0, 14.0))
    wise = [CatalogStar("AllWISE 7", ra, dec + 12 / 3600, 7.0)]
    faint = [CatalogStar("AllWISE 9", ra, dec + 12 / 3600, 9.0)]
    assert label(detections, grid, shape, MJD, [], wise)[0].catalog_id == "AllWISE 7"
    assert label(detections, grid, shape, MJD, [], faint)[0].match == "none"


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


def test_the_threshold_follows_the_variance_of_each_pixel():
    image = _sky_image((60, 60), [(15.0, 30.0, 12.0), (45.0, 30.0, 12.0)])
    # The right half is 4× noisier, e.g. fewer exposures were stacked there.
    image[:, 30:] += np.random.default_rng(2).normal(0.0, np.sqrt(15.0), (60, 30))
    variance = np.where(np.arange(60) < 30, 1.0, 16.0) * np.ones((60, 1))

    found, _ = detect(Aligned(image, variance, np.ones(image.shape, dtype=bool)))

    # The same star stands out in the quiet half and not in the noisy one.
    assert [(round(d.x), round(d.y)) for d in found] == [(15, 30)]


def test_a_structured_sky_neither_hides_stars_nor_adds_any():
    stars = [(8.0 + 9 * (i % 8), 8.0 + 9 * (i // 8), 12.0) for i in range(64)]
    rows, cols = np.mgrid[:80, :80]
    # A 10σ ramp across the field and a broad 8σ halo, as from a nebula or a bright star.
    sky = 10 * (cols / 79 - 0.5) + 8 * np.exp(-((cols - 55) ** 2 + (rows - 25) ** 2) / (2 * 12**2))

    found, _ = detect(_frame(_sky_image((80, 80), stars) + sky))

    assert len(found) == 64
    assert all(min(np.hypot(d.x - x, d.y - y) for x, y, _ in stars) < 0.5 for d in found)


@pytest.mark.parametrize("level", [0.8, 0.3])  # its peak pixel only; its four brightest pixels
def test_a_masked_core_does_not_move_the_centroid(level):
    x, y = 20.3, 20.6
    image = _sky_image((41, 41), [(x, y, 400.0)])
    image[_star((41, 41), x, y, 400.0) > level * 400.0] = np.nan  # flagged, e.g. saturated

    (found,), _ = detect(_frame(image, covered=np.ones(image.shape, dtype=bool)))

    assert (found.x, found.y) == (pytest.approx(x, abs=0.1), pytest.approx(y, abs=0.1))
    assert found.snr > 10


def test_a_saturated_core_too_large_to_fit_is_placed_by_its_rim():
    x, y = 20.3, 20.6
    star = _star((41, 41), x, y, 1e5) + _star((41, 41), x, y, 300.0, fwhm=6.0)  # core and wings
    image = _sky_image((41, 41), [(8.0, 33.0, 40.0)]) + star
    image[star > 100.0] = np.nan  # a 7×7 saturated core

    found, _ = detect(_frame(image, covered=np.ones(image.shape, dtype=bool)))

    near = [d for d in found if np.hypot(d.x - x, d.y - y) < 10]
    assert len(near) == 1  # one source, no spurious peaks on the rim of the core
    assert (near[0].x, near[0].y) == (pytest.approx(x, abs=0.3), pytest.approx(y, abs=0.3))
    assert [(round(d.x), round(d.y)) for d in found if d not in near] == [(8, 33)]
    grid, shape = target_grid(RA, DEC, SIZE_DEG)
    labelled = label(found, grid, shape, MJD, [], [])
    assert [s.saturated for s in labelled] == [d in near for d in found]


def test_a_saturated_core_cut_by_the_grid_edge_is_skipped():
    x, y = 4.3, 20.6  # the 7×7 core reaches column 1: its rim would only lie on one side
    star = _star((41, 41), x, y, 1e5) + _star((41, 41), x, y, 300.0, fwhm=6.0)
    image = _sky_image((41, 41), []) + star
    image[star > 100.0] = np.nan

    found, _ = detect(_frame(image, covered=np.ones(image.shape, dtype=bool)))

    assert [d for d in found if np.hypot(d.x - x, d.y - y) < 10] == []


def test_the_local_sky_in_row_blocks_equals_one_block_and_the_median(monkeypatch):
    image = _sky_image((40, 37), [(12.0, 20.0, 50.0)])
    image[np.random.default_rng(5).random(image.shape) < 0.2] = np.nan
    image[:, :6] = np.nan  # outside the exposure: some squares hold no usable pixel
    monkeypatch.setattr(sources, "SKY_ROWS", 40)
    whole = sources._local_sky(_frame(image))
    monkeypatch.setattr(sources, "SKY_ROWS", 7)

    assert np.array_equal(sources._local_sky(_frame(image)), whole)
    padded = np.pad(image, sources.SKY_BOX_PX // 2, constant_values=np.nan)
    squares = np.lib.stride_tricks.sliding_window_view(padded, (11, 11)).reshape(40, 37, -1)
    with pytest.warns(RuntimeWarning, match="All-NaN"):
        median = np.nanmedian(squares, axis=-1)
    assert np.array_equal(whole, np.nan_to_num(median, nan=0.0))


def test_a_g8_star_matches_its_detection_2_px_away_a_g12_star_does_not():
    grid, shape = target_grid(RA, DEC, SIZE_DEG)
    detections, _ = detect(_sky(shape, [(14.0, 14.0, 600.0), (21.0, 7.0, 50.0)]))
    bright, faint = detections
    off = 2.0 * MATCH_RADIUS_ARCSEC / 3600  # inside 3 px, outside 1 px
    ra_b, dec_b = (float(v) for v in grid.pixel_to_world_values(bright.x, bright.y))
    ra_f, dec_f = (float(v) for v in grid.pixel_to_world_values(faint.x, faint.y))
    stars = [
        CatalogStar("Gaia DR3 bright", ra_b, dec_b + off, 8.2),
        CatalogStar("Gaia DR3 background", ra_b, dec_b - 3 / 3600, 20.6),
        CatalogStar("Gaia DR3 offset", ra_f, dec_f + off, 12.0),
    ]

    bright_label, faint_label = label(detections, grid, shape, MJD, stars, [])

    assert (bright_label.match, bright_label.catalog_id) == ("gaia", "Gaia DR3 bright")
    assert faint_label.match == "none"


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


def test_catwise_keeps_the_sources_that_move_above_3_sigma_in_mas_per_year_at_their_epoch():
    fast = next(s for s in CATWISE if s.catalog_id == "CatWISE2020 J085507.96-071439.3")

    assert len(CATWISE) == 9  # of 21 rows: the others move below 3σ
    assert (fast.motion.pmra_mas_yr, fast.motion.pmdec_mas_yr) == pytest.approx((-8021.2, 1035.7))
    assert fast.motion.ref_epoch == pytest.approx(2015.86, abs=0.01)


def test_allwise_takes_the_motion_of_the_fastest_catwise_source_it_was_in_2010():
    moved = with_catwise_motion(ALLWISE, CATWISE)
    wise0855 = next(s for s in moved if s.catalog_id == "AllWISE J085510.74-071442.5")

    # Not the slow 0.27″/yr fragment 1.3″ away: the 8″/yr one that stood there in 2010.
    assert wise0855.motion.pmra_mas_yr == pytest.approx(-8021.2)
    assert (wise0855.motion.ra, wise0855.motion.dec, wise0855.motion.ref_epoch) == (
        wise0855.ra,
        wise0855.dec,
        2010.5,
    )
    assert [s.catalog_id for s in moved if s.motion] == ["AllWISE J085510.74-071442.5"]
    assert with_catwise_motion(ALLWISE, []) == ALLWISE


def test_a_moving_allwise_source_matches_where_it_is_at_the_frame_date():
    grid, shape = target_grid(RA, DEC, SIZE_DEG)
    star = sources.CatalogStar("AllWISE J1", RA, DEC, 15.0)
    # 2″/yr west: about 30″ from its 2010.5 place at the frame's date, five match radii.
    west_2015 = RA - 10 / 3600 / np.cos(np.radians(DEC))
    motion = ProperMotion(
        source_id="J1",
        ra=west_2015,
        dec=DEC,
        ref_epoch=2015.5,
        pmra_mas_yr=-2000.0,
        pmdec_mas_yr=0.0,
        parallax_mas=None,
    )
    moved = with_catwise_motion(
        [star], [sources.CatalogStar("CatWISE2020 J1", west_2015, DEC, None, motion)]
    )
    image = _sky(shape, [(*_pixel(grid, *position_at(moved[0].motion, MJD)), 100.0)])
    detections, _ = detect(image)

    assert label(detections, grid, shape, MJD, [], moved)[0].catalog_id == "AllWISE J1"
    assert label(detections, grid, shape, MJD, [], [star])[0].match == "none"
