import { test, expect, type Page, type Locator } from '@playwright/test'
import type { FrameJob, FrameManifest, ObservationSummary, SpectrumJob, SpectrumPoint } from '../src/types'

// Synthetic contract fixtures test UI states only. They are never shipped as observations.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64')
const frames = Array.from({ length: 8 }, (_, index) => ({
  index, url: `/api/frames/fixture/frame_${index}.png`, obs_id: `fixture-${index}`,
  date: `2026-${String(index + 1).padStart(2, '0')}-10T12:00:00Z`, mjd: 61000 + index * 30,
  detector: 6, wavelength_min_um: 4.41, wavelength_max_um: 5.01, coverage: 0.96,
  source_url: `https://example.test/fixture-${index}`, epoch: Math.floor(index / 2), n_combined: 1,
  date_end: null, masked_fraction: 0.01, wavelength_um: 4.6 + index * 0.01, bandwidth_um: 0.04,
  release: index < 2 ? 'DR1' : 'QR3',
}))
const manifest: FrameManifest = {
  collection: 'spherex_dr1,spherex_qr3', ra: 269.452, dec: 4.693, size_deg: 0.2, detector: 6,
  pixel_scale_arcsec: 6.15, epochs: 4, complete: true, stacked: false, frames, warnings: [],
  checks: [{ code: 'MIXED_RELEASES', severity: 'info', message: 'Mixed releases', detail: 'DR1 + QR3', affects: [] }],
  differences: [],
}
const summary: ObservationSummary = {
  collection: 'spherex_dr1', ra: manifest.ra, dec: manifest.dec, count: 8, detectors: { '6': 8 }, epochs: [],
  observations: frames.map((f) => ({ obs_id: f.obs_id, detector: 6, wavelength_min_um: 4.41, wavelength_max_um: 5.01,
    mjd: f.mjd, date: f.date, access_url: f.source_url })),
}
const motion = { source_id: '4472832130942575872', ra: manifest.ra, dec: manifest.dec, ref_epoch: 2016,
  pmra_mas_yr: -801.6, pmdec_mas_yr: 10362.4, parallax_mas: 546.98 }
// Thirty visits over all six detectors and three epochs, one flagged.
const points: SpectrumPoint[] = Array.from({ length: 30 }, (_, i) => ({
  obs_id: `visit-${i}`, date: `2026-0${1 + (i % 3) * 3}-15T00:00:00Z`, mjd: 61000 + (i % 3) * 90,
  detector: 1 + Math.floor(i / 5), epoch: i % 3, wavelength_um: 0.8 + i * 0.14, bandwidth_um: 0.02,
  flux_ujy: 900 + 40 * Math.sin(i), flux_err_ujy: 12, flagged: i === 7, source_url: `https://example.test/visit-${i}`,
}))

