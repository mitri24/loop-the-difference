"""Changes between A and B (app/difference.py) on synthetic cutouts that are aligned like real
ones: stars at other detector rotations and PSFs, one transient, known objects (no network).

The ePSF tables are built like the archive's EPSF extension (see test_psf.py)."""

import ast
import json
import os
from pathlib import Path

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS
from PIL import Image
from rq.exceptions import NoSuchJobError
from scipy.special import ndtr

from app import difference, jobs, psf, smallbodies
from app.config import Settings
from app.difference import PairUnavailableError, build_difference, find_changes
from app.frames import (
    align,
    aligned_path,
    cutout_path,
    cutout_url,
    load_aligned,
    read_image,
    save_aligned,
    target_grid,
)
from app.models import (
    DetectedSource,
    Difference,
    Frame,
    FrameManifest,
    Observation,
    SmallBodiesJob,
    SmallBody,
    SmallBodyEpoch,
)
from app.tasks import manifest_path, stack_images

RA, DEC, SIZE_DEG = 133.795, -7.245, 0.2
SCALE_DEG = 6.15 / 3600
CUTOUT_PX = 167  # the 117 px grid at any rotation
JOB = "0123456789abcdef"
ANALYSIS = Path(__file__).resolve().parents[2] / "analysis-service" / "app"
SHARED = {
    "analysis.py": (
        "RESIDUAL_SIGMA",
        "SSO_PARALLAX_ARCSEC",
        "SSO_VMAG_LIMIT",
        "SYSTEMATIC_FRACTION",
        "MATCH_RADIUS_PX",
        "BRIGHT_G",
        "REGISTRATION_MIN_STARS",
        "UNMEASURED_REGISTRATION_PX",
        "_filled",
        "_find_residual_peaks",
        "bright_radius_px",
        "measure_offset",
        "register",
        "photometric_scale",
        "_convolved",
    ),
    "imaging.py": ("grid_psf",),
}
TRANSIENT_PX = (40.3, 70.6)  # grid pixel (x, y), 6 px or more from every star


def pixel_gaussian(sx: float, sy: float, ov: int = 5, n: int = 33) -> np.ndarray:
    d = (np.arange(n) - (n - 1) / 2) / ov
    e = np.outer(
        ndtr((d + 0.5) / sy) - ndtr((d - 0.5) / sy), ndtr((d + 0.5) / sx) - ndtr((d - 0.5) / sx)
    )
    return e / e.sum()


def epsf_table(sigma: tuple[float, float]) -> fits.BinTableHDU:
    zones = [(ix, iy) for iy in range(3) for ix in range(2)]
    hdu = fits.BinTableHDU.from_columns(
        [
            fits.Column("XCENTER", "E", array=[(ix + 0.5) * 1020 - 0.5 for ix, _ in zones]),
            fits.Column("YCENTER", "E", array=[(iy + 0.5) * 680 - 0.5 for _, iy in zones]),
            fits.Column(
                "EPSF",
                "1089D",
                dim="(33,33)",
                array=np.array([pixel_gaussian(*sigma)] * len(zones)),
            ),
        ],
        name="EPSF",
    )
    hdu.header["OVSMPX"] = hdu.header["OVSMPY"] = 5
    return hdu


def _field(seed: int):
    """40 stars of 0.3–40 MJy/sr·px total flux on the grid, none within 6 px of the transient."""
    grid, (npix, _) = target_grid(RA, DEC, SIZE_DEG)
    rng = np.random.default_rng(seed)
    stars = rng.uniform(8, npix - 8, (90, 2))
    stars = stars[np.hypot(*(stars - TRANSIENT_PX).T) > 6][:40]
    fluxes = 10 ** rng.uniform(-0.5, 1.6, len(stars))
    return (
        grid,
        stars,
        [(*grid.pixel_to_world_values(x, y), f) for (x, y), f in zip(stars, fluxes, strict=True)],
    )


