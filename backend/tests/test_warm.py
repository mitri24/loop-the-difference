import json

import pytest

from app import warm
from app.archive import sia_cache_path
from app.catalogs import gaia_cache_path
from app.coords import parse_dec, parse_ra
from app.jobs import job_id_for
from app.models import Frame, FrameManifest
from app.tasks import PIPELINE_VERSION, manifest_path

POLARIS = ("spherex_dr1", parse_ra("02:31:49.09"), parse_dec("+89:15:50.8"), 0.2)
POLARIS_D6 = job_id_for(*POLARIS, 6, 12)
POLARIS_D6_STACKS = job_id_for(*POLARIS, 6, 12, stack=True)


@pytest.fixture(autouse=True)
def spectra(monkeypatch):
    """Every run also builds one spectrum per target: record it instead of downloading."""
    calls = []

    def build_spectrum(ra, dec, collections):
        calls.append((ra, dec))
        return {"points": [1, 2], "checks": [], "complete": True}

    monkeypatch.setattr(warm, "build_spectrum", build_spectrum)
    return calls


@pytest.fixture(autouse=True)
def surprise_stars(monkeypatch):
    """Every run also fills the Surprise-me star list: answer it without Gaia."""
    calls = []

    def candidates(settings, force=False):
        calls.append(force)
        return ["a star"]

    monkeypatch.setattr(warm.surprise, "candidates", candidates)
    return calls


def _fail_resolver(name):
    raise AssertionError(f"network use: resolve {name}")


def _fail_build(**kwargs):
    raise AssertionError(f"network use: build {kwargs}")


def _write_manifest(cache_dir, key, **overrides):
    frame = Frame(
        index=0,
        url="/api/frames/x/frame_00.png",
        obs_id="o",
        date="2025-05-05T00:00:00Z",
        mjd=60800.0,
        detector=6,
        wavelength_min_um=4.4,
        wavelength_max_um=5.0,
        coverage=1.0,
        source_url="https://irsa.ipac.caltech.edu/x.fits",
    )
    manifest = FrameManifest(
        collection="spherex_dr1",
        ra=1,
        dec=2,
        size_deg=0.2,
        detector=6,
        pixel_scale_arcsec=6.15,
        epochs=1,
        complete=True,
        pipeline_version=PIPELINE_VERSION,
        frames=[frame],
        warnings=[],
    )
    path = manifest_path(cache_dir, key)
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({**manifest.model_dump(), **overrides}))
    return path


def test_dry_run_lists_every_target_and_detector_without_network(settings, capsys):
    code = warm.run(["--dry-run"], settings, resolver=_fail_resolver, build=_fail_build)

    lines = capsys.readouterr().out.splitlines()
    assert code == 0
    assert lines[0] == "surprise · Gaia DR3 fast-moving star list"
    assert len(lines) == 1 + 7 * 5
    assert lines[1:4] == [
        f"{POLARIS_D6} · Polaris · D6",
        "spectrum · Polaris",
        f"{POLARIS_D6_STACKS} · Polaris · D6 stacks",
    ]
    assert "resolve:R Dra · R Draconis · D1" in lines
    assert "resolve:R Dra · R Draconis · D1 stacks" in lines


def test_jobs_use_the_same_key_as_a_demo_click(settings, capsys):
    calls = []

    def build(**kwargs):
        calls.append(kwargs)
        return {"frames": [1, 2], "warnings": [], "complete": True}

    code = warm.run(["--targets", "polaris"], settings, resolver=_fail_resolver, build=build)

    assert code == 0
    assert [c["key"] for c in calls][:2] == [POLARIS_D6, POLARIS_D6_STACKS]
    assert [(c["detector"], c["stack"]) for c in calls] == [
        (6, False),
        (6, True),
        (1, False),
        (1, True),
    ]
    assert calls[0]["size_deg"] == 0.2 and calls[0]["max_frames"] == 12
    out = capsys.readouterr().out
    assert "· D6 · 2 frames ·" in out and "· D6 stacks · 2 frames ·" in out


def test_pluto_uses_its_fixed_2026_position_like_the_ui(settings):
    jobs = warm.plan({"plutoknowndwarfplanet2026"})

    assert [job.key("spherex_dr1") for job in jobs] == [
        job_id_for("spherex_dr1", 308.5364, -22.9153, 0.2, d, 12, s)
        for d in (6, 1)
        for s in (False, True)
    ]


