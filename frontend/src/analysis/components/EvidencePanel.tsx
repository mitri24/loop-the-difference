import type { Check, Severity } from "../api/types";

const ICON: Record<Severity, string> = { ok: "✓", info: "i", warn: "!", fail: "✕" };
const LABEL: Record<Severity, string> = { ok: "Pass", info: "Note", warn: "Caution", fail: "Blocked" };

export interface CheckGroup {
  title: string;
  checks: Check[];
}

/** Evidence-backed checks. Status colour is always paired with an icon and a word. */
export function EvidencePanel({ groups }: { groups: CheckGroup[] }) {
  const visible = groups.filter((g) => g.checks.length);
  if (!visible.length) {
    return <p className="muted">Checks appear here as you search, blink and compare.</p>;
  }
  return (
    <div className="evidence">
      {visible.map((g) => (
        <section key={g.title}>
          <h3 className="evidence__group">{g.title}</h3>
          <ul className="checks">
            {g.checks.map((c, i) => (
              <li key={`${c.code}-${i}`} className={`check-item check-item--${c.severity}`}>
                <span className="check-item__icon" aria-hidden>{ICON[c.severity]}</span>
                <div>
                  <div className="check-item__title">
                    <span className="sr-only">{LABEL[c.severity]}: </span>
                    {c.title}
                    <span className="check-item__label">{LABEL[c.severity]}</span>
                  </div>
                  <div className="check-item__detail">{c.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
