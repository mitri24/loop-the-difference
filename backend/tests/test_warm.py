from app import warm
from app.archive import sia_cache_path
from app.coords import parse_dec, parse_ra
from app.jobs import job_id_for
from app.models import Frame, FrameManifest
from app.tasks import manifest_path

POLARIS_D6 = job_id_for(
    "spherex_dr1", parse_ra("02:31:49.09"), parse_dec("+89:15:50.8"), 0.2, 6, 12
)


def _fail_resolver(name):
    raise AssertionError(f"network use: resolve {name}")


def _fail_build(**kwargs):
    raise AssertionError(f"network use: build {kwargs}")


def test_dry_run_lists_every_target_and_detector_without_network(settings, capsys):
    code = warm.run(["--dry-run"], settings, resolver=_fail_resolver, build=_fail_build)

    lines = capsys.readouterr().out.splitlines()
    assert code == 0
    assert len(lines) == 6 * 2
    assert lines[0] == f"{POLARIS_D6} · Polaris · D6"
    assert "resolve:R Dra · R Draconis · D1" in lines


def test_jobs_use_the_same_key_as_a_demo_click(settings, capsys):
    calls = []

    def build(**kwargs):
        calls.append(kwargs)
        return {"frames": [1, 2], "warnings": [], "complete": True}

    code = warm.run(["--targets", "polaris"], settings, resolver=_fail_resolver, build=build)

    assert code == 0
    assert [c["key"] for c in calls][0] == POLARIS_D6
    assert [c["detector"] for c in calls] == [6, 1]
    assert calls[0]["size_deg"] == 0.2 and calls[0]["max_frames"] == 12
    assert "· 2 frames ·" in capsys.readouterr().out


def test_named_targets_are_resolved_like_the_ui(settings):
    calls = []

    def build(**kwargs):
        calls.append(kwargs)
        return {"frames": [], "warnings": [], "complete": True}

    warm.run(
        ["--targets", "r-draconis"], settings, resolver=lambda n: (1.23456789, 2.0), build=build
    )

    assert len(calls) == 2
    assert calls[0]["ra"] == 1.234568  # six decimals, as the UI sends them
    assert calls[0]["key"] == job_id_for("spherex_dr1", 1.234568, 2.0, 0.2, 6, 12)


def test_complete_cached_manifest_is_skipped_unless_forced(settings, capsys):
    path = manifest_path(settings.cache_dir, POLARIS_D6)
    path.parent.mkdir(parents=True)
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
        frames=[frame],
        warnings=[],
    )
    path.write_text(manifest.model_dump_json())
    calls = []

    def build(**kwargs):
        calls.append(kwargs["detector"])
        return {"frames": [], "warnings": [], "complete": True}

    assert warm.run(["--targets", "polaris"], settings, resolver=_fail_resolver, build=build) == 0
    assert calls == [1]
    assert "cached" in capsys.readouterr().out

    sia = sia_cache_path(
        settings.cache_dir, "spherex_dr1", parse_ra("02:31:49.09"), parse_dec("+89:15:50.8")
    )
    sia.parent.mkdir()
    sia.write_bytes(b"<stale/>")

    warm.run(["--targets", "polaris", "--force"], settings, resolver=_fail_resolver, build=build)
    assert calls == [1, 6, 1]
    assert not sia.exists()


def test_incomplete_manifest_fails_the_run(settings, capsys):
    def build(**kwargs):
        return {"frames": [1], "warnings": ["one cutout missing"], "complete": False}

    code = warm.run(["--targets", "polaris"], settings, resolver=_fail_resolver, build=build)

    assert code == 1
    assert capsys.readouterr().out.count("INCOMPLETE") == 2


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
    assert calls == [6, 1, 6, 1]
    assert capsys.readouterr().err.count("FAILED") == 2


def test_unknown_target_filter_is_reported(settings, capsys):
    assert (
        warm.run(["--targets", "pluto"], settings, resolver=_fail_resolver, build=_fail_build) == 2
    )
    assert "Polaris" in capsys.readouterr().out