def _cutout(path, sky, rotation, sigma, seed, epsf=True, extra=()):
    """A cutout at this detector rotation: the sky's stars (and extra sources) drawn with the ePSF
    of this σ, noise 0.02, sky level 3; its EPSF table unless epsf is False."""
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [RA, DEC]
    wcs.wcs.crpix = [(CUTOUT_PX + 1) / 2] * 2
    angle = np.radians(rotation)
    wcs.wcs.cd = SCALE_DEG * np.array(
        [[-np.cos(angle), np.sin(angle)], [np.sin(angle), np.cos(angle)]]
    )
    model = psf.EPSF(pixel_gaussian(*sigma), (5, 5))
    image = 3.0 + np.random.default_rng(seed).normal(0, 0.02, (CUTOUT_PX, CUTOUT_PX))
    for ra, dec, flux in [*sky, *extra]:
        x, y = wcs.world_to_pixel_values(ra, dec)
        image += flux * psf.pixel_psf(model, float(x), float(y), image.shape)
    header = wcs.to_header()
    header.update(CRPIX1A=-1000.0, CRPIX2A=-500.0, CRVAL1A=0.0, CRVAL2A=0.0)
    hdus = [
        fits.PrimaryHDU(),
        fits.ImageHDU(image.astype(np.float32), header, name="IMAGE"),
        fits.ImageHDU(np.full(image.shape, 0.02**2, np.float32), name="VARIANCE"),
    ]
    if epsf:
        hdus.append(epsf_table(sigma))
    fits.HDUList(hdus).writeto(path, overwrite=True)
    return path


def _frame(index: int, mjd: float, epoch: int, wavelength: float = 4.7, **extra) -> Frame:
    return Frame(
        index=index,
        url=f"/api/frames/{JOB}/frame_{index:02d}.png",
        obs_id=f"obs-{index}",
        date=f"mjd {mjd}",
        mjd=mjd,
        detector=6,
        wavelength_min_um=4.4,
        wavelength_max_um=5.0,
        coverage=1.0,
        source_url=f"https://irsa.invalid/{index}",
        epoch=epoch,
        wavelength_um=wavelength,
        **extra,
    )


def _aligned(path: Path):
    grid, shape = target_grid(RA, DEC, SIZE_DEG)
    data, variance, wcs, _ = read_image(path)
    return align(data, variance, wcs, grid, shape)


def _job(
    cache_dir: Path, cutouts: list[Path], frames: list[Frame], differences=()
) -> FrameManifest:
    """A finished frames job as build_frames leaves it: manifest and aligned frames."""
    folder = manifest_path(cache_dir, JOB).parent
    folder.mkdir(parents=True, exist_ok=True)
    for index, path in enumerate(cutouts):
        save_aligned(aligned_path(folder, index), _aligned(path), [path.name], [1])
    manifest = FrameManifest(
        collection="spherex_dr1",
        ra=RA,
        dec=DEC,
        size_deg=SIZE_DEG,
        detector=6,
        pixel_scale_arcsec=6.15,
        epochs=len({f.epoch for f in frames}),
        frames=frames,
        warnings=[],
        differences=list(differences),
    )
    (folder / "manifest.json").write_text(manifest.model_dump_json())
    return manifest


def _pair(tmp_path, rotations=(20, 140), epsf=True, transient=1.0, wavelengths=(4.7, 4.7)):
    """A and B half a year apart: the same stars at two rotations and two elliptical PSFs, a
    transient in B only."""
    cutouts = tmp_path / "cutouts"
    cutouts.mkdir(exist_ok=True)
    grid, stars, sky = _field(seed=sum(rotations))
    spot = [(*grid.pixel_to_world_values(*TRANSIENT_PX), transient)] if transient else []
    paths = [
        _cutout(cutouts / "a.fits", sky, rotations[0], (0.5, 0.6), 1, epsf),
        _cutout(cutouts / "b.fits", sky, rotations[1], (0.65, 0.55), 2, epsf, spot),
    ]
    frames = [_frame(0, 60900.0, 0, wavelengths[0]), _frame(1, 61090.0, 1, wavelengths[1])]
    return _job(tmp_path, paths, frames), stars


def _changes(tmp_path, manifest, small_bodies=None, a=0, b=1):
    folder = manifest_path(tmp_path, JOB).parent
    settings = Settings(redis_url="redis://127.0.0.1:1/0", cache_dir=tmp_path)
    return find_changes(folder, manifest, JOB, a, b, small_bodies, settings)


def _near(residual, xy, npix: int = 117, radius: float = 2.0) -> bool:
    # Residuals are in PNG pixels: y runs downwards.
    return np.hypot(residual.x - xy[0], npix - 1 - residual.y - xy[1]) <= radius


