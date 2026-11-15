import { useEffect, useState } from "react";
import { API_BASE, api, ApiError } from "../api/client";
import type { DifferenceResult, Frame, GridInfo, ResidualKind } from "../api/types";
import { useJob } from "../lib/useJob";
import { Progress } from "./SpectrumPanel";
import { formatDate } from "../lib/astro";

interface Props {
  frames: Frame[];
  initialResult?: DifferenceResult | null;
  grid: GridInfo;
  onResult: (r: DifferenceResult | null) => void;
}

type View = "diff" | "sig" | "blink";

const KIND_LABEL: Record<ResidualKind, string> = {
  moving_star: "Known moving star",
  bright_star: "Bright-star artefact",
  known_source: "Known source",
  red_source: "Red source (WISE only)",
  solar_system: "Known asteroid/comet",
  unknown: "Needs verification",
};

/** Default "later" frame: the latest one with at least half the depth of the deepest
 *  frame, so the first comparison is not against a lone, shallow exposure. */
export function defaultB(frames: Frame[]): string {
  if (frames.length < 2) return frames[0]?.id ?? "";
  const deepest = Math.max(...frames.map((f) => f.n_exposures));
  const candidates = frames.slice(1).filter((f) => f.n_exposures * 2 >= deepest);
  return (candidates[candidates.length - 1] ?? frames[frames.length - 1]).id;
}

