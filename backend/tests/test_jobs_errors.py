from app.jobs import error_text


def test_error_text_drops_the_exception_class():
    assert error_text("app.archive.ArchiveError: SPHEREx archive (IRSA) is not reachable") == (
        "SPHEREx archive (IRSA) is not reachable"
    )
    assert error_text("ValueError: bad input") == "bad input"
    assert error_text("httpx.ConnectTimeout: timed out") == "httpx.ConnectTimeout: timed out"
    assert error_text("Preparing the images failed: retry") == "Preparing the images failed: retry"
