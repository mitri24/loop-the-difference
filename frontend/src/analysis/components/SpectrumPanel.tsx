import { useState } from "react";
import type { SpectrumResult, Visit } from "../api/types";
import { formatDate } from "../lib/astro";
import { ScatterPlot, type PlotPoint } from "./ScatterPlot";

interface Props {
  result: SpectrumResult | null;
  running: boolean;
  progress: number;
  message: string;
  error: string | null;
  visits: Visit[];
  nObservations: number;
  onStart: (maxFrames: number) => void;
}

const isoFromMjd = (mjd: number) => new Date((mjd - 40587) * 86400000).toISOString();

/** Spectrum on the fly: one point per SPHEREx exposure (each sees the target at a
 *  different LVF wavelength). Colour = band, shape = visit. */
export function SpectrumPanel(p: Props) {
  const [maxFrames, setMaxFrames] = useState(120);
  const [logY, setLogY] = useState(true);
  const labels = Object.fromEntries(p.visits.map((v) => [v.index, v.label]));
  const points: PlotPoint[] = (p.result?.points ?? []).map((d) => ({
    key: `${d.obs_id}-${d.band}`,
    x: d.lambda_um,
    y: d.flux_mjy,
    yErr: d.flux_err_mjy,
    band: d.band,
    group: d.visit,
    style: d.quality === "good" ? "solid" : d.quality === "degraded" ? "hollow" : "cross",
    tooltip: [
      `${d.lambda_um.toFixed(3)} µm · ${d.band} · ${labels[d.visit] ?? ""}`,
      `${d.flux_mjy.toPrecision(4)} ± ${d.flux_err_mjy.toPrecision(2)} mJy`,
      `${formatDate(isoFromMjd(d.mjd))} · ${d.obs_id}`,
      `Quality: ${d.quality}${d.flags.length ? ` (${d.flags.filter((f) => f !== "SOURCE").join(", ") || "—"})` : ""}`,
    ],
  }));
  const est = Math.min(maxFrames, p.nObservations);

  return (
    <div className="spectrum">
      <div className="spectrum__controls">
        <label className="field field--inline">
          <span>Exposures</span>
          <input type="range" min={20} max={400} step={10} value={maxFrames} onChange={(e) => setMaxFrames(Number(e.target.value))} />
          <span className="mono">{maxFrames}</span>
        </label>
        <button className="btn btn--primary" disabled={p.running || p.nObservations === 0} onClick={() => p.onStart(maxFrames)}>
          {p.running ? "Measuring…" : "Measure spectrum"}
        </button>
        <label className="check">
          <input type="checkbox" checked={logY} onChange={(e) => setLogY(e.target.checked)} /> Log flux
        </label>
        <span className="muted">≈ {(est * 4).toFixed(0)} MB from IRSA on first run (cached afterwards).</span>
      </div>
      {p.running && <Progress value={p.progress} message={p.message} />}
      {p.error && <p className="alert alert--fail" role="alert">{p.error}</p>}
      {p.result && (
        <>
          <ScatterPlot
            points={points}
            xLabel="Wavelength at target (µm)"
            yLabel="Flux density (mJy)"
            logY={logY}
            groupLabels={labels}
            ariaLabel="SPHEREx spectrum of the target: flux density versus wavelength"
            tableColumns={[
              { label: "λ (µm)", value: (d) => d.x.toFixed(4) },
              { label: "Band", value: (d) => d.band },
              { label: "Visit", value: (d) => labels[d.group] ?? String(d.group) },
              { label: "Flux (mJy)", value: (d) => d.y.toPrecision(4) },
              { label: "± (mJy)", value: (d) => (d.yErr ?? 0).toPrecision(2) },
              { label: "Quality", value: (d) => d.style ?? "" },
            ]}
          />
          <details><summary>Spectrum source files ({p.result.points.length})</summary>
            <ul>{p.result.points.map(point => <li key={`${point.obs_id}-${point.band}`}>
              <a href={point.source_url} target="_blank" rel="noreferrer">{point.obs_id} · {point.band} · {point.lambda_um.toFixed(4)} µm</a>
            </li>)}</ul>
          </details>
          <p className="muted">
            Filled = clean pixels · hollow = saturated target (flux from pre-saturation samples) · cross = unusable pixels.
            Aperture {p.result.aperture_arcsec.toFixed(1)}″, {p.result.aperture_corrected ? "corrected to total flux with the SPHEREx ePSF" : "no aperture correction: compare visits at the same wavelength"}.
          </p>
        </>
      )}
    </div>
  );
}

export function Progress({ value, message }: { value: number; message: string }) {
  return (
    <div className="progress" role="status" aria-live="polite">
      <div className="progress__bar"><div style={{ width: `${Math.round(value * 100)}%` }} /></div>
      <span>{message} · {Math.round(value * 100)}%</span>
    </div>
  );
}