async function fixtures(page: Page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    // The analysis service is not under test here: it answers as unavailable, which the panels handle.
    if (url.pathname.startsWith('/analysis/')) return route.fulfill({ status: 503, json: { detail: 'Fixture analysis service unavailable' } })
    if (url.pathname.endsWith('.png')) return route.fulfill({ contentType: 'image/png', body: png })
    if (url.pathname === '/api/resolve') return route.fulfill({ json: { name: "Barnard's Star", ra: manifest.ra, dec: manifest.dec, proper_motion: motion } })
    if (url.pathname === '/api/observations') return route.fulfill({ json: summary })
    if (url.pathname.startsWith('/api/spectrum')) {
      const job: SpectrumJob = { job_id: 'spectrum', status: 'finished', progress: 30, total: 30, error: null,
        spectrum: { collection: 'spherex_dr1', ra: manifest.ra, dec: manifest.dec, complete: true, points, checks: [] } }
      return route.fulfill({ json: job })
    }
    const job: FrameJob = { job_id: 'fixture', status: 'finished', progress: 8, total: 8, manifest, error: null }
    return route.fulfill({ json: job })
  })
}
const overflow = (locator: Locator) => locator.evaluate((el) => el.scrollHeight - el.clientHeight)
async function inView(page: Page, locator: Locator) {
  const box = (await locator.boundingBox())!
  const body = (await page.locator('.viewer-body').boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(body.y - 1)
  expect(box.y + box.height).toBeLessThanOrEqual(body.y + body.height + 1)
}

for (const [width, height] of [[1024, 700], [1280, 800], [1440, 900]]) {
  test(`${width}×${height}: image left, A and B as a table beside it, the bar under it – without scrolling`, async ({ page }) => {
    await fixtures(page)
    await page.setViewportSize({ width, height })
    await page.goto(`/?ra=${manifest.ra}&dec=${manifest.dec}&fov=0.2&band=6&name=Barnard%27s%20Star`)
    const table = page.locator('.pair-table')
    await expect(table.locator('th[scope="row"]', { hasText: 'Gaia DR3' })).toHaveAttribute('title', /4472832130942575872/)
    // No page scrolling: thumbnails, image and bar fit; the table column scrolls on its own if it must.
    expect(await overflow(page.locator('.viewer-body'))).toBeLessThanOrEqual(1)
    await inView(page, page.locator('.viewer .viewport'))
    await inView(page, page.locator('.transport'))
    await inView(page, page.locator('.player-side'))
    // Image left, the table right of it.
    const image = (await page.locator('.viewer .viewport').boundingBox())!
    const side = (await page.locator('.player-side').boundingBox())!
    expect(side.x).toBeGreaterThanOrEqual(image.x + image.width)
    const rail = (await page.locator('.observation-gallery').boundingBox())!
    expect(rail.x).toBeLessThan(image.x)
    // The inspector hangs under the overview map, as wide as it, inside the window.
    const map = (await page.locator('.sky-area.overview').boundingBox())!
    const inspector = (await page.locator('.inspector').boundingBox())!
    expect(Math.abs(inspector.x - map.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(inspector.width - map.width)).toBeLessThanOrEqual(1)
    expect(inspector.y).toBeGreaterThan(map.y + map.height)
    expect(inspector.y + inspector.height).toBeLessThanOrEqual(height)
    // Provenance in the table; the pair opens compatible and its verdict names the releases that differ.
    await expect(table.locator('a', { hasText: 'fixture-1' })).toHaveAttribute('href', 'https://example.test/fixture-1')
    await expect(table.locator('tr', { hasText: 'Wavelength' })).toContainText('λ 4.610')
    await expect(page.locator('.pair-verdict')).toContainText('same wavelength')
    await expect(page.locator('.pair-verdict')).toContainText('releases differ')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
  })
}

test('the inspector: a tab per kind, arrow keys between tabs, the image never moves; A and B from the table', async ({ page }) => {
  await fixtures(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/?ra=${manifest.ra}&dec=${manifest.dec}&fov=0.2&band=6`)
  await expect(page.locator('.player')).toBeVisible()
  const image = await page.locator('.viewer .viewport').boundingBox()
  for (const id of ['quality', 'candidate', 'measure', 'coverage', 'analysis', 'data']) {
    await page.getByTestId(`inspect-${id}`).click()
    await expect(page.getByTestId(`inspect-${id}`)).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator(`#inspect-panel-${id}`)).toBeVisible()
    expect(await page.locator('.viewer .viewport').boundingBox(), id).toEqual(image)
  }
  // Arrows move the focus between tabs (not between frames), Home and End jump; Enter opens the focused tab.
  await page.getByTestId('inspect-quality').click()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('inspect-candidate')).toBeFocused()
  await expect(page.getByTestId('inspect-quality')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('inspect-candidate')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('End')
  await expect(page.getByTestId('inspect-data')).toBeFocused()
  await page.keyboard.press('Home')
  await expect(page.getByTestId('inspect-quality')).toBeFocused()
  await expect(page.locator('.stamp')).toContainText('A ·')
  // No sidebar, no section page, no mode tabs, no permanent caveat line: the caveat stands with the checks.
  await expect(page.locator('.science-note')).toHaveCount(0)
  await expect(page.locator('.section-nav')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Blink A↔B' })).toHaveCount(0)
  await page.getByTestId('inspect-quality').click()
  await expect(page.locator('#inspect-panel-quality')).toContainText('Changes are candidates')
  // Swap exchanges A and B; a thumbnail shows any frame, and "Use as A" makes it A.
  const a = page.getByRole('combobox', { name: 'Frame A' })
  const b = page.getByRole('combobox', { name: 'Frame B' })
  const [before, after] = [await a.inputValue(), await b.inputValue()]
  await page.getByRole('button', { name: 'Swap A and B' }).click()
  await expect(a).toHaveValue(after)
  await expect(b).toHaveValue(before)
  await page.getByRole('button', { name: /^Show observation 7,/ }).click()
  await expect(page.locator('.pair-shown')).toContainText('Showing frame 7 of 8')
  await page.getByRole('button', { name: 'Use as A', exact: true }).click()
  await expect(a).toHaveValue('6')
  await expect(page.locator('.stamp')).toContainText('A · 2026-07-10')
  // Expand lays the inspector wider over the images without moving them; Escape docks it.
  const docked = (await page.locator('.inspector').boundingBox())!
  await page.getByRole('button', { name: 'Expand inspector' }).click()
  expect((await page.locator('.inspector').boundingBox())!.width).toBeGreaterThan(docked.width * 1.5)
  expect(await page.locator('.viewer .viewport').boundingBox()).toEqual(image)
  await page.keyboard.press('Escape')
  expect(await page.locator('.inspector').boundingBox()).toEqual(docked)
  // A sheet (Options, Layers, About) lies over the page: the image keeps its place and size.
  await page.getByTestId('open-layers').click()
  await expect(page.locator('.fpanel')).toBeVisible()
  expect(await page.locator('.viewer .viewport').boundingBox()).toEqual(image)
  await page.keyboard.press('Escape')
  await expect(page.locator('.fpanel')).toBeHidden()
})

test('charts: tooltip on hover and keyboard focus, Table toggle, width follows the panel after the table', async ({ page }) => {
  await fixtures(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/?ra=${manifest.ra}&dec=${manifest.dec}&fov=0.2&band=6`)
  await page.getByTestId('inspect-measure').click()
  await page.getByRole('button', { name: 'Measure the target in all SPHEREx visits' }).click()
  const chart = page.locator('.spectrum-chart')
  await expect(chart.locator('svg[role="img"]')).toBeVisible()
  await expect(page.getByRole('figure', { name: 'Flux at the target by wavelength' })).toBeVisible()
  const point = chart.locator('a').first()
  await point.hover()
  await expect(chart.locator('.viz-tooltip strong')).toContainText('µJy')
  await page.mouse.move(0, 0)
  await expect(chart.locator('.viz-tooltip')).toHaveCount(0)
  await chart.locator('a').nth(7).focus()
  await expect(chart.locator('.viz-tooltip')).toContainText('flagged pixels in aperture')
  const toggle = chart.getByRole('button', { name: 'Table', exact: true })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(chart.locator('.viz-table-view table')).toBeVisible()
  await expect(chart.locator('.viz-table-view a')).toHaveCount(0)
  await toggle.click()
  const svgWidth = async () => Number(await chart.locator('svg[role="img"]').getAttribute('width'))
  const bodyWidth = async () => chart.locator('.viz-body').evaluate((el) => el.clientWidth)
  await expect.poll(async () => Math.abs((await svgWidth()) - (await bodyWidth()))).toBeLessThanOrEqual(1)
  await page.setViewportSize({ width: 1100, height: 900 })
  await expect.poll(async () => Math.abs((await svgWidth()) - (await bodyWidth()))).toBeLessThanOrEqual(1)
})

test('embed: thumbnails stay a strip and every player control stays reachable', async ({ page }) => {
  await fixtures(page)
  await page.setViewportSize({ width: 480, height: 640 })
  await page.goto(`/?ra=${manifest.ra}&dec=${manifest.dec}&embed=1`)
  const strip = page.locator('.observation-strip')
  await expect(strip).toBeVisible()
  expect((await strip.boundingBox())!.height).toBeLessThan(100)
  for (const name of ['Play', 'Copy link', 'Show frame A']) {
    const control = page.getByRole('button', { name, exact: true })
    await control.scrollIntoViewIfNeeded()
    expect(await control.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return !!hit && (el === hit || el.contains(hit))
    })).toBe(true)
  }
})
