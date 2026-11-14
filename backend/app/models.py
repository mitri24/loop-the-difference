from typing import Literal

from pydantic import BaseModel, Field


class Observation(BaseModel):
    obs_id: str
    detector: int
    wavelength_min_um: float
    wavelength_max_um: float
    mjd: float
    date: str
    access_url: str


class Epoch(BaseModel):
    start: str
    end: str
    count: int


class ObservationSummary(BaseModel):
    collection: str
    ra: float
    dec: float
    count: int
    detectors: dict[int, int]
    epochs: list[Epoch]
    observations: list[Observation]


class ResolvedTarget(BaseModel):
    name: str
    ra: float
    dec: float


class FrameRequest(BaseModel):
    ra: str = Field(min_length=1, max_length=40)
    dec: str = Field(min_length=1, max_length=40)
    size_deg: float = Field(default=0.2, gt=0, le=1.0)
    detector: int = Field(default=6, ge=1, le=6)
    max_frames: int = Field(default=12, ge=2, le=24)
    stack: bool = False


class Frame(BaseModel):
    index: int
    url: str
    obs_id: str
    date: str
    mjd: float
    detector: int
    wavelength_min_um: float
    wavelength_max_um: float
    coverage: float
    source_url: str
    epoch: int = 0
    n_combined: int = 1
    date_end: str | None = None
    masked_fraction: float | None = None
    wavelength_um: float | None = None
    bandwidth_um: float | None = None


class Check(BaseModel):
    code: str
    severity: Literal["error", "blocker", "warning", "info"]
    message: str
    detail: str = ""
    affects: list[str] = []


class Difference(BaseModel):
    a: int
    b: int
    url: str
    comparable: bool
    delta_lambda_pct: float | None = None
    obs_ids_a: list[str] = []
    obs_ids_b: list[str] = []


class FrameManifest(BaseModel):
    collection: str
    ra: float
    dec: float
    size_deg: float
    detector: int
    pixel_scale_arcsec: float
    epochs: int
    # False when the archive did not deliver every frame: the next request retries.
    complete: bool = True
    stacked: bool = False
    # Manifests written before this field existed come from pipeline version 1.
    pipeline_version: int = 1
    frames: list[Frame]
    # Human-readable copy of the checks' details, kept for older clients.
    warnings: list[str]
    checks: list[Check] = []
    differences: list[Difference] = []


class FrameJob(BaseModel):
    job_id: str
    status: Literal["queued", "started", "finished", "failed", "not_found"]
    progress: int = 0
    total: int = 0
    manifest: FrameManifest | None = None
    error: str | None = None