def test_named_targets_are_resolved_like_the_ui(settings):
    calls = []

    def build(**kwargs):
        calls.append(kwargs)
        return {"frames": [], "warnings": [], "complete": True}

    warm.run(
        ["--targets", "r-draconis"], settings, resolver=lambda n: (1.23456789, 2.0), build=build
    )

    assert len(calls) == 4
    assert calls[0]["ra"] == 1.234568  # six decimals, as the UI sends them
    assert calls[0]["key"] == job_id_for("spherex_dr1", 1.234568, 2.0, 0.2, 6, 12)
    assert calls[1]["key"] == job_id_for("spherex_dr1", 1.234568, 2.0, 0.2, 6, 12, stack=True)


def test_complete_cached_manifest_is_skipped_unless_forced(settings, capsys):
    _write_manifest(settings.cache_dir, POLARIS_D6)
    calls = []

    def build(**kwargs):
        calls.append(kwargs["key"])
        return {"frames": [], "warnings": [], "complete": True}

    assert warm.run(["--targets", "polaris"], settings, resolver=_fail_resolver, build=build) == 0
    assert len(calls) == 3 and POLARIS_D6 not in calls and POLARIS_D6_STACKS in calls
    assert "cached" in capsys.readouterr().out

    sia = sia_cache_path(
        settings.cache_dir, "spherex_dr1", parse_ra("02:31:49.09"), parse_dec("+89:15:50.8")
    )
    sia.parent.mkdir()
    sia.write_bytes(b"<stale/>")
    gaia = gaia_cache_path(settings.cache_dir, parse_ra("02:31:49.09"), parse_dec("+89:15:50.8"))
    gaia.parent.mkdir()
    gaia.write_text("stale")

    def spectrum(ra, dec, collections):
        # Like build_spectrum: asks Gaia (here: writes the fresh answer) once per target.
        assert not gaia.exists()
        gaia.write_text("fresh")
        return {"points": [], "checks": [], "complete": True}

    warm.run(
        ["--targets", "polaris", "--force"],
        settings,
        resolver=_fail_resolver,
        build=build,
        spectrum=spectrum,
    )
    assert len(calls) == 3 + 4 and calls[3] == POLARIS_D6
    assert not sia.exists()
    # Four jobs (two detectors, exposures and stacks), one spectrum: the refreshed Gaia answer
    # survives the target's later jobs.
    assert gaia.read_text() == "fresh"


def test_incomplete_manifest_fails_the_run(settings, capsys):
    def build(**kwargs):
        return {"frames": [1], "warnings": ["one cutout missing"], "complete": False}

    code = warm.run(["--targets", "polaris"], settings, resolver=_fail_resolver, build=build)

    assert code == 1
    assert capsys.readouterr().out.count("INCOMPLETE") == 4


def test_a_failed_job_does_not_stop_the_others_but_fails_the_run(settings, capsys):
    calls = []

    def build(**kwargs):
        calls.append(kwargs["detector"])
        if kwargs["detector"] == 6:
            raise RuntimeError("archive did not answer")
        return {"frames": [], "warnings": [], "complete": True}

    code = warm.run(
        ["--targets", "polaris,wise0855"], settings, resolver=_fail_resolver, build=build
    )

    assert code == 1
    assert calls == [6, 6, 1, 1, 6, 6, 1, 1]
    assert capsys.readouterr().err.count("FAILED") == 4


def test_unknown_target_filter_is_reported(settings, capsys):
    assert (
        warm.run(["--targets", "vega"], settings, resolver=_fail_resolver, build=_fail_build) == 2
    )
    assert "Polaris" in capsys.readouterr().out


