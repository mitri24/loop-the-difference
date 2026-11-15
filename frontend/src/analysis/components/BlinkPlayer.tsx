import { useEffect, useMemo, useState } from "react";
import { API_BASE } from "../api/client";
import type { Frame, GridInfo } from "../api/types";
import { formatDate } from "../lib/astro";
import { FlagList } from "./FlagList";

interface Props {
  frames: Frame[];
  grid: GridInfo;
  index: number;
  onIndex: (i: number) => void;
  showOnSky: boolean;
  onShowOnSky: (v: boolean) => void;
  onPlayingChange?: (playing: boolean) => void;
}

/** The "little video": aligned frames played in time order, real pixels, north up. */
export function BlinkPlayer({ frames, grid, index, onIndex, showOnSky, onShowOnSky, onPlayingChange }: Props) {
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    onPlayingChange?.(playing);
    return () => onPlayingChange?.(false); // panel closed → player stopped
  }, [playing, onPlayingChange]);
  const [fps, setFps] = useState(2);
  const [crosshair, setCrosshair] = useState(true);
  const frame = frames[Math.min(index, frames.length - 1)];

  // Preload every frame so blinking never flashes.
  useEffect(() => {
    for (const f of frames) {
      const img = new Image();
      img.src = API_BASE + f.png_url;
    }
  }, [frames]);

  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const id = window.setInterval(() => onIndex((index + 1) % frames.length), window.matchMedia("(prefers-reduced-motion: reduce)").matches ? Math.max(1000, 1000 / fps) : 1000 / fps);
    return () => window.clearInterval(id);
  }, [playing, fps, index, frames.length, onIndex]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === " ") {
      e.preventDefault();
      setPlaying((p) => !p);
    } else if (e.key === "ArrowRight") {
      setPlaying(false);
      onIndex((index + 1) % frames.length);
    } else if (e.key === "ArrowLeft") {
      setPlaying(false);
      onIndex((index - 1 + frames.length) % frames.length);
    }
  };

  const pct = (v: number) => `${((v + 0.5) / grid.npix) * 100}%`;
  const scaleBar = useMemo(() => {
    // 1 arcmin bar if the field allows, else 30".
    const arcsec = grid.fov_arcmin >= 4 ? 60 : 30;
    return { label: arcsec === 60 ? "1′" : "30″", pct: (arcsec / grid.pixel_arcsec / grid.npix) * 100 };
  }, [grid]);

  if (!frame) return null;
  return (
    <div className="blink" tabIndex={0} onKeyDown={onKey} aria-label="Blink player. Space: play/pause, arrows: step.">
      <div className="blink__stage">
        <div className="blink__image-wrap">
          <img
            className="pixelated blink__image"
            src={API_BASE + frame.png_url}
            alt={`SPHEREx ${frame.band} ${frame.kind === "stack" ? "stack" : "exposure"} ${frame.visit_label}`}
            draggable={false}
          />
          {crosshair && (
            <div
              className="crosshair"
              style={{ left: pct(frame.target_px[0]), top: pct(frame.target_px[1]) }}
              title="Predicted target position at this epoch (catalogue proper motion)"
            />
          )}
          <div className="blink__compass" aria-hidden>
            <span>N↑</span> <span>E←</span>
          </div>
          <div className="blink__scale" style={{ width: `${scaleBar.pct}%` }}>
            <span>{scaleBar.label}</span>
          </div>
          <div className="blink__stamp">
            <strong>{formatDate(frame.date_utc)}</strong>
            <span>{frame.visit_label.split(" ")[0]}</span>
            <span>
              λ {frame.lambda_um.toFixed(3)} µm
              {frame.kind === "stack" && ` (${frame.lambda_min_um.toFixed(2)}–${frame.lambda_max_um.toFixed(2)})`}
            </span>
          </div>
        </div>
      </div>

      <div className="blink__controls">
        <button className="btn btn--primary" onClick={() => setPlaying((p) => !p)} aria-pressed={playing}>
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        <button className="btn" onClick={() => { setPlaying(false); onIndex((index - 1 + frames.length) % frames.length); }} aria-label="Previous frame">◀</button>
        <button className="btn" onClick={() => { setPlaying(false); onIndex((index + 1) % frames.length); }} aria-label="Next frame">▶</button>
        <label className="field field--inline">
          <span>Speed</span>
          <input type="range" min={0.5} max={8} step={0.5} value={fps} onChange={(e) => setFps(Number(e.target.value))} />
          <span className="mono">{fps} fps</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={crosshair} onChange={(e) => setCrosshair(e.target.checked)} /> Predicted position
        </label>
        <label className="check">
          <input type="checkbox" checked={showOnSky} onChange={(e) => onShowOnSky(e.target.checked)} /> Show on sky
        </label>
      </div>

      <nav className="blink__thumbnails" aria-label="Browse observations">
      <ol className="filmstrip" aria-label="Observation thumbnails" onKeyDown={event => {
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
        const focused = buttons.indexOf(event.target as HTMLButtonElement);
        if (focused < 0) return;
        const next = event.key === 'ArrowDown' ? Math.min(frames.length - 1, focused + 1)
          : event.key === 'ArrowUp' ? Math.max(0, focused - 1)
          : event.key === 'Home' ? 0 : event.key === 'End' ? frames.length - 1 : null;
        if (next === null) return;
        event.preventDefault(); setPlaying(false); onIndex(next); buttons[next]?.focus();
      }}>
        {frames.map((f, i) => (
          <li key={f.id}>
            <button
              className={`filmstrip__item ${i === index ? "is-active" : ""}`}
              onClick={() => { setPlaying(false); onIndex(i); }}
              aria-current={i === index}
              aria-label={`Show observation ${i + 1}, ${formatDate(f.date_utc)}`}
              title={`${formatDate(f.date_utc)} · ${f.visit_label} · ${f.n_exposures} exposure(s)`}
            >
              <img className="pixelated" src={API_BASE + f.png_url} alt="" />
              <span className="sr-only">{formatDate(f.date_utc)}</span>
            </button>
          </li>
        ))}
      </ol>
      </nav>

      <section className="blink__metadata" aria-label="Selected observation metadata">
      <h3>Observation {index + 1} of {frames.length}</h3>
      <dl className="meta-grid">
        <dt>Image type</dt><dd>{frame.kind === 'stack' ? 'Visit stack' : 'Single exposure'}</dd>
        <dt>Observation ID</dt><dd className="mono">{frame.id}</dd>
        <dt>Visit</dt><dd>{frame.visit_label}</dd>
        <dt>Date (UTC)</dt><dd className="mono">{frame.date_utc}</dd>
        <dt>Band</dt><dd><span className={`band-chip band-chip--${frame.band.toLowerCase()}`}>{frame.band}</span></dd>
        <dt>Wavelength at target</dt>
        <dd className="mono">
          {frame.lambda_um.toFixed(4)} µm
          {frame.bandwidth_um ? ` (Δλ ${frame.bandwidth_um.toFixed(3)})` : ""}
        </dd>
        <dt>Exposures</dt><dd>{frame.n_exposures} {frame.kind === "stack" ? "(inverse-variance stack)" : ""}</dd>
        <dt>Coverage</dt><dd>{(frame.coverage * 100).toFixed(0)}% of field</dd>
        <dt>PSF FWHM</dt><dd>{frame.psf_fwhm_arcsec ? `${frame.psf_fwhm_arcsec.toFixed(1)}″` : "—"}</dd>
        <dt>Noise (1σ)</dt><dd className="mono">{frame.noise_mjy_sr.toPrecision(3)} MJy/sr</dd>
        <dt>Release</dt><dd>{frame.collections.join(", ")}</dd>
        <dt>Flags at target</dt><dd><FlagList flags={frame.flags_at_target} /></dd>
        <dt>Source files</dt>
        <dd>
          <details open={frame.source_urls.length <= 3}><summary>{frame.source_urls.length} source files</summary>
          {frame.source_urls.map((u, i) => (
            <a key={u} href={u} target="_blank" rel="noreferrer" className="mono src-link">{frame.obs_ids[i]}</a>
          ))}
          </details>
        </dd>
        <dt>Aligned image</dt>
        <dd>
          <a href={API_BASE + frame.fits_url} download={`spherex_${frame.band}_${frame.visit_label.split(" ")[0]}_${frame.id}.fits`}>
            Download FITS
          </a>{" "}
          <span className="muted small">(background-subtracted, MJy/sr, TAN grid)</span>
        </dd>
      </dl>
      <details className="blink__advanced"><summary>Image grid & processing</summary><dl className="meta-grid">
        <dt>Wavelength range</dt><dd>{frame.lambda_min_um.toFixed(4)}–{frame.lambda_max_um.toFixed(4)} µm</dd>
        <dt>Time span (MJD)</dt><dd>{frame.mjd_start.toFixed(5)}–{frame.mjd_end.toFixed(5)}</dd>
        <dt>Grid centre</dt><dd>RA {grid.ra.toFixed(6)}° · Dec {grid.dec.toFixed(6)}°</dd>
        <dt>Image grid</dt><dd>{grid.npix} × {grid.npix} px · {grid.pixel_arcsec}″/px · {grid.fov_arcmin}′ field</dd>
        <dt>Masked pixels</dt><dd>{(frame.hard_flag_fraction * 100).toFixed(1)}%</dd>
        <dt>Background</dt><dd>{frame.background_mjy_sr.toPrecision(4)} MJy/sr</dd>
      </dl></details>
      </section>
    </div>
  );
}