@pytest.mark.parametrize("rotations", [(20, 140), (65, 200), (170, 355)])
def test_zogy_finds_the_transient_and_leaves_no_residual_at_the_stars(tmp_path, rotations):
    manifest, stars = _pair(tmp_path, rotations)

    result = _changes(tmp_path, manifest)

    assert (result.method, result.comparable) == ("zogy", True)
    (transient,) = result.residuals
    assert _near(transient, TRANSIENT_PX, radius=1.0)
    assert transient.significance > 5  # positive: brighter in B
    assert transient.kind == "unknown"
    assert transient.explanation.startswith("Brighter in B. No known asteroid")
    assert not any(_near(r, star, radius=3.0) for r in result.residuals for star in stars)
    assert [c.message for c in result.checks if c.code == "PAIR_METHOD"] == [
        "Significance: PSF-matched difference (ZOGY)"
    ]


def test_without_an_epsf_the_direct_difference_flags_the_stars(tmp_path):
    manifest, stars = _pair(tmp_path, epsf=False)

    result = _changes(tmp_path, manifest)

    assert result.method == "direct"
    assert "PAIR_PSF_UNAVAILABLE" in [c.code for c in result.checks]
    at_stars = sum(any(_near(r, star, radius=3.0) for r in result.residuals) for star in stars)
    assert at_stars >= 5


def test_images_go_to_the_frames_folder_on_a_diverging_scale(tmp_path):
    manifest, _ = _pair(tmp_path)

    result = _changes(tmp_path, manifest)

    folder = manifest_path(tmp_path, JOB).parent
    revision = difference.pair_revision(folder, manifest, 0, 1)
    sig_name, diff_name = difference.image_names(0, 1, "_" + revision)
    assert result.significance_url == f"/api/frames/{JOB}/{sig_name}"
    assert result.difference_url == f"/api/frames/{JOB}/{diff_name}"
    pixels = np.asarray(Image.open(folder / sig_name))
    x, y = round(TRANSIENT_PX[0]), 116 - round(TRANSIENT_PX[1])
    assert pixels[y, x][2] > pixels[y, x][0]  # blue: brighter in B
    assert (folder / diff_name).is_file()


def test_a_pair_at_different_wavelengths_gets_its_reason_and_images_but_no_residuals(tmp_path):
    manifest, _ = _pair(tmp_path, wavelengths=(4.60, 4.70))

    result = _changes(tmp_path, manifest)

    assert not result.comparable
    assert result.reason == "A and B were observed at different wavelengths (Δλ 2.2 %)"
    assert result.residuals == []
    assert result.delta_lambda_pct == pytest.approx(2.151, abs=1e-3)
    assert list(manifest_path(tmp_path, JOB).parent.glob("pairsig_00_01_v1_*.png"))


def _source(xy, match, catalog_id=None, mag=None, band=None, saturated=False) -> DetectedSource:
    return DetectedSource(
        ra=RA,
        dec=DEC,
        x=xy[0],
        y=116 - xy[1],
        peak_mjy_sr=1.0,
        snr=50.0,
        saturated=saturated,
        match=match,
        catalog_id=catalog_id,
        catalog_mag=mag,
        catalog_band=band,
    )


