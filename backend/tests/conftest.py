import httpx
import pytest
from fastapi.testclient import TestClient

from app import catalogs, sources
from app.config import Settings, get_settings
from app.main import app


@pytest.fixture
def settings(tmp_path):
    # Port 1 refuses connections immediately: tests never need a running Redis.
    return Settings(redis_url="redis://127.0.0.1:1/0", cache_dir=tmp_path)


@pytest.fixture
def client(settings):
    app.dependency_overrides[get_settings] = lambda: settings
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def no_gaia(monkeypatch):
    """/api/resolve also asks Gaia: tests never reach it."""

    def unreachable(*_, **__):
        raise httpx.ConnectError("no network in tests")

    monkeypatch.setattr(catalogs.httpx, "post", unreachable)


@pytest.fixture(autouse=True)
def no_allwise(monkeypatch):
    """Source matching asks IRSA Gator for AllWISE with httpx.get: never in tests."""

    def unreachable(*_, **__):
        raise httpx.ConnectError("no network in tests")

    monkeypatch.setattr(sources, "query_allwise", unreachable)
