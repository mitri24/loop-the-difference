// Pure astronomy/formatting helpers (unit-tested in astro.test.ts).

import type { Target } from "../api/types";

export const BAND_ORDER = ["D1", "D2", "D3", "D4", "D5", "D6"] as const;

export function pad(n: number, width: number, decimals = 0): string {
  const s = n.toFixed(decimals);
  const [int, frac] = s.split(".");
  return int.padStart(width, "0") + (frac !== undefined ? "." + frac : "");
}

/** Degrees → "hh:mm:ss.ss" */
export function formatRa(deg: number): string {
  let total = (((deg % 360) + 360) % 360) / 15;
  let h = Math.floor(total);
  total = (total - h) * 60;
  let m = Math.floor(total);
  let s = Math.round((total - m) * 60 * 100) / 100;
  if (s >= 60) {
    s -= 60;
    m += 1;
  }
  if (m >= 60) {
    m -= 60;
    h = (h + 1) % 24;
  }
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2, 2)}`;
}

/** Degrees → "±dd:mm:ss.s" */
export function formatDec(deg: number): string {
  const sign = deg < 0 ? "-" : "+";
  let total = Math.abs(deg);
  let d = Math.floor(total);
  total = (total - d) * 60;
  let m = Math.floor(total);
  let s = Math.round((total - m) * 60 * 10) / 10;
  if (s >= 60) {
    s -= 60;
    m += 1;
  }
  if (m >= 60) {
    m -= 60;
    d += 1;
  }
  return `${sign}${pad(d, 2)}:${pad(m, 2)}:${pad(s, 2, 1)}`;
}

export function mjdToJyear(mjd: number): number {
  return 2000.0 + (mjd - 51544.5) / 365.25;
}

/** Linear proper-motion propagation; pmRA includes cos(dec). Mirrors backend astrometry.py. */
export function propagate(t: Target, toJyear: number): { ra: number; dec: number } {
  if (!t.pm_ra_mas_yr && !t.pm_dec_mas_yr) return { ra: t.ra, dec: t.dec };
  const dt = toJyear - t.epoch_jyear;
  const cosd = Math.max(Math.cos((t.dec * Math.PI) / 180), 1e-9);
  const ra = t.ra + ((t.pm_ra_mas_yr ?? 0) * dt) / 3.6e6 / cosd;
  const dec = t.dec + ((t.pm_dec_mas_yr ?? 0) * dt) / 3.6e6;
  return { ra: ((ra % 360) + 360) % 360, dec: Math.max(-90, Math.min(90, dec)) };
}

/** Parse an IRSA "POLYGON ICRS ra dec ..." s_region into [ra, dec] pairs (ring not closed). */
export function parsePolygon(sRegion: string): [number, number][] | null {
  const m = /POLYGON\s+(?:ICRS\s+)?(.*)/i.exec(sRegion.trim());
  if (!m) return null;
  const nums = m[1].trim().split(/\s+/).map(Number);
  if (nums.length < 6 || nums.length % 2 !== 0 || nums.some((n) => !Number.isFinite(n))) {
    return null;
  }
  const pts: [number, number][] = [];
  for (let i = 0; i < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  const [f, l] = [pts[0], pts[pts.length - 1]];
  if (pts.length > 3 && f[0] === l[0] && f[1] === l[1]) pts.pop();
  return pts;
}

export function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

export function formatPm(t: Target): string | null {
  if (t.pm_ra_mas_yr == null && t.pm_dec_mas_yr == null) return null;
  const total = Math.hypot(t.pm_ra_mas_yr ?? 0, t.pm_dec_mas_yr ?? 0) / 1000;
  return `${total.toFixed(total < 1 ? 3 : 2)}″/yr`;
}