def test_residuals_are_explained_by_a_known_asteroid_a_bright_star_or_a_catalogue_source(
    tmp_path,
):
    cutouts = tmp_path / "cutouts"
    cutouts.mkdir()
    grid, _ = target_grid(RA, DEC, SIZE_DEG)
    spots = {"asteroid": (25.0, 30.0), "bright": (90.0, 30.0), "star": (25.0, 90.0)}
    spots["unknown"] = TRANSIENT_PX
    extra = [(*grid.pixel_to_world_values(*xy), 1.5) for xy in spots.values()]
    paths = [
        _cutout(cutouts / "a.fits", [], 30, (0.55, 0.55), 1),
        _cutout(cutouts / "b.fits", [], 30, (0.55, 0.55), 2, extra=extra),
    ]
    bright = (spots["bright"][0] + 4, spots["bright"][1])  # 4 px from a G 9 star
    sources = [
        _source(bright, "gaia", "Gaia DR3 9", 9.0, "G"),
        _source(spots["star"], "allwise", "AllWISE J1", 11.0, "W1"),
    ]
    frames = [_frame(0, 60900.0, 0), _frame(1, 61090.0, 1, sources=sources)]
    manifest = _job(tmp_path, paths, frames)
    body_ra, body_dec = (float(v) for v in grid.pixel_to_world_values(*spots["asteroid"]))
    body = SmallBody(
        name="(433) Eros",
        ra=body_ra,
        dec=body_dec,
        vmag=15.0,
        ra_rate=0,
        dec_rate=0,
        distance_arcsec=0,
    )
    faint = body.model_copy(update={"name": "faint", "vmag": 22.0})
    epochs = [
        SmallBodyEpoch(mjd=60900.0, date="a", bodies=[], source_url="u"),
        SmallBodyEpoch(mjd=61090.2, date="b", bodies=[faint, body], source_url="u"),
    ]

    result = _changes(tmp_path, manifest, epochs)

    kinds = {
        name: [(r.kind, r.known) for r in result.residuals if _near(r, xy)]
        for name, xy in spots.items()
    }
    assert kinds == {
        "asteroid": [("asteroid", "(433) Eros")],
        "bright": [("bright_star", "Gaia DR3 9")],
        "star": [("known_star", "AllWISE J1")],
        "unknown": [("unknown", None)],
    }
    assert result.small_bodies_checked
    (unknown,) = [r for r in result.residuals if r.kind == "unknown"]
    assert "not checked" not in unknown.explanation


def test_without_a_small_body_lookup_the_explanation_says_so(tmp_path):
    manifest, _ = _pair(tmp_path)

    (transient,) = _changes(tmp_path, manifest).residuals

    assert transient.explanation.endswith("Known asteroids were not checked at A's and B's times.")


def _queue(monkeypatch) -> list:
    """Record what is enqueued; no job is known to Redis."""
    queued = []

    class Queue:
        count = 0

        def __init__(self, name, **_):
            self.name = name

        def enqueue(self, function, **options):
            queued.append((self.name, function, options))

    monkeypatch.setattr(jobs, "Queue", Queue)
    monkeypatch.setattr(jobs.Job, "fetch", lambda *_, **__: (_ for _ in ()).throw(NoSuchJobError))
    return queued


def test_a_finished_difference_is_cached_and_served_without_the_queue(
    client, monkeypatch, settings, tmp_path
):
    _pair(tmp_path)
    queued = _queue(monkeypatch)
    monkeypatch.setattr(difference, "get_settings", lambda: settings)
    request = {"job_id": JOB, "a": 0, "b": 1}

    first = client.post("/api/difference", json=request).json()

    ((queue, function, options),) = queued
    assert (first["status"], queue, function) == ("queued", jobs.QUEUE_NAME, build_difference)
    assert options["job_id"] == first["job_id"]
    result = build_difference(**options["kwargs"])
    again = client.post("/api/difference", json=request).json()
    polled = client.get(f"/api/difference/{first['job_id']}").json()
    assert len(queued) == 1
    assert again["status"] == polled["status"] == "finished"
    assert again["difference"] == polled["difference"] == json.loads(json.dumps(result))
    png = client.get(polled["difference"]["significance_url"])
    assert (png.status_code, png.headers["content-type"]) == (200, "image/png")
    assert client.get("/api/difference/not-a-job").status_code == 404


@pytest.mark.parametrize("state", ["started", "finished"])
def test_a_finished_small_body_lookup_goes_into_the_job_and_its_id(
    client, monkeypatch, tmp_path, state
):
    _pair(tmp_path)
    epoch = SmallBodyEpoch(mjd=61090.0, date="b", bodies=[], source_url="u")
    lookup = SmallBodiesJob(job_id="fedcba9876543210", status=state, epochs=[epoch])
    monkeypatch.setattr(smallbodies, "status", lambda redis, job_id: lookup)
    queued = _queue(monkeypatch)

    body = {"job_id": JOB, "a": 0, "b": 1, "small_bodies_job": lookup.job_id}
    answer = client.post("/api/difference", json=body).json()

    finished = state == "finished"
    assert answer["job_id"] == jobs.difference_job_id(
        JOB,
        0,
        1,
        lookup.job_id if finished else None,
        difference.pair_revision(
            manifest_path(tmp_path, JOB).parent,
            FrameManifest.model_validate_json(manifest_path(tmp_path, JOB).read_text()),
            0,
            1,
        ),
    )
    expected = [epoch.model_dump()] if finished else None
    assert queued[0][2]["kwargs"]["small_bodies"] == expected
    assert jobs.difference_job_id(JOB, 1, 0, None) != jobs.difference_job_id(JOB, 0, 1, None)


