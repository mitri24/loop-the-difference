import type { BandName, Frame, ObservationSearch } from "../api/types";
import { BAND_ORDER, formatDate } from "../lib/astro";
import { OtherArchives } from "./OtherArchives";
import { ScatterPlot, type PlotPoint } from "./ScatterPlot";

interface Props {
  search: ObservationSearch;
  band: BandName;
  frames: Frame[];
}

/** Where and when SPHEREx looked: time × wavelength-at-target, before any download. */
export function ObservationsPanel({ search, band, frames }: Props) {
  const used = new Set(frames.flatMap((f) => f.obs_ids.map((id) => `${id}-${f.band}`)));
  const labels = Object.fromEntries(search.visits.map((v) => [v.index, v.label]));
  const points: PlotPoint[] = search.observations
    .filter((o) => o.lambda_est_um !== null)
    .map((o) => ({
      key: `${o.obs_id}-${o.band}`,
      x: o.mjd,
      y: o.lambda_est_um as number,
      band: o.band,
      group: o.visit,
      style: o.band === band ? "solid" : "hollow",
      highlight: used.has(`${o.obs_id}-${o.band}`),
      tooltip: [
        `${o.obs_id} · ${o.band}`,
        `${o.date_utc.replace("T", " ").slice(0, 16)} UTC · ${labels[o.visit]}`,
        `λ at target ≈ ${o.lambda_est_um?.toFixed(3)} µm (R ${o.resolving_power.toFixed(0)})`,
        `${o.collection} · field coverage ${(o.fov_coverage * 100).toFixed(0)}%`,
      ],
    }));

  const counts = BAND_ORDER.map((b) => ({ b, n: search.observations.filter((o) => o.band === b).length }));
  const mjdToDate = (mjd: number) => new Date((mjd - 40587) * 86400000).toISOString().slice(0, 7);

  return (
    <div className="obs">
      <div className="obs__summary">
        <span><strong>{search.observations.length}</strong> exposures</span>
        <span><strong>{search.visits.length}</strong> visits</span>
        {counts.map(({ b, n }) => (
          <span key={b} className={`band-chip band-chip--${b.toLowerCase()}`}>{b}: {n}</span>
        ))}
      </div>
      <ScatterPlot
        points={points}
        xLabel="Observation date"
        yLabel="Wavelength at target (µm)"
        xFormat={mjdToDate}
        groupLabels={labels}
        ariaLabel="SPHEREx exposures covering the target: date versus wavelength"
        height={260}
        tableColumns={[
          { label: "Date", value: (d) => mjdToDate(d.x) },
          { label: "Band", value: (d) => d.band },
          { label: "λ (µm)", value: (d) => d.y.toFixed(3) },
          { label: "Visit", value: (d) => labels[d.group] ?? "" },
          { label: "Used", value: (d) => (d.highlight ? "yes" : "") },
        ]}
      />
      <p className="muted">
        Each SPHEREx exposure sees the target at one wavelength set by the detector position (linear variable filter).
        Wavelengths are estimated from the footprint before download, then recomputed exactly. Ringed points are in the
        current blink sequence; filled points are band {band}.
      </p>
      <details>
        <summary>Archive queries (IRSA SIA2)</summary>
        <ul className="mono small">
          {search.query_urls.map((u) => <li key={u}><a href={u} target="_blank" rel="noreferrer">{u}</a></li>)}
        </ul>
        <p className="small muted">Visits: {search.visits.map((v) => `${v.label} (${formatDate(new Date((v.mjd_start - 40587) * 86400000).toISOString())}, ${v.n_observations})`).join(" · ")}</p>
      </details>
      <OtherArchives
        key={`${search.target.ra},${search.target.dec},${search.fov_arcmin}`}
        target={search.target}
        fovArcmin={search.fov_arcmin}
      />
    </div>
  );
}
