"""Runtime configuration.

Every value can be overridden with an environment variable prefixed ``SPHEREX_``
(e.g. ``SPHEREX_INCLUDE_DEEP_FIELDS=false``). New SPHEREx data releases need no change at
all: they are discovered at IRSA (app/releases.py); ``SPHEREX_COLLECTIONS`` only pins a list.
"""

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SPHEREX_", env_file=".env", extra="ignore")

    # --- Data releases -------------------------------------------------------------
    # "auto" (default): discover every SPHEREx image collection IRSA publishes (see
    # app/releases.py) — new releases appear without any code change. Or pin an explicit,
    # preference-ordered list, e.g. "spherex_dr1,spherex_qr3" (first one wins on duplicates).
    collections: str = "auto"
    include_deep_fields: bool = True  # spherex_*_deep: deep fields near the ecliptic poles
    release_refresh_s: float = 6 * 3600  # how often to re-check IRSA for new releases

    # --- External services ---------------------------------------------------------
    irsa_sia_url: str = "https://irsa.ipac.caltech.edu/SIA"
    irsa_base_url: str = "https://irsa.ipac.caltech.edu"
    irsa_scs_url: str = "https://irsa.ipac.caltech.edu/SCS"
    gaia_tap_url: str = "https://gea.esac.esa.int/tap-server/tap/sync"
    sesame_url: str = "https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV"
    # Canadian Astronomy Data Centre (NRC Canada): CAOM-2 TAP, file locator, DataLink.
    # Service URLs from the CADC registry (ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/reg/resource-caps).
    cadc_tap_url: str = "https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/argus/sync"
    cadc_files_url: str = "https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/raven/files"
    cadc_datalink_url: str = "https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/caom2ops/datalink"
    cadc_search_ui_url: str = "https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/en/search/"
    http_timeout_s: float = 120.0
    max_concurrent_downloads: int = 8

    # --- Cache ---------------------------------------------------------------------
    cache_dir: Path = BACKEND_DIR / "cache"

    # --- Science limits ------------------------------------------------------------
    native_pixel_arcsec: float = 6.15
    min_fov_arcmin: float = 2.0
    max_fov_arcmin: float = 30.0
    default_fov_arcmin: float = 8.0
    max_frames_per_job: int = 120
    # Minimum separation (days) between two frames for them to count as different
    # epochs. SPHEREx re-observes the sky every ~6 months; within one visit the same
    # point is revisited over a few days at different wavelengths.
    visit_gap_days: float = 20.0
    # Two frames are "wavelength-matched" when |Δλ| is below this fraction of one
    # spectral resolution element (λ / R).
    wavelength_match_fraction: float = 0.5

    # --- Frontend ------------------------------------------------------------------
    frontend_dist: Path = REPO_DIR / "frontend" / "dist"
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    @property
    def collection_list(self) -> list[str]:
        """Explicitly configured collections ([] when "auto": use app.releases)."""
        if self.collections.strip().lower() == "auto":
            return []
        return [c.strip() for c in self.collections.split(",") if c.strip()]

    @property
    def cutout_cache(self) -> Path:
        return self.cache_dir / "cutouts"

    @property
    def frame_cache(self) -> Path:
        return self.cache_dir / "frames"


settings = Settings()
