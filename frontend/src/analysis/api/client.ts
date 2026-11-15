import type {
  AppConfig,
  CadcSearch,
  CatalogSource,
  DifferenceResult,
  JobStatus,
  ObservationSearch,
  Releases,
  SequenceRequest,
  SequenceResult,
  SpectrumResult,
  Target,
} from "./types";

/** Base URL of the API. Empty in dev (Vite proxy) and in prod (same origin). */
export const API_BASE: string = "/analysis";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, "The server cannot be reached. Is the backend running?");
  }
  if (!res.ok) {
    let detail = res.statusText;
    let code: string | undefined;
    try {
      const body = await res.json();
      code = body.code;
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, detail, code);
  }
  return (await res.json()) as T;
}

export const absoluteUrl = (path: string): string =>
  new URL(API_BASE + path, window.location.href).toString();

export const api = {
  config: () => request<AppConfig>("/api/config"),
  releases: (refresh = false) => request<Releases>(`/api/releases${refresh ? "?refresh=true" : ""}`),
  resolve: (name: string) => request<Target>(`/api/resolve?name=${encodeURIComponent(name)}`),
  /** ra/dec may be strings: the backend parses decimal or sexagesimal and validates. */
  observations: (
    t: Pick<Target, "name" | "epoch_jyear" | "pm_ra_mas_yr" | "pm_dec_mas_yr"> & {
      ra: number | string;
      dec: number | string;
    },
    fovArcmin: number,
  ) => {
    const q = new URLSearchParams({
      ra: String(t.ra),
      dec: String(t.dec),
      fov: String(fovArcmin),
      epoch: String(t.epoch_jyear),
    });
    if (t.name) q.set("name", t.name);
    if (t.pm_ra_mas_yr != null) q.set("pm_ra", String(t.pm_ra_mas_yr));
    if (t.pm_dec_mas_yr != null) q.set("pm_dec", String(t.pm_dec_mas_yr));
    return request<ObservationSearch>(`/api/observations?${q}`);
  },
  startSequence: (body: SequenceRequest) =>
    request<JobStatus<SequenceResult>>("/api/jobs/sequence", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  startSpectrum: (t: Target, maxFrames: number) =>
    request<JobStatus<SpectrumResult>>("/api/jobs/spectrum", {
      method: "POST",
      body: JSON.stringify({
        ra: t.ra,
        dec: t.dec,
        name: t.name,
        pm_ra_mas_yr: t.pm_ra_mas_yr,
        pm_dec_mas_yr: t.pm_dec_mas_yr,
        target_epoch_jyear: t.epoch_jyear,
        max_frames: maxFrames,
      }),
    }),
  startSolarSystem: (diffId: string) =>
    request<JobStatus<DifferenceResult>>("/api/jobs/solar-system", {
      method: "POST",
      body: JSON.stringify({ diff_id: diffId }),
    }),
  /** Images of the field from other telescopes at the CADC (Canada), incl. NEOSSat. */
  startCadc: (t: Target, fovArcmin: number) =>
    request<JobStatus<CadcSearch>>("/api/jobs/cadc", {
      method: "POST",
      body: JSON.stringify({
        ra: t.ra,
        dec: t.dec,
        name: t.name,
        pm_ra_mas_yr: t.pm_ra_mas_yr,
        pm_dec_mas_yr: t.pm_dec_mas_yr,
        target_epoch_jyear: t.epoch_jyear,
        fov_arcmin: fovArcmin,
      }),
    }),
  job: <R>(id: string) => request<JobStatus<R>>(`/api/jobs/${id}`),
  difference: (frameA: string, frameB: string, force = false) =>
    request<DifferenceResult>("/api/difference", {
      method: "POST",
      body: JSON.stringify({ frame_a: frameA, frame_b: frameB, force }),
    }),
  catalog: (ra: number, dec: number, radiusArcmin: number, epoch: number) =>
    request<CatalogSource[]>(
      `/api/catalog?ra=${ra}&dec=${dec}&radius_arcmin=${radiusArcmin}&catalog=gaia&epoch=${epoch}`,
    ),
};