export function DifferencePanel({ frames, grid, onResult, initialResult = null }: Props) {
  const [a, setA] = useState(initialResult?.frame_a ?? frames[0]?.id ?? "");
  const [b, setB] = useState(initialResult?.frame_b ?? defaultB(frames));
  const [baseRes, setRes] = useState<DifferenceResult | null>(initialResult);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("diff");
  const [selected, setSelected] = useState<number | null>(null);
  const [blinkB, setBlinkB] = useState(false);
  const sso = useJob<DifferenceResult>();

  const res = sso.result ?? baseRes;
  useEffect(() => { onResult(res); }, [res, onResult]);

  useEffect(() => {
    if (view !== "blink") return;
    const id = window.setInterval(() => setBlinkB((v) => !v), window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 1000 : 600);
    return () => window.clearInterval(id);
  }, [view]);

  const run = async (force = false) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.difference(a, b, force);
      sso.reset();
      setRes(r);
      onResult(r);
      setSelected(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const fa = frames.find((f) => f.id === a);
  const fb = frames.find((f) => f.id === b);
  const pct = (v: number) => `${((v + 0.5) / grid.npix) * 100}%`;
  const label = (f: Frame) =>
    `${f.visit_label.split(" ")[0]} · ${formatDate(f.date_utc)} · ${f.lambda_um.toFixed(2)} µm`;

  const mainSrc =
    !res || !res.png_url
      ? null
      : view === "diff"
        ? res.png_url
        : view === "sig"
          ? res.significance_png_url
          : (blinkB ? fb : fa)?.png_url ?? null;

  return (
    <div className="diff">
      <div className="diff__pickers">
        <label className="field">
          <span>Frame A</span>
          <select value={a} disabled={busy || sso.running} onChange={(e) => { setA(e.target.value); setRes(null); sso.reset(); }}>
            {frames.map((f) => <option key={f.id} value={f.id}>{label(f)}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Frame B</span>
          <select value={b} disabled={busy || sso.running} onChange={(e) => { setB(e.target.value); setRes(null); sso.reset(); }}>
            {frames.map((f) => <option key={f.id} value={f.id}>{label(f)}</option>)}
          </select>
        </label>
        <button className="btn btn--primary" disabled={busy || !a || !b || a === b} onClick={() => run(false)}>
          {busy ? "Comparing…" : "Compare A − B"}
        </button>
      </div>
      {a === b && <p className="muted">Pick two different frames.</p>}
      {error && <p className="alert alert--fail" role="alert">{error}</p>}

      {res && !res.comparable && !res.png_url && (
        <div className="alert alert--fail" role="alert">
          <strong>Difference disabled: these frames are not comparable.</strong>
          <ul>
            {res.checks.filter((c) => c.severity === "fail").map((c) => (
              <li key={c.code}>{c.title}. {c.detail}</li>
            ))}
          </ul>
          <button className="btn btn--ghost" onClick={() => run(true)}>Show anyway (inspection only)</button>
        </div>
      )}

      {res && res.png_url && (
        <>
          <div className="seg" role="tablist" aria-label="Difference view">
            {(["diff", "sig", "blink"] as View[]).map((v) => (
              <button key={v} role="tab" aria-selected={view === v} className={`seg__btn ${view === v ? "is-active" : ""}`} onClick={() => setView(v)}>
                {v === "diff" ? "A − B (MJy/sr)" : v === "sig" ? `Significance (${res.significance_method === "zogy" ? "ZOGY" : "σ"})` : "Blink A ↔ B"}
              </button>
            ))}
          </div>
          <div className="diff__row">
            <figure className="diff__thumb">
              <img className="pixelated" src={API_BASE + (fa?.png_url ?? "")} alt="Frame A" />
              <figcaption>A · {fa && formatDate(fa.date_utc)}</figcaption>
            </figure>
            <figure className="diff__main">
              <div className="blink__image-wrap">
                {mainSrc && <img className="pixelated blink__image" src={API_BASE + mainSrc} alt="Difference image" />}
                {view !== "blink" && res.residuals.map((r, i) => (
                  <button
                    key={i}
                    className={`residual-marker ${r.known_source ? "" : "is-unknown"} ${selected === i ? "is-selected" : ""}`}
                    title={KIND_LABEL[r.kind]}
                    style={{ left: pct(r.x), top: pct(r.y) }}
                    onClick={() => setSelected(i)}
                    aria-label={`Residual ${i + 1}, ${r.significance.toFixed(1)} sigma`}
                  >
                    <span>{i + 1}</span>
                  </button>
                ))}
                {view !== "blink" && res.solar_system?.map((m) => (
                  <span
                    key={`${m.name}-${m.epoch}`}
                    className={`sso-marker sso-marker--${m.epoch.toLowerCase()}`}
                    style={{ left: pct(m.x), top: pct(m.y) }}
                    title={`${m.name} at ${m.epoch} (${m.date_utc.slice(0, 10)})${m.vmag != null ? `, V=${m.vmag.toFixed(1)}` : ""}`}
                  >
                    <span>{m.epoch}</span>
                  </span>
                ))}
                {view === "blink" && <div className="blink__stamp"><strong>{blinkB ? "B" : "A"}</strong></div>}
              </div>
              {view !== "blink" && (
                <figcaption className="legend-diverging">
                  <span><span className="swatch swatch--pos" /> brighter in A</span>
                  <span><span className="swatch swatch--mid" /> no change</span>
                  <span><span className="swatch swatch--neg" /> brighter in B</span>
                </figcaption>
              )}
            </figure>
            <figure className="diff__thumb">
              <img className="pixelated" src={API_BASE + (fb?.png_url ?? "")} alt="Frame B" />
              <figcaption>B · {fb && formatDate(fb.date_utc)}</figcaption>
            </figure>
          </div>

          <p className="muted">
            Δt = {res.delta_days.toFixed(1)} days · Δλ = {(res.delta_lambda_um * 1000).toFixed(1)} nm. A moving
            source leaves a red/blue pair; a variable source a single colour.
          </p>

          <div className="sso-bar">
            {res.solar_system === null ? (
              <button className="btn btn--sm" disabled={sso.running} onClick={() => void sso.start(() => api.startSolarSystem(res.id))}>
                Check known asteroids &amp; comets (JPL, 1–3 min)
              </button>
            ) : (
              <span className="muted small">
                JPL SBIdent: {res.solar_system.filter((m) => m.epoch === "A").length} known object(s) in the field at A,{" "}
                {res.solar_system.filter((m) => m.epoch === "B").length} at B (diamonds).
              </span>
            )}
            {sso.running && sso.job && <Progress value={sso.job.progress} message={sso.job.message} />}
            {sso.error && <span className="alert alert--fail small">{sso.error}</span>}
          </div>

          <h3 className="h3">Residuals with |S| &gt; 5σ ({res.residuals.length})</h3>
          {res.residuals.length === 0 ? (
            <p className="muted">No residual exceeded the threshold. Changes below the detection limit are not ruled out.</p>
          ) : (
            <ol className="residuals">
              {res.residuals.map((r, i) => (
                <li key={i} className={`residual ${selected === i ? "is-selected" : ""}`} onClick={() => setSelected(i)}>
                  <span className={`residual__badge ${r.known_source ? "is-known" : "is-unknown"}`}>
                    {KIND_LABEL[r.kind]}
                  </span>
                  <span className="mono">#{i + 1} · {r.significance > 0 ? "+" : ""}{r.significance.toFixed(1)}σ · {r.ra.toFixed(5)}, {r.dec.toFixed(5)}</span>
                  <p>{r.explanation}</p>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
