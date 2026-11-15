import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BandName } from "../api/types";
import { BAND_ORDER } from "../lib/astro";

export interface PlotPoint {
  key: string;
  x: number;
  y: number;
  yErr?: number;
  band: BandName;
  group: number; // visit index -> marker shape
  style?: "solid" | "hollow" | "cross";
  highlight?: boolean;
  tooltip: string[];
}

interface Props {
  points: PlotPoint[];
  xLabel: string;
  yLabel: string;
  logY?: boolean;
  xFormat?: (v: number) => string;
  groupLabels: Record<number, string>;
  tableColumns: { label: string; value: (p: PlotPoint) => string }[];
  ariaLabel: string;
  height?: number;
}

const SHAPES = ["circle", "square", "triangle", "diamond", "triangle-down", "plus"] as const;

function niceTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) return [min];
  const step0 = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

function logTicks(min: number, max: number): number[] {
  const out: number[] = [];
  for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e;
      if (v >= min && v <= max) out.push(v);
    }
  }
  return out.length >= 2 ? out : [min, max];
}

function Marker({ shape, x, y, r, color, style }: { shape: (typeof SHAPES)[number]; x: number; y: number; r: number; color: string; style: PlotPoint["style"] }) {
  const fill = style === "solid" ? color : "var(--surface-1)";
  const common = { stroke: color, strokeWidth: 1.6, fill };
  if (style === "cross") {
    return <path d={`M${x - r} ${y - r}L${x + r} ${y + r}M${x - r} ${y + r}L${x + r} ${y - r}`} stroke={color} strokeWidth={1.8} />;
  }
  switch (shape) {
    case "square": return <rect x={x - r * 0.85} y={y - r * 0.85} width={r * 1.7} height={r * 1.7} rx={1} {...common} />;
    case "triangle": return <path d={`M${x} ${y - r}L${x + r} ${y + r * 0.8}L${x - r} ${y + r * 0.8}Z`} {...common} />;
    case "triangle-down": return <path d={`M${x} ${y + r}L${x + r} ${y - r * 0.8}L${x - r} ${y - r * 0.8}Z`} {...common} />;
    case "diamond": return <path d={`M${x} ${y - r}L${x + r} ${y}L${x} ${y + r}L${x - r} ${y}Z`} {...common} />;
    case "plus": return <path d={`M${x - r} ${y}H${x + r}M${x} ${y - r}V${y + r}`} stroke={color} strokeWidth={2} />;
    default: return <circle cx={x} cy={y} r={r * 0.9} {...common} />;
  }
}

