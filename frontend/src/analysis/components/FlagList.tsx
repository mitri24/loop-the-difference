// SPHEREx L2 pixel flags, grouped exactly like backend/app/cutouts.py.
const HARD = new Set(["SUR_ERROR", "NONFUNC", "MISSING_DATA", "HOT", "COLD"]);
const DEGRADED = new Set(["OVERFLOW", "NONLINEAR"]);
const INFO = new Set(["SOURCE", "FULLSAMPLE"]);

const DESCRIPTIONS: Record<string, string> = {
  TRANSIENT: "Transient detected during sampling",
  OVERFLOW: "Saturated: flux from samples before overflow",
  SUR_ERROR: "Error in onboard processing",
  NONFUNC: "Permanently unusable pixel",
  DICHROIC: "Low efficiency due to dichroic",
  MISSING_DATA: "Onboard data lost",
  HOT: "Hot pixel",
  COLD: "Anomalously low signal",
  FULLSAMPLE: "Full sample history available",
  PHANMISS: "Phantom correction not applied",
  NONLINEAR: "Nonlinearity correction unreliable",
  PERSIST: "Persistent charge from a previous exposure",
  OUTLIER: "Flagged by outlier detection",
  CROSSTALK: "Affected by crosstalk",
  SOURCE: "Pixel mapped to a known source (informational)",
  GHOST: "Ghost of a bright source in the exposure",
  GHOST_FPA: "Ghost from a source on another detector",
  GHOST_EXT: "Ghost from a source outside the field",
  STREAK: "Satellite/asteroid streak",
  BLOOM: "Part of a bloom artefact",
  SNOWBALL: "Cosmic-ray snowball",
  HALO: "Transient halo",
};

export function flagClass(flag: string): "hard" | "degraded" | "info" | "artifact" {
  if (HARD.has(flag)) return "hard";
  if (DEGRADED.has(flag)) return "degraded";
  if (INFO.has(flag)) return "info";
  return "artifact";
}

export function FlagList({ flags }: { flags: string[] }) {
  if (!flags.length) return <span className="muted">none</span>;
  return (
    <span className="flags">
      {flags.map((f) => (
        <span key={f} className={`flag flag--${flagClass(f)}`} title={DESCRIPTIONS[f] ?? f}>
          {f}
        </span>
      ))}
    </span>
  );
}