def test_frame_folders_of_older_pipeline_versions_are_removed(settings, capsys):
    v1_manifest = _write_manifest(settings.cache_dir, "0000000000000001")
    del_field = json.loads(v1_manifest.read_text())
    del del_field["pipeline_version"]  # written before the marker existed
    v1_manifest.write_text(json.dumps(del_field))
    (v1_manifest.parent / "frame_00.png").write_bytes(b"png")
    old = _write_manifest(
        settings.cache_dir, "0000000000000002", pipeline_version=PIPELINE_VERSION - 1
    )
    current = _write_manifest(settings.cache_dir, POLARIS_D6)
    building = settings.cache_dir / "frames" / "0000000000000003"
    building.mkdir()
    (building / "manifest.json.part").write_text("{")
    broken = manifest_path(settings.cache_dir, "0000000000000004")
    broken.parent.mkdir()
    broken.write_text("{not json")
    cutout = settings.cache_dir / "cutouts" / "abc.fits"
    cutout.parent.mkdir()
    cutout.write_bytes(b"fits")

    def build(**kwargs):
        return {"frames": [], "warnings": [], "complete": True}

    code = warm.run(["--targets", "polaris"], settings, resolver=_fail_resolver, build=build)

    assert code == 0
    assert not v1_manifest.parent.exists() and not old.parent.exists()
    assert current.is_file() and building.is_dir() and broken.is_file() and cutout.is_file()
    out, err = capsys.readouterr()
    assert "removed 2 frame folders" in out
    assert "SKIPPED · frames/0000000000000004" in err


def test_dry_run_and_missing_frames_dir_do_not_prune(settings, capsys):
    old = _write_manifest(settings.cache_dir, "0000000000000002", pipeline_version=1)

    warm.run(["--dry-run"], settings, resolver=_fail_resolver, build=_fail_build)
    assert old.is_file()
    assert warm.prune_stale_frames(settings.cache_dir / "nowhere") == []


def test_spectrum_is_built_once_per_target_at_the_position_the_ui_sends(settings, spectra, capsys):
    def build(**kwargs):
        return {"frames": [], "warnings": [], "complete": True}

    warm.run(
        ["--targets", "r-draconis"], settings, resolver=lambda n: (1.23456789, 2.0), build=build
    )

    assert spectra == [(1.234568, 2.0)]
    assert "spectrum · R Draconis · 2 points ·" in capsys.readouterr().out


def test_failed_or_incomplete_spectrum_fails_the_run_but_warms_the_frames(
    settings, monkeypatch, capsys
):
    calls = []

    def build(**kwargs):
        calls.append(kwargs["detector"])
        return {"frames": [], "warnings": [], "complete": True}

    def broken(ra, dec, collections):
        raise RuntimeError("archive did not answer")

    monkeypatch.setattr(warm, "build_spectrum", broken)
    assert warm.run(["--targets", "polaris"], settings, resolver=_fail_resolver, build=build) == 1
    assert calls == [6, 6, 1, 1]
    assert "FAILED · spectrum · Polaris" in capsys.readouterr().err

    skipped = {"code": "SPECTRUM_POINTS_SKIPPED", "detail": "3 visits skipped: 3 NaN"}
    monkeypatch.setattr(
        warm,
        "build_spectrum",
        lambda ra, dec, collections: {"points": [], "checks": [skipped], "complete": False},
    )
    assert warm.run(["--targets", "polaris"], settings, resolver=_fail_resolver, build=build) == 1
    assert "0 points · " in (out := capsys.readouterr().out)
    assert "3 visits skipped: 3 NaN · INCOMPLETE" in out


def test_no_spectrum_warms_the_frames_only(settings, spectra):
    def build(**kwargs):
        return {"frames": [], "warnings": [], "complete": True}

    args = ["--targets", "polaris", "--no-spectrum"]
    assert warm.run(args, settings, resolver=_fail_resolver, build=build) == 0
    assert spectra == []


def test_the_surprise_star_list_is_filled_and_force_refreshes_it(settings, surprise_stars, capsys):
    build = lambda **_: {"frames": [], "warnings": [], "complete": True}  # noqa: E731

    assert warm.run(["--targets", "polaris", "--force"], settings, _fail_resolver, build) == 0

    assert surprise_stars == [True]
    assert "surprise · 1 fast-moving Gaia stars" in capsys.readouterr().out


def test_an_empty_surprise_star_list_fails_the_run(settings, monkeypatch, capsys):
    monkeypatch.setattr(warm.surprise, "candidates", lambda settings, force: [])
    build = lambda **_: {"frames": [], "warnings": [], "complete": True}  # noqa: E731

    assert warm.run(["--targets", "polaris"], settings, _fail_resolver, build) == 1
    assert "surprise · 0 fast-moving Gaia stars · FAILED" in capsys.readouterr().out
