import pytest
from fastapi.testclient import TestClient

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
