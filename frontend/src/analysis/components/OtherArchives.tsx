import { api } from "../api/client";
import type { CadcCollection, CadcSearch, Target } from "../api/types";
import { formatDate } from "../lib/astro";
import { useJob } from "../lib/useJob";
import { Progress } from "./SpectrumPanel";

interface Props {
  target: Target;
  fovArcmin: number;
}

/** Images of the same field from other telescopes, held at the Canadian Astronomy Data
 *  Centre (NRC Canada), with the Canadian Space Agency's NEOSSat first. Context only:
 *  other wavelengths, resolutions and epochs — never mixed into the SPHEREx blink. */
export function OtherArchives({ target, fovArcmin }: Props) {
  const job = useJob<CadcSearch>();
  const res = job.result;

  return (
    <section className="archives" aria-label="Other telescopes at this position">
      <h3 className="h3">Other telescopes here — CADC (Canada)</h3>
      <p className="small muted">
        The Canadian Astronomy Data Centre holds images of this field from other telescopes, including the Canadian
        Space Agency's NEOSSat. They are not SPHEREx: other wavelengths, resolutions and dates. Use them for context or
        to check a candidate (look at the date and band first), never for difference images with SPHEREx.
      </p>
      {!res && (
        <div className="sso-bar">
          <button
            className="btn btn--sm"
            disabled={job.running}
            onClick={() => void job.start(() => api.startCadc(target, fovArcmin))}
          >
            Search the CADC archive (2–20 s)
          </button>
          {job.running && job.job && <Progress value={job.job.progress} message={job.job.message} />}
          {job.error && <span className="alert alert--fail small">{job.error}</span>}
        </div>
      )}
      {res && <Results res={res} />}
    </section>
  );
}

function Results({ res }: { res: CadcSearch }) {
  return (
    <>
      <p className="small">
        <strong>{res.n_images}</strong> science image products from <strong>{res.collections.length}</strong> archives
        whose footprint overlaps the {res.radius_arcmin.toFixed(1)}′ circle around the target's current position.
        Calibration frames and spectrograph fibres are left out.
      </p>
      {res.checks.map((c) => (
        <p key={c.code} className={c.severity === "warn" || c.severity === "fail" ? "alert alert--warn small" : "small muted"}>
          <strong>{c.title}.</strong> {c.detail}
        </p>
      ))}
      {res.collections.map((c, i) => <Collection key={c.collection} c={c} open={i < 2} />)}
      <p className="small muted">
        {res.excluded_collections.length > 0 && (
          <>Not listed: {res.excluded_collections.join(", ")} (cutouts too numerous for this view). </>
        )}
        <a href={res.search_url} target="_blank" rel="noreferrer">Open the full CADC search</a> ·{" "}
        <a href={res.query_url} target="_blank" rel="noreferrer">TAP query</a>
      </p>
    </>
  );
}

function Collection({ c, open }: { c: CadcCollection; open: boolean }) {
  const range =
    c.first_date && c.last_date
      ? c.first_date.slice(0, 4) === c.last_date.slice(0, 4)
        ? c.first_date.slice(0, 4)
        : `${c.first_date.slice(0, 4)}–${c.last_date.slice(0, 4)}`
      : "dates n/a";
  return (
    <details className="archive" open={open}>
      <summary>
        <span className="archive__name">{c.label}</span>
        {c.canadian && <span className="archive__badge">Canada</span>}
        <span className="archive__meta mono">
          {c.n_images} img · {range}
          {c.bands.length > 0 && <> · {c.bands.slice(0, 4).join(", ")}</>}
        </span>
      </summary>
      <ul className="archive__thumbs">
        {c.images.map((im) => (
          <li key={im.files_url}>
            <a href={im.files_url} target="_blank" rel="noreferrer" title={`${im.observation_id} — all files (CADC DataLink)`}>
              {im.thumbnail_url ? (
                <img
                  src={im.thumbnail_url}
                  alt={`${c.collection} ${im.observation_id}${im.date_utc ? `, ${formatDate(im.date_utc)}` : ""}`}
                  loading="lazy"
                  onError={(e) => e.currentTarget.classList.add("is-broken")}
                />
              ) : (
                <span className="archive__noprev">{im.proprietary ? "embargoed" : "no preview"}</span>
              )}
            </a>
            <span className="archive__cap mono">
              {im.date_utc ? formatDate(im.date_utc) : "—"}
              {im.band && <> · {im.band}</>}
            </span>
          </li>
        ))}
      </ul>
      {c.instruments.length > 0 && <p className="small muted">Instruments: {c.instruments.join(", ")}</p>}
    </details>
  );
}
