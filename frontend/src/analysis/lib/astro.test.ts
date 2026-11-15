import { describe, expect, it } from "vitest";
import { formatDec, formatRa, parsePolygon, propagate } from "./astro";

describe("formatting", () => {
  it("formats WISE 0855 coordinates from the challenge statement", () => {
    expect(formatRa(133.79513)).toBe("08:55:10.83");
    expect(formatDec(-7.245147)).toBe("-07:14:42.5");
  });
  it("carries seconds rounding into minutes", () => {
    expect(formatRa(359.99999999)).toBe("00:00:00.00");
  });
});

describe("propagate", () => {
  it("moves Barnard's Star ~4.5' north between 2000 and 2026", () => {
    const t = {
      name: "Barnard",
      ra: 269.4520769586187,
      dec: 4.69336496657667,
      epoch_jyear: 2000,
      pm_ra_mas_yr: -801.551,
      pm_dec_mas_yr: 10362.394,
      source: "test",
    };
    const p = propagate(t, 2026);
    expect((p.dec - t.dec) * 3600).toBeCloseTo(10.362394 * 26, 3);
    expect(p.ra).toBeLessThan(t.ra);
  });
});

describe("parsePolygon", () => {
  it("drops the closing vertex", () => {
    const pts = parsePolygon("POLYGON ICRS 1 2 3 4 5 6 7 8 1 2");
    expect(pts).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 8],
    ]);
  });
  it("rejects garbage", () => {
    expect(parsePolygon("CIRCLE 1 2 3")).toBeNull();
  });
});