@pytest.mark.parametrize(
    ("request_body", "status"),
    [
        ({"job_id": JOB, "a": 1, "b": 1}, 422),
        ({"job_id": JOB, "a": 0, "b": 5}, 422),
        ({"job_id": "not-a-job", "a": 0, "b": 1}, 422),
        ({"job_id": "fedcba9876543210", "a": 0, "b": 1}, 404),
    ],
)
def test_a_pair_outside_a_finished_job_is_refused(client, tmp_path, request_body, status):
    _job(tmp_path, [], [_frame(0, 60900.0, 0), _frame(1, 61090.0, 1)])

    assert client.post("/api/difference", json=request_body).status_code == status


def _observation(index: int, mjd: float) -> Observation:
    return Observation(
        obs_id=f"obs-{index}",
        detector=6,
        wavelength_min_um=4.4,
        wavelength_max_um=5.0,
        mjd=mjd,
        date=f"mjd {mjd}",
        access_url=f"https://irsa.invalid/{index}.fits",
    )


def _cached_cutouts(tmp_path, observations, rotations, transient_in=()):
    """Cutouts in the cutout cache under their URLs, as the frames job downloaded them."""
    grid, _, sky = _field(seed=4)
    spot = [(*grid.pixel_to_world_values(*TRANSIENT_PX), 1.0)]
    cache = tmp_path / "cutouts"
    cache.mkdir(exist_ok=True)
    urls = []
    for k, (obs, rotation) in enumerate(zip(observations, rotations, strict=True)):
        url = cutout_url(obs.access_url, RA, DEC, SIZE_DEG)
        extra = spot if k in transient_in else ()
        _cutout(cutout_path(cache, url), sky, rotation, (0.55, 0.55), k, extra=extra)
        urls.append(url)
    return urls


def test_a_job_from_before_the_aligned_frames_gets_them_from_its_cached_cutouts(tmp_path):
    observations = [_observation(0, 60900.0), _observation(1, 61090.0)]
    urls = _cached_cutouts(tmp_path, observations, (20, 140), transient_in=(1,))
    frames = [
        _frame(0, 60900.0, 0).model_copy(update={"source_url": urls[0]}),
        _frame(1, 61090.0, 1).model_copy(update={"source_url": urls[1]}),
    ]
    manifest = _job(tmp_path, [], frames)

    (transient,) = _changes(tmp_path, manifest).residuals

    assert _near(transient, TRANSIENT_PX, radius=1.0) and transient.significance > 5
    stored, cutouts, _ = load_aligned(aligned_path(manifest_path(tmp_path, JOB).parent, 1))
    np.testing.assert_array_equal(
        stored.image, _aligned(cutout_path(tmp_path / "cutouts", urls[1])).image.astype(np.float32)
    )
    assert cutouts == [cutout_path(tmp_path / "cutouts", urls[1]).name]


def test_a_stack_is_stacked_again_from_the_exposures_its_job_names(monkeypatch, tmp_path):
    observations = [_observation(i, 60900.0 + i) for i in range(2)]
    observations += [_observation(i, 61090.0 + i) for i in range(2, 4)]
    _cached_cutouts(tmp_path, observations, (20, 30, 140, 150), transient_in=(2, 3))
    found = [*observations, observations[0].model_copy(update={"detector": 5})]
    monkeypatch.setattr(difference, "search_observations", lambda *args: (found, []))
    frames = [_frame(0, 60900.5, 0, n_combined=2), _frame(1, 61090.5, 1, n_combined=2)]
    pair = Difference(
        a=0,
        b=1,
        url="u",
        comparable=True,
        obs_ids_a=["obs-0", "obs-1"],
        obs_ids_b=["obs-2", "obs-3"],
    )
    manifest = _job(tmp_path, [], frames, [pair])

    (transient,) = _changes(tmp_path, manifest).residuals

    assert _near(transient, TRANSIENT_PX, radius=1.0)
    stored, cutouts, weights = load_aligned(aligned_path(manifest_path(tmp_path, JOB).parent, 0))
    paths = [
        cutout_path(tmp_path / "cutouts", cutout_url(o.access_url, RA, DEC, SIZE_DEG))
        for o in observations[:2]
    ]
    assert cutouts == [path.name for path in paths] and len(weights) == 2
    expected = stack_images([_aligned(path) for path in paths]).image
    np.testing.assert_array_equal(stored.image, expected.astype(np.float32))