/** Scatter with error bars. Colour = SPHEREx band (fixed order), shape = visit. */
export function ScatterPlot(p: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<PlotPoint | null>(null);
  const [table, setTable] = useState(false);
  const height = p.height ?? 300;

  useLayoutEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, e.contentRect.width)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const m = { l: 62, r: 14, t: 12, b: 42 };
  const W = width - m.l - m.r;
  const H = height - m.t - m.b;

  const scales = useMemo(() => {
    const pts = p.points.filter((d) => Number.isFinite(d.x) && Number.isFinite(d.y) && (!p.logY || d.y > 0));
    if (!pts.length) return null;
    let x0 = Math.min(...pts.map((d) => d.x));
    let x1 = Math.max(...pts.map((d) => d.x));
    const pad = (x1 - x0) * 0.04 || 1;
    x0 -= pad;
    x1 += pad;
    let y0 = Math.min(...pts.map((d) => d.y - (d.yErr ?? 0)));
    let y1 = Math.max(...pts.map((d) => d.y + (d.yErr ?? 0)));
    if (p.logY) {
      y0 = Math.max(Math.min(...pts.map((d) => d.y)) / 1.5, 1e-6);
      y1 = y1 * 1.3;
    } else {
      const py = (y1 - y0) * 0.08 || 1;
      y0 -= py;
      y1 += py;
    }
    const sx = (v: number) => m.l + ((v - x0) / (x1 - x0)) * W;
    const sy = p.logY
      ? (v: number) => m.t + H - ((Math.log10(Math.max(v, y0)) - Math.log10(y0)) / (Math.log10(y1) - Math.log10(y0))) * H
      : (v: number) => m.t + H - ((v - y0) / (y1 - y0)) * H;
    return { pts, sx, sy, xt: niceTicks(x0, x1, Math.max(3, Math.floor(W / 90))), yt: p.logY ? logTicks(y0, y1) : niceTicks(y0, y1, 5) };
  }, [p.points, p.logY, W, H, m.l, m.t]);

  const bandsPresent = BAND_ORDER.filter((b) => p.points.some((d) => d.band === b));
  const groupsPresent = [...new Set(p.points.map((d) => d.group))].sort((a, b) => a - b);
  const fmtX = p.xFormat ?? ((v: number) => String(+v.toPrecision(4)));
  const fmtY = (v: number) => {
    const a = Math.abs(v);
    if (a >= 1e6) return `${+(v / 1e6).toPrecision(3)}M`;
    if (a >= 1e3) return `${+(v / 1e3).toPrecision(3)}k`;
    if (a < 0.01 && v !== 0) return v.toExponential(0);
    return String(+v.toPrecision(3));
  };

  return (
    <div className="plot" ref={wrap}>
      <div className="plot__legend" aria-label="Legend">
        {bandsPresent.map((b) => (
          <span key={b} className="plot__legend-item">
            <svg width="12" height="12" aria-hidden><circle cx="6" cy="6" r="5" fill={`var(--band-${b.toLowerCase()})`} /></svg>
            {b}
          </span>
        ))}
        <span className="plot__legend-sep" />
        {groupsPresent.map((g) => (
          <span key={g} className="plot__legend-item">
            <svg width="14" height="14" aria-hidden><Marker shape={SHAPES[g % SHAPES.length]} x={7} y={7} r={5} color="var(--text-secondary)" style="hollow" /></svg>
            {p.groupLabels[g] ?? `V${g + 1}`}
          </span>
        ))}
        {/* One label, as in the side menu's charts; aria-pressed says whether the table is shown. */}
        <button className="btn btn--ghost btn--sm plot__table-toggle" onClick={() => setTable((t) => !t)} aria-pressed={table}>
          Table
        </button>
      </div>

      {table ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr>{p.tableColumns.map((c) => <th key={c.label}>{c.label}</th>)}</tr></thead>
            <tbody>
              {p.points.map((d) => <tr key={d.key}>{p.tableColumns.map((c) => <td key={c.label}>{c.value(d)}</td>)}</tr>)}
            </tbody>
          </table>
        </div>
      ) : !scales ? (
        <p className="muted">No data to plot.</p>
      ) : (
        <svg width={width} height={height} role="img" aria-label={p.ariaLabel} onMouseLeave={() => setHover(null)}>
          {scales.yt.map((t) => (
            <g key={`y${t}`}>
              <line x1={m.l} x2={m.l + W} y1={scales.sy(t)} y2={scales.sy(t)} stroke="var(--grid-line)" />
              <text x={m.l - 6} y={scales.sy(t)} dy="0.32em" textAnchor="end" className="plot__tick">{fmtY(t)}</text>
            </g>
          ))}
          {scales.xt.map((t) => (
            <text key={`x${t}`} x={scales.sx(t)} y={m.t + H + 16} textAnchor="middle" className="plot__tick">{fmtX(t)}</text>
          ))}
          <line x1={m.l} x2={m.l + W} y1={m.t + H} y2={m.t + H} stroke="var(--axis-line)" />
          <text x={m.l + W / 2} y={height - 6} textAnchor="middle" className="plot__axis-label">{p.xLabel}</text>
          <text transform={`translate(14 ${m.t + H / 2}) rotate(-90)`} textAnchor="middle" className="plot__axis-label">{p.yLabel}</text>

          {scales.pts.map((d) => {
            const x = scales.sx(d.x);
            const y = scales.sy(d.y);
            const color = `var(--band-${d.band.toLowerCase()})`;
            return (
              <g key={d.key} opacity={hover && hover.key !== d.key ? 0.55 : 1}>
                {d.yErr !== undefined && d.yErr > 0 && (
                  <line x1={x} x2={x} y1={scales.sy(d.y + d.yErr)} y2={scales.sy(Math.max(d.y - d.yErr, p.logY ? 1e-6 : -Infinity))} stroke={color} strokeWidth={1} opacity={0.7} />
                )}
                {d.highlight && <circle cx={x} cy={y} r={8} fill="none" stroke="var(--text-primary)" strokeWidth={1.5} />}
                <Marker shape={SHAPES[d.group % SHAPES.length]} x={x} y={y} r={4.5} color={color} style={d.style ?? "solid"} />
                {/* Hit target larger than the mark */}
                <circle cx={x} cy={y} r={9} fill="transparent" onMouseEnter={() => setHover(d)} />
              </g>
            );
          })}

          {hover && (() => {
            const x = scales.sx(hover.x);
            const y = scales.sy(hover.y);
            const w = 230;
            const h = 14 + hover.tooltip.length * 15;
            const tx = x + 12 + w > width ? x - 12 - w : x + 12;
            const ty = Math.min(Math.max(y - h / 2, 2), height - h - 2);
            return (
              <g className="plot__tooltip" pointerEvents="none">
                <rect x={tx} y={ty} width={w} height={h} rx={6} />
                {hover.tooltip.map((line, i) => (
                  <text key={i} x={tx + 8} y={ty + 16 + i * 15} className={i === 0 ? "plot__tooltip-title" : ""}>{line}</text>
                ))}
              </g>
            );
          })()}
        </svg>
      )}
    </div>
  );
}
