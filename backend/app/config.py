from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SKYSHIFT_")

    spherex_collection: str = "spherex_dr1"
    irsa_sia_url: str = "https://irsa.ipac.caltech.edu/SIA"
    redis_url: str = "redis://redis:6379/0"
    cache_dir: Path = Path("/data/cache")
    http_timeout_s: float = 90.0
    download_workers: int = 4
    max_queued: int = 20
    cors_origins: list[str] = ["http://localhost:5173"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