def test_a_pair_whose_cutouts_are_gone_says_so(tmp_path):
    manifest = _job(tmp_path, [], [_frame(0, 60900.0, 0), _frame(1, 61090.0, 1)])

    with pytest.raises(PairUnavailableError, match="cutouts of image 1 are no longer cached"):
        _changes(tmp_path, manifest)


def test_the_shared_blocks_are_the_same_as_in_the_analysis_service():
    # The api image holds the backend only; the CI checkout (CI=true) must hold both.
    if not ANALYSIS.exists() and not os.environ.get("CI"):
        pytest.skip("analysis-service is not in this checkout")

    ours = _definitions(Path(difference.__file__))
    theirs = {file: _definitions(ANALYSIS / file) for file in SHARED}
    differ = [n for file, names in SHARED.items() for n in names if ours[n] != theirs[file].get(n)]

    assert differ == []


def _definitions(path: Path) -> dict[str, str]:
    tree = ast.parse(path.read_text())
    found = {}
    for node in tree.body:
        if isinstance(node, ast.FunctionDef | ast.ClassDef):
            found[node.name] = ast.dump(node)
        elif isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name):
            found[node.targets[0].id] = ast.dump(node.value)
    return found


def test_rebuilt_pixels_invalidate_result_and_image_cache(tmp_path):
    manifest, _ = _pair(tmp_path)
    folder = manifest_path(tmp_path, JOB).parent
    before = difference.pair_revision(folder, manifest, 0, 1)
    original = _changes(tmp_path, manifest)
    path = aligned_path(folder, 1)
    # Same frame numbers and metadata; a new set of aligned pixels must still invalidate it.
    path.write_bytes(path.read_bytes() + b"rebuilt")
    after = difference.pair_revision(folder, manifest, 0, 1)
    assert before != after
    assert jobs.difference_job_id(JOB, 0, 1, None, before) != jobs.difference_job_id(
        JOB, 0, 1, None, after
    )
    assert before in original.significance_url
    assert difference.image_names(0, 1, "_" + before) != difference.image_names(0, 1, "_" + after)


def test_difference_version_invalidates_job_and_image_names(monkeypatch):
    key = jobs.difference_job_id(JOB, 0, 1, None)
    names = difference.image_names(0, 1)
    monkeypatch.setattr(jobs, "DIFFERENCE_VERSION", jobs.DIFFERENCE_VERSION + 1)
    monkeypatch.setattr(difference, "DIFFERENCE_VERSION", difference.DIFFERENCE_VERSION + 1)
    assert jobs.difference_job_id(JOB, 0, 1, None) != key
    assert difference.image_names(0, 1) != names


def test_queued_pair_refuses_inputs_rebuilt_before_worker_starts(tmp_path, monkeypatch, settings):
    manifest, _ = _pair(tmp_path)
    folder = manifest_path(tmp_path, JOB).parent
    revision = difference.pair_revision(folder, manifest, 0, 1)
    manifest.frames[0].obs_id = "replacement-observation"
    (folder / "manifest.json").write_text(manifest.model_dump_json())
    monkeypatch.setattr(difference, "get_settings", lambda: settings)
    with pytest.raises(difference.PairUnavailableError, match="images changed"):
        build_difference("cachekey", JOB, 0, 1, revision=revision)


def test_mask_margin_excludes_a_peak_beside_a_masked_pixel(tmp_path, monkeypatch):
    manifest, _ = _pair(tmp_path)

    def significance(*args):
        sig = np.zeros((117, 117))
        sig[50, 50] = np.nan
        sig[50, 51] = 12
        sig[70, 70] = 11
        return sig, np.nan_to_num(sig), 1.0

    monkeypatch.setattr(difference, "significance", significance)
    result = _changes(tmp_path, manifest)
    assert len(result.residuals) == 1
    assert result.residuals[0].significance == pytest.approx(11)
