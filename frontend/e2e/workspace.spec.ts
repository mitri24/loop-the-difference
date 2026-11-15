import { readFile } from 'node:fs/promises'
import { test, expect, type Page, type Locator } from '@playwright/test'
import type { FrameJob, FrameManifest, ObservationSummary, PairDifferenceJob } from '../src/types'

// Synthetic contract fixtures test UI states only. They are never shipped as observations.
const frame = (index: number) => ({
  index, url: `/api/frames/fixture/frame_${index}.png`, obs_id: `fixture-${index}`,
  date: index ? '2026-09-10T12:00:00Z' : '2026-03-10T12:00:00Z', mjd: 61000 + index * 180,
  detector: 6, wavelength_min_um: 4.41, wavelength_max_um: 5.01, coverage: 0.96,
  source_url: `https://example.test/fixture-${index}`, epoch: index, n_combined: 2,
  date_end: null, masked_fraction: 0.01, wavelength_um: 4.7, bandwidth_um: 0.1,
})
const manifest: FrameManifest = {
  collection: 'TEST_FIXTURE', ra: 37.954542, dec: 89.264111, size_deg: 0.2,
  detector: 6, pixel_scale_arcsec: 6.2, epochs: 2, complete: true, stacked: true,
  frames: [frame(0), frame(1)], warnings: [], checks: [],
  differences: [{ a: 0, b: 1, url: '/api/frames/fixture/diff.png', comparable: true,
    delta_lambda_pct: 0.3, obs_ids_a: ['fixture-0'], obs_ids_b: ['fixture-1'] }],
}
const summary: ObservationSummary = {
  collection: 'TEST_FIXTURE', ra: manifest.ra, dec: manifest.dec, count: 4,
  detectors: { '6': 4 }, epochs: [
    { start: frame(0).date, end: frame(0).date, count: 2 },
    { start: frame(1).date, end: frame(1).date, count: 2 },
  ], observations: [],
}
const job = (data = manifest): FrameJob => ({ job_id: 'fixture', status: 'finished',
  progress: 2, total: 2, manifest: data, error: null })
// The changes the worker finds between frames 0 and 1 (backend/app/difference.py).
const pairJob: PairDifferenceJob = { job_id: 'fixturepair', status: 'finished', error: null, difference: {
  job_id: 'fixture', a: 0, b: 1, comparable: true, reason: null, method: 'zogy',
  significance_url: '/api/frames/fixture/pairsig_00_01_v1.png', difference_url: '/api/frames/fixture/pairdiff_00_01_v1.png',
  delta_days: 180, delta_lambda_pct: 0.3, small_bodies_checked: false, checks: [],
  residuals: [{ x: 60, y: 50, ra: manifest.ra, dec: manifest.dec, significance: 7.5, kind: 'unknown', known: null,
    explanation: 'Brighter in B. No known asteroid, bright star or catalogue source here – needs verification.' }] } }
const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64')
async function fixtures(page: Page, data = manifest) {
  await page.route(url => url.pathname.startsWith('/api/') || url.pathname.startsWith('/analysis/api/'), async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.startsWith('/analysis/')) return route.fulfill({ json: { target: {ra: manifest.ra, dec: manifest.dec}, observations: [], visits: [], checks: [], query_urls: [], fov_arcmin: 12 } })
    if (url.pathname.endsWith('.png')) return route.fulfill({ contentType: 'image/png', body: transparentPng })
    if (url.pathname === '/api/resolve') return route.fulfill({ json: { name: 'Polaris', ra: manifest.ra, dec: manifest.dec } })
    if (url.pathname === '/api/observations') return route.fulfill({ json: summary })
    if (url.pathname.startsWith('/api/difference')) return route.fulfill({ json: pairJob })
    return route.fulfill({ json: job(data) })
  })
}
async function fits(page: Page, locator: Locator) {
  await expect(locator).toBeVisible()
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  const vp = page.viewportSize()!
  expect(box!.x).toBeGreaterThanOrEqual(-1)
  expect(box!.y).toBeGreaterThanOrEqual(-1)
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 1)
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height + 1)
}
async function hitTarget(locator: Locator) {
  await locator.scrollIntoViewIfNeeded()
  expect(await locator.evaluate(el => {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return !!hit && (el === hit || el.contains(hit))
  })).toBe(true)
}

// No sidebar: the controls that are not information open as a sheet from the header (folded into "⋯" on narrow
// headers); the information is in the inspector under the overview map, one tab per kind (on phones it opens with
// Inspect under the images).
const SHEET_IDS = ['target', 'layers', 'about'] as const
async function openTab(page: Page, id: string, tap = false) {
  const toggle = page.locator('.inspect-toggle')
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') await (tap ? toggle.tap() : toggle.click())
  const tab = page.getByTestId(`inspect-${id}`)
  await (tap ? tab.tap() : tab.click())
  return page.locator(`#inspect-panel-${id}`)
}
// Phones: the inspector takes the lower half of the stage; closing it gives the images the whole stage again.
async function closeInspector(page: Page, tap = false) {
  const close = page.getByRole('button', { name: 'Close inspect' })
  if (await close.isVisible()) await (tap ? close.tap() : close.click())
}
async function openSheet(page: Page, id: (typeof SHEET_IDS)[number]) {
  const direct = page.getByTestId(`open-${id}`)
  if (await direct.isVisible()) {
    if (await direct.getAttribute('aria-expanded') !== 'true') await direct.click()
    return
  }
  await page.getByTestId('header-more').click()
  await page.getByTestId(`menu-${id}`).click()
}

for (const width of [320, 375, 390, 600, 768, 1024, 1280, 1366, 1440, 1920]) {
  test(`${width}px: workspace, panels, native tools and attribution fit`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    await expect(page.locator('.aladin-logo-container')).toBeVisible()
    for (const height of [600, 700, 768, 900]) {
      await page.setViewportSize({ width, height })
      await fits(page, page.locator('.sky-view'))
      await fits(page, page.locator('.hud'))
      await fits(page, page.getByTestId('sky-search'))
      for (const id of SHEET_IDS) {
        await openSheet(page, id)
        await fits(page, page.locator('.fpanel'))
        await hitTarget(page.getByRole('button', { name: 'Close panel' }))
        if (id === 'target') await hitTarget(page.getByRole('button', { name: 'Compare this position' }))
      }
      // The sheet lies over the sky at every width (nothing moves); closed, Aladin's corners are free again.
      await page.getByRole('button', { name: 'Close panel' }).click()
      for (const selector of ['.aladin-logo-container', '.aladin-fullScreen-control', '.aladin-widgets-toolbar']) {
        await fits(page, page.locator(selector))
        await hitTarget(page.locator(selector))
      }
      const bounds = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }))
      expect(bounds.w).toBeLessThanOrEqual(width + 1)
      expect(bounds.h).toBeLessThanOrEqual(height + 1)
    }
    await page.screenshot({ path: info.outputPath(`workspace-${width}.png`) })
  })
}

test('fixture: name search, compare, playback, quality and source metadata stay connected', async ({ page }) => {
  await fixtures(page)
  await page.goto('/')
  await page.getByTestId('sky-search').fill('Polaris')
  const request = page.waitForRequest(r => r.url().endsWith('/api/frames') && r.method() === 'POST')
  await page.getByTestId('sky-search').press('Enter')
  expect((await request).postDataJSON()).toMatchObject({ ra: '37.954542', dec: '89.264111', detector: 6, stack: false })
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  await openSheet(page, 'layers')
  await expect(page.getByLabel('Photographic plate 1950 (POSS-I, STScI DSS) – position check')).toBeDisabled()
  await expect(page.locator('#plate-status')).toHaveText('Needs a star with Gaia DR3 motion (find it by name)')
  // The sheet lies over the page; closed, the player and its table are free again.
  await page.getByRole('button', { name: 'Close panel' }).click()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await page.getByRole('button', { name: 'Next frame', exact: true }).click()
  await expect(page.locator('.stamp')).toContainText('2026-09-10')
  await expect(await openTab(page, 'data')).toContainText('TEST_FIXTURE')
  await expect(page.locator('.stamp')).toContainText('2026-09-10')
  // The compact disclosure keeps the current pair analysis and its difference view.
  await page.locator('.changes > summary').click()
  await expect(page.locator('.changes')).toContainText('1 change ≥ 5σ')
  await page.getByRole('button', { name: 'Show the difference' }).click()
  await expect(page.locator('.change-summary')).toHaveText('1 change ≥ 5σ between A and B: 1 needs verification')
  await expect(page.getByRole('radio', { name: 'Significance (ZOGY)' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('.diff-legend')).toContainText('no change')
  await expect(page.locator('.viewer .meta a').first()).toHaveAttribute('href', 'https://example.test/fixture-0')
})

test('fixture: malformed coordinates surface backend validation and retry', async ({ page }) => {
  await fixtures(page)
  await page.route('**/api/observations?**', route => route.fulfill({ status: 422, json: { detail: 'Invalid right ascension' } }))
  // The backend parses the coordinates for the frames as well (backend/app/coords.py) and rejects them the same way.
  await page.route('**/api/frames', route => route.fulfill({ status: 422, json: { detail: 'Invalid right ascension' } }))
  await page.goto('/')
  await openSheet(page, 'target')
  await page.getByText('Enter precise coordinates', { exact: true }).click()
  await page.getByLabel('Right ascension').fill('invalid')
  await page.getByRole('button', { name: 'Compare this position' }).click()
  await expect(page.getByRole('alert')).toContainText('Invalid right ascension')
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Choose another region' }).click()
  await expect(page.getByLabel('Right ascension')).toHaveValue('invalid')
})

test('fixture: name resolution failure is actionable', async ({ page }) => {
  await fixtures(page)
  await page.route('**/api/resolve?**', route => route.fulfill({ status: 404, json: { detail: 'Unknown target: no-such-object' } }))
  await page.goto('/')
  await page.getByTestId('sky-search').fill('no-such-object')
  await page.getByTestId('sky-search').press('Enter')
  await expect(page.getByRole('alert')).toContainText('Unknown target')
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
})

test('fixture: empty data and incompatible epochs are honest', async ({ page }) => {
  await fixtures(page, { ...manifest, epochs: 1, frames: [frame(0)], differences: [] })
  await page.goto('/?ra=37.954542&dec=89.264111&band=6&fov=0.2&mode=difference')
  // No greyed Difference tab: the difference image's place says why there is none.
  await expect(page.locator('.changes')).toContainText('Difference needs observations from at least two epochs.')
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeDisabled()
  await fixtures(page, { ...manifest, epochs: 0, frames: [], differences: [] })
  await page.reload()
  await expect(page.getByRole('heading', { name: 'No images to compare' })).toBeVisible()
})

test('fixture: the loading bar on the viewer head line counts the fetched images and disappears when loaded', async ({ page }) => {
  await fixtures(page)
  let state: 'queued' | 'started' | 'finished' = 'queued'
  await page.route('**/api/frames**', route => {
    if (new URL(route.request().url()).pathname.endsWith('.png')) return route.fallback()
    return route.fulfill({ json: state === 'finished' ? job()
      : { ...job(), status: state, progress: state === 'started' ? 5 : 0, total: state === 'started' ? 12 : 0, manifest: null } })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/?ra=37.954542&dec=89.264111')
  const head = page.locator('.viewer-head')
  const bar = head.getByRole('progressbar', { name: 'SPHEREx images' })
  await expect(bar).toBeVisible()
  await expect(bar).not.toHaveAttribute('aria-valuenow')
  const line = (await head.boundingBox())!
  const box = (await bar.boundingBox())!
  expect(Math.abs(box.y + box.height - (line.y + line.height))).toBeLessThanOrEqual(1)
  expect(Math.abs(box.width - line.width)).toBeLessThanOrEqual(1)
  await expect(page.locator('.loading-state')).toHaveCount(0)
  // No status box: the one action while it loads stands where Play will be, inside the grey frames.
  await expect(page.locator('.player-skeleton .transport').getByRole('button', { name: 'Stop waiting' })).toBeVisible()
  await expect(page.locator('.comparison-status')).toHaveClass(/sr-only/)
  state = 'started'
  await expect(bar).toHaveAttribute('aria-valuenow', '5')
  await expect(bar).toHaveAttribute('aria-valuetext', '5 of 12 images loaded')
  state = 'finished'
  await expect(bar).toHaveCount(0)
  await expect(page.locator('.comparison-status')).toContainText('2 images ready')
})

test('fixture: Stop waiting ends a slow wait; Retry picks up the images the server kept preparing', async ({ page }) => {
  await fixtures(page)
  let finished = false
  let polls = 0
  await page.route('**/api/frames**', route => {
    if (new URL(route.request().url()).pathname.endsWith('.png')) return route.fallback()
    polls += 1
    return route.fulfill({ json: finished ? job() : { ...job(), status: 'started', progress: 2, total: 12, manifest: null } })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/?ra=37.954542&dec=89.264111')
  await expect(page.locator('.viewer-head').getByRole('progressbar', { name: 'SPHEREx images' })).toBeVisible()
  await page.getByRole('button', { name: 'Stop waiting' }).click()
  // The wait ends here: no bar, no grey frames, no empty-state invitation, one line and the way back.
  await expect(page.locator('.viewer-head').getByRole('progressbar')).toHaveCount(0)
  await expect(page.locator('.player-skeleton')).toHaveCount(0)
  await expect(page.locator('.empty-state')).toHaveCount(0)
  await expect(page.locator('.viewer-body .notice')).toHaveText('Stopped waiting. The server keeps preparing these images: Retry picks them up.')
  const stoppedAt = polls
  await page.waitForTimeout(2000)
  expect(polls).toBe(stoppedAt)
  finished = true
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.locator('.viewer .viewport img').first()).toBeVisible()
  await expect(page.locator('.viewer-body .notice', { hasText: 'Stopped waiting' })).toHaveCount(0)
})

test('fixture: Swipe shows A left and B right of a line that keys and the pointer move; Play returns to Blink', async ({ page }) => {
  await fixtures(page)
  await page.route('**/api/frames**', route => {
    if (new URL(route.request().url()).pathname.endsWith('.png')) return route.fallback()
    return route.fulfill({ json: job() })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/?ra=37.954542&dec=89.264111')
  await expect(page.locator('.viewer .viewport img').first()).toBeVisible()
  await page.getByRole('radio', { name: 'Swipe' }).click()
  const handle = page.getByRole('slider', { name: 'Swipe line: A left, B right' })
  await expect(handle).toHaveAttribute('aria-valuenow', '50')
  await expect(page.locator('.viewer .viewport .stamp')).toHaveCount(2)
  await expect(page.locator('.viewer .player > .notice')).toContainText('Swipe shows A and B only')
  await handle.focus()
  await page.keyboard.press('ArrowRight')
  await expect(handle).toHaveAttribute('aria-valuenow', '55')
  // The arrow moved the line, not the frames: Swipe is still on.
  await expect(page.getByRole('radio', { name: 'Swipe' })).toHaveAttribute('aria-checked', 'true')
  const box = (await page.locator('.viewer .viewport').boundingBox())!
  const grip = (await handle.boundingBox())!
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.2, grip.y + grip.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect(handle).toHaveAttribute('aria-valuenow', '20')
  // At 1× the image under the line is the line: B is cut at 20 % of its width.
  expect(await page.locator('.swipe-b').evaluate((el) => getComputedStyle(el).clipPath)).toMatch(/inset\(0px 0px 0px 20(\.\d+)?%\)/)
  await page.getByRole('button', { name: 'Play' }).click()
  await expect(page.getByRole('radio', { name: 'Blink' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('.swipe-line')).toHaveCount(0)
})

test('keyboard: panel focus, Escape, About panel and reduced motion', async ({ page }) => {
  await fixtures(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.getByTestId('open-layers').click()
  await expect(page.locator('.fpanel-header h2')).toBeFocused()
  await expect(page.locator('.fpanel-header h2')).toHaveText('Sky layers')
  await page.keyboard.press('Escape')
  await expect(page.locator('.fpanel')).toBeHidden()
  await expect(page.getByTestId('open-layers')).toBeFocused()
  await page.getByTestId('open-about').click()
  await expect(page.locator('#about-panel')).toContainText('About Loop the Difference')
  await page.keyboard.press('Escape')
  await expect(page.locator('.fpanel')).toBeHidden()
  await expect(page.getByTestId('open-about')).toBeFocused()
  await page.getByRole('button', { name: 'Examples' }).click()
  await page.locator('.hud-chips').getByRole('button', { name: 'Polaris', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  await page.locator('.player').focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.stamp')).toContainText('2026-09-10')
  await page.keyboard.press('a')
  await expect(page.locator('.stamp')).toContainText('A · 2026-03-10 12:00 UTC')
  await page.keyboard.press('b')
  await expect(page.locator('.stamp')).toContainText('B ·')
  await page.keyboard.press('A')
  await expect(page.locator('.stamp')).toContainText('A · 2026-03-10 12:00 UTC')
})

test('share copies canonical comparison link and embed remains usable', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await fixtures(page)
  await page.goto('/?ra=37.954542&dec=89.264111&band=6&mode=difference')
  await page.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Comparison link copied' })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('mode=difference')
  await page.goto('/?ra=37.954542&dec=89.264111&embed=1')
  await expect(page.locator('.hud')).toHaveCount(0)
  await expect(page.locator('.player')).toBeVisible()
})

test('Export is offered before any comparison and saves the search', async ({ page }) => {
  await fixtures(page)
  await page.goto('/')
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export', exact: true }).click()])
  expect(download.suggestedFilename()).toMatch(/^loop-the-difference-.+-\d{4}-\d{2}-\d{2}\.json$/)
  const file = JSON.parse(await readFile(await download.path(), 'utf8'))
  expect(file).toMatchObject({ format: 'loop-the-difference/export@1', comparison: null, objects: [], query: { band: 6 } })
  await expect(page.getByRole('status').filter({ hasText: 'Exported the search only – no comparison loaded yet' })).toBeVisible()
})

test('a link carries A and B: it opens on them, and the address follows a swap', async ({ page }) => {
  await fixtures(page)
  await page.goto('/?ra=37.954542&dec=89.264111&band=6&a=fixture-1&b=fixture-0')
  await expect(page.locator('.stamp')).toContainText('A · 2026-09-10 12:00 UTC')
  await expect(page).toHaveURL(/a=fixture-1&b=fixture-0/)
  await page.getByRole('button', { name: 'Swap A and B' }).click()
  await expect(page).toHaveURL(/a=fixture-0&b=fixture-1/)
})

test('fixture: image fetch failure offers a working retry', async ({ page }) => {
  await fixtures(page)
  let failed = true
  await page.route('**/api/frames/fixture/frame_0.png*', route => failed
    ? route.fulfill({ status: 503, body: 'Unavailable' })
    : route.fulfill({ contentType: 'image/png', body: transparentPng }))
  await page.goto('/?ra=37.954542&dec=89.264111')
  await expect(page.locator('.image-error')).toContainText('could not load')
  failed = false
  await page.getByRole('button', { name: 'Retry image' }).click()
  await expect(page.locator('.image-error')).toBeHidden()
})

for (const viewport of [{ width: 720, height: 450 }, { width: 360, height: 225 }]) {
  test(`zoom reflow equivalent ${viewport.width}×${viewport.height}: actions remain reachable`, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    await page.goto('/')
    await openSheet(page, 'target')
    await hitTarget(page.getByRole('button', { name: 'Compare this position' }))
    await hitTarget(page.getByRole('button', { name: 'Close panel' }))
    const size = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, v: innerWidth }))
    expect(size.w).toBeLessThanOrEqual(size.v + 1)
    await page.screenshot({ path: info.outputPath('zoom-reflow.png'), fullPage: true })
  })
}

test('touch: pan, locate, compare and dismiss remain usable after rotation', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true })
  const page = await context.newPage()
  await fixtures(page)
  await page.goto('/')
  await expect(page.locator('.aladin-logo-container')).toBeVisible()
  await page.touchscreen.tap(180, 400)
  await page.getByTestId('header-more').tap()
  await page.getByTestId('menu-target').tap()
  await page.locator('#target-panel').getByRole('button', { name: 'Polaris', exact: true }).tap()
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 667, height: 375 })
  await expect(await openTab(page, 'quality', true)).toBeInViewport()
  await closeInspector(page, true)
  await hitTarget(page.getByRole('button', { name: 'Next frame', exact: true }))
  await page.getByTestId('header-more').tap()
  await page.getByTestId('menu-layers').tap()
  await hitTarget(page.getByRole('button', { name: 'Close panel' }))
  await page.getByRole('button', { name: 'Close panel' }).tap()
  await expect(page.locator('.fpanel')).toBeHidden()
  await context.close()
})

test('native Aladin tools remain reachable and open above the sky', async ({ page }, info) => {
  await page.goto('/')
  await page.locator('.aladin-stack-control').click()
  await expect(page.locator('.fpanel')).toBeHidden()
  await expect(page.locator('.aladin-stack-box')).toBeVisible()
  await fits(page, page.locator('.aladin-stack-box'))
  await page.screenshot({ path: info.outputPath('native-layers.png') })
  await page.locator('.aladin-stack-control').click()
  await page.locator('.aladin-settings-control').click()
  await page.screenshot({ path: info.outputPath('native-settings.png') })
  await page.locator('.aladin-settings-control').click()
  await page.locator('.aladin-grid-control').click()
  await page.locator('.aladin-grid-control').click()
  await page.locator('.aladin-simbadPointer-control').click()
  await page.locator('.aladin-simbadPointer-control').click()
  await page.locator('.aladin-share-control').click()
  await page.screenshot({ path: info.outputPath('native-share.png') })
})

test('fixture: backend outage keeps retry and a new detector request usable', async ({ page }) => {
  await fixtures(page)
  let unavailable = true
  await page.route('**/api/frames', route => unavailable
    ? route.fulfill({ status: 503, json: { detail: 'Job queue is not available' } })
    : route.fulfill({ json: job() }))
  await page.goto('/?ra=37.954542&dec=89.264111')
  await expect(page.getByRole('alert')).toContainText('Job queue is not available')
  unavailable = false
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  await openSheet(page, 'target')
  await page.getByLabel('Observation detector').selectOption('3')
  const requested = page.waitForRequest(r => r.url().endsWith('/api/frames') && r.method() === 'POST')
  await page.getByRole('button', { name: 'Compare this position' }).click()
  expect((await requested).postDataJSON().detector).toBe(3)
  await expect(page).toHaveURL(/band=3/)
  await page.reload()
  await expect(page.getByLabel('Search band')).toHaveValue('3')
})

test('map keyboard navigation and using map center connect to the real request contract', async ({ page }) => {
  await fixtures(page)
  await page.goto('/')
  await openSheet(page, 'target')
  await page.getByRole('button', { name: 'Use map center & compare' }).waitFor({ state: 'visible' })
  await expect(page.getByRole('button', { name: 'Use map center & compare' })).toBeEnabled()
  await page.getByRole('button', { name: 'Close panel' }).click()
  const map = page.locator('.sky-stage')
  await map.focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('+')
  await openSheet(page, 'target')
  const requested = page.waitForRequest(r => r.url().endsWith('/api/frames') && r.method() === 'POST')
  await page.getByRole('button', { name: 'Use map center & compare' }).click()
  const body = (await requested).postDataJSON()
  expect(Number(body.dec)).toBeLessThan(89.264111)
  expect(body.detector).toBe(6)
  await expect(page.locator('.player')).toBeVisible()
})

test('fixture: queued jobs poll through the API and preserve chosen search settings', async ({ page }) => {
  await fixtures(page)
  await page.route('**/api/frames', route => route.fulfill({ json: { ...job(), status: 'queued', manifest: null } }))
  await page.goto('/')
  await page.getByLabel('Search band').selectOption('3')
  await page.getByTestId('sky-search').fill('Polaris')
  const posted = page.waitForRequest(r => r.url().endsWith('/api/frames') && r.method() === 'POST')
  const polled = page.waitForRequest('**/api/frames/fixture')
  await page.getByTestId('sky-search').press('Enter')
  expect((await posted).postDataJSON().detector).toBe(3)
  await polled
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
})

test('fixture: without WebGL2, the observation workflow stays available', async ({ page }) => {
  await fixtures(page)
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.getContext = new Proxy(HTMLCanvasElement.prototype.getContext, {
      apply(target, canvas, args) {
        return args[0] === 'webgl2' ? null : Reflect.apply(target, canvas, args)
      },
    })
  })
  await page.goto('/?ra=37.954542&dec=89.264111')
  await expect(page.locator('.sky-stage > .notice')).toContainText('WebGL2')
  await expect(page.locator('.player')).toBeVisible()
  await openSheet(page, 'target')
  await expect(page.getByRole('button', { name: 'Use map center & compare' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Compare this position' })).toBeEnabled()
})

test('fixture: frames on the sky, layers, Gaia motion and spectrum keep their places in the workspace', async ({ page }) => {
  await fixtures(page)
  const motion = { source_id: '576402619921510144', ra: manifest.ra, dec: manifest.dec, ref_epoch: 2016,
    pmra_mas_yr: 44.5, pmdec_mas_yr: -11.9, parallax_mas: 7.3 }
  await page.route('**/api/resolve?**', route => route.fulfill({ json: { name: 'Polaris', ra: manifest.ra, dec: manifest.dec, proper_motion: motion } }))
  await page.route('**/api/spectrum', route => route.fulfill({ status: 404, json: { detail: 'Not Found' } }))
  await page.goto('/')
  await page.getByTestId('sky-search').fill('Polaris')
  await page.getByTestId('sky-search').press('Enter')
  await expect(page).toHaveURL(/name=Polaris/)
  await expect(page.locator('.pair-table th[scope="row"]', { hasText: 'Gaia DR3' })).toHaveAttribute('title', /576402619921510144/)
  await openSheet(page, 'layers')
  const onSky = page.locator('.layers-section').getByLabel('SPHEREx frames on the sky')
  await expect(onSky).toBeChecked()
  await expect(page.locator('.map-caption')).toContainText('SPHEREx frame on the sky · A · 2026-03-10 12:00 UTC · D6')
  await page.getByRole('button', { name: 'Next frame', exact: true }).click()
  await expect(page.locator('.map-caption')).toContainText('2026-09-10')
  await expect(page.locator('.layers-section').getByLabel(/AllWISE/)).toBeEnabled()
  await onSky.uncheck()
  await expect(page.locator('.map-caption')).not.toContainText('SPHEREx frame on the sky')
  const measure = await openTab(page, 'measure')
  await measure.getByRole('button', { name: 'Measure the target in all SPHEREx visits' }).click()
  await expect(measure).toContainText('Could not measure the target: Not Found')
})

test('fixture: a shared link with a name adds the Gaia marker; new coordinates drop the name', async ({ page }) => {
  await fixtures(page)
  const motion = { source_id: '576402619921510144', ra: manifest.ra, dec: manifest.dec, ref_epoch: 2016,
    pmra_mas_yr: 44.5, pmdec_mas_yr: -11.9, parallax_mas: 7.3 }
  await page.route('**/api/resolve?**', route => route.fulfill({ json: { name: 'Polaris', ra: manifest.ra, dec: manifest.dec, proper_motion: motion } }))
  await page.goto('/?ra=37.954542&dec=89.264111&fov=0.2&band=6&name=Polaris')
  await expect(page.locator('.player .marker')).toBeVisible()
  await expect(page.locator('.pair-table th[scope="row"]', { hasText: 'Gaia DR3' })).toHaveAttribute('title', /576402619921510144/)
  await openSheet(page, 'target')
  await page.getByText('Enter precise coordinates', { exact: true }).click()
  await page.getByLabel('Right ascension').fill('37.9')
  await page.getByRole('button', { name: 'Compare this position' }).click()
  await expect(page).toHaveURL(/ra=37\.9&/)
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  expect(page.url()).not.toContain('name=')
  // The A/B table and its "All metadata" table (#86): neither names Gaia DR3 any more.
  await expect(page.locator('.pair-table', { hasText: 'Gaia DR3' })).toHaveCount(0)
  await expect(page.locator('.player .marker')).toHaveCount(0)
})

test('fixture: a frame that cannot load on the sky is never announced as shown', async ({ page }) => {
  await fixtures(page)
  await page.route('**/api/frames/fixture/frame_0.png*', route => route.fulfill({ status: 404, body: 'Not found' }))
  await page.goto('/?ra=37.954542&dec=89.264111')
  await expect(page.locator('.map-caption')).toContainText('SPHEREx frame 1/2 could not load on the sky')
  await expect(page.locator('.map-caption')).not.toContainText('SPHEREx frame on the sky')
  await page.getByRole('button', { name: 'Next frame', exact: true }).click()
  await expect(page.locator('.map-caption')).toContainText('SPHEREx frame on the sky · B · 2026-09-10 12:00 UTC · D6 · 2/2')
})

test('fixture: reduced motion blinks at 1 s and pauses after 20 swaps', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.clock.install()
  await fixtures(page)
  await page.goto('/')
  await page.getByTestId('sky-search').fill('Polaris')
  await page.getByTestId('sky-search').press('Enter')
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await page.clock.runFor(1000)
  await expect(page.locator('.stamp')).toContainText('B ·')
  await page.clock.runFor(19_000)
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  await expect(page.locator('.player')).toContainText('Paused after 20 swaps (reduced motion) – press Play to continue')
})

test('fixture: what the layers show on the sky also stands on the SPHEREx image, and goes with the layer', async ({ page }) => {
  const detected = (index: number) => ({ ...frame(index), sources: [{ ra: manifest.ra + 0.01, dec: manifest.dec - 0.01,
    x: 40, y: 50, peak_mjy_sr: 2, snr: 122, match: 'none' as const, catalog_id: null, separation_arcsec: null,
    catalog_mag: null, catalog_band: null }] })
  await fixtures(page, { ...manifest, frames: [detected(0), detected(1)] })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/?ra=37.954542&dec=89.264111&fov=0.2&band=6')
  const marks = page.locator('.viewer .viewport .image-mark.source-none')
  // "Sources detected in the shown frame" is on by default: its marker stands on the image too.
  await expect(marks).toHaveCount(1)
  await expect(marks.first()).toHaveClass(/source-none/)
  await expect(marks.first().locator('title')).toHaveText(/no catalogue match, needs verification/)
  await openSheet(page, 'layers')
  await page.locator('.layers-section').getByLabel('Sources detected in the shown frame').uncheck()
  await expect(marks).toHaveCount(0)
  await page.locator('.layers-section').getByLabel('Sources detected in the shown frame').check()
  await expect(marks).toHaveCount(1)
})

test('fixture: Mark detected sources in two frames lists candidate marks A and B', async ({ page }, info) => {
  const detected = (index: number) => ({ ...frame(index), sources: [{ ra: manifest.ra + 0.05 * (index + 1), dec: manifest.dec - 0.02,
    x: 40, y: 50, peak_mjy_sr: 2, snr: 122, match: 'none' as const, catalog_id: null, separation_arcsec: null,
    catalog_mag: null, catalog_band: null }] })
  await fixtures(page, { ...manifest, frames: [detected(0), detected(1)] })
  const panel = page.locator('.candidate-check')
  for (const width of [320, 1920]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/?ra=37.954542&dec=89.264111&fov=0.2&band=6')
    // Beside the images (under them on narrow screens), not a tab of the inspector.
    await expect(page.getByTestId('inspect-candidate')).toHaveCount(0)
    await expect(panel).toContainText('Spotted motion? Mark the object in two frames')
    await hitTarget(panel.getByRole('button', { name: 'Mark in this frame' }))
    await page.locator('summary', { hasText: 'Detected sources' }).click()
    await page.getByRole('button', { name: /^Mark source at RA .* in frame 1$/ }).click()
    await expect(panel).toContainText('Now mark it in another frame')
    await page.getByRole('button', { name: 'Next frame', exact: true }).click()
    await page.getByRole('button', { name: /^Mark source at RA .* in frame 2$/ }).click()
    await expect(panel.locator('.candidate-marks li')).toHaveText([/^◎ A · 2026-03-10 12:00 UTC .*\(S\/N 122\)/, /^◎ B · 2026-09-10 12:00 UTC/])
    await expect(panel).toContainText('Unverified candidate – needs verification')
    await panel.getByRole('button', { name: '+ Add object', exact: true }).click()
    await expect(panel.locator('.candidate-marks li')).toHaveCount(0)
    await page.getByRole('button', { name: /^Mark source at RA .* in frame 2$/ }).click()
    await expect(panel.locator('.candidate-marks li')).toHaveCount(1)
    await expect(page.locator('.viewer .candidate-mark')).toHaveCount(3)
    await page.reload()
    await expect(panel.getByRole('button', { name: 'Object 2 · 1/2', exact: true })).toBeVisible()
    await page.locator('summary', { hasText: 'Detected sources' }).click()
    await panel.getByRole('button', { name: 'Object 1 · 2/2', exact: true }).click()
    await expect(panel.locator('.candidate-marks li')).toHaveCount(2)
    await panel.getByRole('button', { name: 'Object 2 · 1/2', exact: true }).click()
    await panel.getByRole('button', { name: 'Clear this object’s marks' }).click()
    await expect(page.locator('.viewer .candidate-mark')).toHaveCount(2)
    await panel.getByRole('button', { name: 'Object 1 · 2/2', exact: true }).click()
    await hitTarget(panel.getByRole('button', { name: 'Clear this object’s marks' }))
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(scroll).toBeLessThanOrEqual(width + 1)
    await page.screenshot({ path: info.outputPath(`candidate-${width}.png`) })
    await panel.getByRole('button', { name: 'Clear this object’s marks' }).click()
    await expect(panel.locator('.candidate-marks li')).toHaveCount(0)
    // Image path (beside and under the images): arming pauses playback; a click in the image marks the frame shown
    // there at that position, drawn on the image as ◎ A. The stamp on the image does not mark.
    await page.getByRole('button', { name: 'Play', exact: true }).click()
    const mark = panel.getByRole('button', { name: 'Mark in this frame' })
    await mark.click()
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
    await expect(page.locator('.viewer .viewport')).toHaveClass(/marking/)
    await page.locator('.viewer .viewport .stamp').click()
    await expect(panel.locator('.candidate-marks li')).toHaveCount(0)
    await page.locator('.viewer .viewport img:visible').click()
    await expect(panel.locator('.candidate-marks li')).toHaveText([/^◎ A · 2026-0\d-10 12:00 UTC · RA .* Dec 89\.26\d+° .* · position as clicked$/])
    await expect(page.locator('.viewer .viewport .candidate-mark')).toHaveText('1A')
    await mark.click()
    await panel.getByRole('button', { name: 'Clear this object’s marks' }).click()
    await expect(page.locator('.viewer .viewport .candidate-mark')).toHaveCount(0)
    await page.getByRole('button', { name: 'Show frame B' }).click()
  }
  // Sky path on the full sky (Explore, "Full map" in the overview bar): armed, a click outside the frame explains
  // itself, one inside marks the shown frame.
  await page.getByRole('button', { name: 'Full map', exact: true }).click()
  await page.getByRole('button', { name: 'Mark a candidate on the sky' }).click()
  const onSky = page.getByRole('group', { name: 'Candidate marking on the sky' })
  const map = (await page.locator('.sky-view').boundingBox())!
  await page.mouse.click(map.x + map.width - 60, map.y + map.height - 60)
  await expect(onSky.getByRole('status')).toHaveText('Click inside the SPHEREx frame (blue outline)')
  await page.mouse.click(map.x + map.width / 2, map.y + map.height / 2)
  await expect(onSky).toContainText('1/2 marks')
  await onSky.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('button', { name: /^Back to images/ }).click()
  await expect(panel.locator('.candidate-marks li')).toHaveText([/^◎ A · 2026-09-10 12:00 UTC/])
  await expect(panel.getByRole('button', { name: 'Mark in this frame' })).toHaveAttribute('aria-pressed', 'false')
})

test('fixture: sharing includes markers and reopens them; Export saves the marks with the frames and the link', async ({ page }) => {
  const detected = (index: number) => ({ ...frame(index), sources: [{ ra: manifest.ra + 0.05 * (index + 1), dec: manifest.dec - 0.02,
    x: 40, y: 50, peak_mjy_sr: 2, snr: 122, match: 'none' as const, catalog_id: null, separation_arcsec: null,
    catalog_mag: null, catalog_band: null }] })
  await fixtures(page, { ...manifest, frames: [detected(0), detected(1)] })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/?ra=37.954542&dec=89.264111&fov=0.2&band=6')
  const panel = page.locator('.candidate-check')
  // A on the detection in frame 1, B clicked in the image of frame 2.
  await page.locator('summary', { hasText: 'Detected sources' }).click()
  await page.getByRole('button', { name: /^Mark source at RA .* in frame 1$/ }).click()
  await page.getByRole('button', { name: 'Next frame', exact: true }).click()
  await panel.getByRole('button', { name: 'Mark in this frame' }).click()
  const image = (await page.locator('.viewer .viewport').boundingBox())!
  await page.mouse.click(image.x + image.width * 0.3, image.y + image.height * 0.4)
  const marks = [/^◎ A · 2026-03-10 12:00 UTC .*\(S\/N 122\)$/, /^◎ B · 2026-09-10 12:00 UTC · .* · position as clicked$/]
  await expect(panel.locator('.candidate-marks li')).toHaveText(marks)
  await panel.getByRole('radio', { name: 'possible artifact' }).check()
  await panel.getByRole('textbox', { name: 'Object name' }).fill('Moving candidate')
  await expect(panel.getByText('Share in the top bar copies a link with your markers included', { exact: false })).toBeVisible()
  // One trigger per action: the export lives in the header only, and holds the marks, the frames and the link back.
  await expect(panel.getByRole('button', { name: /Export/ })).toHaveCount(0)
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export', exact: true }).click()])
  expect(download.suggestedFilename()).toMatch(/^loop-the-difference-.+-\d{4}-\d{2}-\d{2}\.json$/)
  const file = JSON.parse(await readFile(await download.path(), 'utf8'))
  expect(file).toMatchObject({ format: 'loop-the-difference/export@1', query: { band: 6 }, pair: { a: 'fixture-0', b: 'fixture-1' },
    objects: [{ name: 'Moving candidate', verdict: 'possible artifact', verdict_chosen: true,
      marks: [{ letter: 'A', position: 'detection', detection: { snr: 122 }, frame: { obs_id: 'fixture-0', detector: 6, source_url: 'https://example.test/fixture-0' } },
        { letter: 'B', position: 'as clicked', detection: null, frame: { obs_id: 'fixture-1' } }] }] })
  expect(file.comparison.frames).toHaveLength(2)
  expect(file.link).toContain('mark=fixture-0')
  await expect(page.getByRole('status').filter({ hasText: 'Exported 2 frames, 1 object' })).toBeVisible()
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => { (window as Window & { sharedLink?: string }).sharedLink = value },
    } })
  })
  await page.getByRole('button', { name: 'Share', exact: true }).click()
  const sharedLink = await page.evaluate(() => (window as Window & { sharedLink?: string }).sharedLink)
  expect(new URL(sharedLink!).searchParams.getAll('mark')).toHaveLength(2)
  expect(new URL(sharedLink!).searchParams.get('objectname0')).toBe('Moving candidate')
  await page.goto(sharedLink!)
  await expect(panel.getByRole('textbox', { name: 'Object name' })).toHaveValue('Moving candidate')
  await expect(panel.locator('.candidate-marks li')).toHaveText(marks)
  await page.reload()
  await expect(panel.locator('.candidate-marks li')).toHaveText(marks)
  await expect(page.locator('.viewer .viewport .candidate-mark')).toHaveCount(2)
})

test('fixture: the intro runs the logo while the app loads, blinks its planets, opens onto the app, then stays away', async ({ page }, info) => {
  await fixtures(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  // Automated browsers get no intro unless ?intro=1 asks for it.
  await page.goto('/?intro=1')
  const intro = page.locator('#intro')
  await expect(intro).toBeVisible()
  await expect(intro).toHaveClass(/intro--play/)
  await page.waitForTimeout(1400)
  await page.screenshot({ path: info.outputPath('intro-logo.png') })
  await expect(intro).toHaveClass(/intro--open/)
  await expect(intro).toHaveCount(0)
  await expect(page.getByTestId('sky-search')).toBeVisible()
  // A key opens it at once.
  await page.goto('/?intro=1')
  await expect(page.locator('#intro')).toHaveClass(/intro--play/)
  await page.keyboard.press('Escape')
  await expect(page.locator('#intro')).toHaveCount(0, { timeout: 2000 })
  await page.goto('/')
  await expect(page.locator('#intro')).toHaveCount(0)
})

test('fixture: Explore picks a region on the sky, Investigate shows its images, Full map and back keep everything', async ({ page }) => {
  await fixtures(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(page.locator('.viewer')).toBeHidden()
  await expect(page.locator('.aladin-logo-container')).toBeVisible()
  const map = (await page.locator('.sky-view').boundingBox())!
  await expect(async () => {
    await page.mouse.click(map.x + map.width / 2, map.y + map.height / 2)
    await expect(page.getByRole('button', { name: 'Compare here' })).toBeVisible({ timeout: 1000 })
  }).toPass()
  const requested = page.waitForRequest(r => r.url().endsWith('/api/frames') && r.method() === 'POST')
  await page.getByRole('button', { name: 'Compare here' }).click()
  expect((await requested).postDataJSON().detector).toBe(6)
  await expect(page.locator('.viewer')).toBeVisible()
  await expect(page.locator('.sky-area.overview')).toBeVisible()
  await fits(page, page.locator('.sky-area.overview'))
  await page.getByRole('button', { name: 'Next frame', exact: true }).click()
  await expect(await openTab(page, 'quality')).toBeInViewport()
  await page.getByRole('button', { name: 'Full map', exact: true }).click()
  await expect(page.locator('.viewer')).toBeHidden()
  await expect(page.locator('.inspector')).toBeHidden()
  await page.getByRole('button', { name: /^Back to images/ }).click()
  // The workspace keeps its frame and its tab.
  await expect(page.locator('.stamp')).toContainText('2026-09-10')
  await expect(page.locator('#inspect-panel-quality')).toBeInViewport()
  await expect(page.locator('.sky-area.overview')).toBeVisible()
  await page.getByRole('button', { name: 'Minimize' }).click()
  await expect(page.locator('.sky-area.overview .sky-stage')).toBeHidden()
  await openTab(page, 'coverage')
  await expect(page.locator('.observation-timeline')).toBeInViewport()
  const bounds = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }))
  expect(bounds).toEqual({ w: 1440, h: 900 })
})

test('panel width: keyboard and double-click resize within limits and persist per viewport class', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  // Sheets open on demand; the width is kept across a reload.
  await openSheet(page, 'target')
  const handle = page.getByRole('separator', { name: 'Panel width' })
  const width = async () => (await page.locator('.fpanel').boundingBox())!.width
  const start = await width()
  await handle.focus()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  expect(await width()).toBeCloseTo(start + 32, 0)
  await page.reload()
  await openSheet(page, 'target')
  expect(await width()).toBeCloseTo(start + 32, 0)
  await handle.focus()
  for (let i = 0; i < 80; i++) await page.keyboard.press('ArrowLeft')
  expect(await width()).toBeLessThanOrEqual(Math.min(1440 * 0.6, 960) + 1)
  await handle.dblclick()
  expect(await width()).toBeCloseTo(start, 0)
  await page.setViewportSize({ width: 800, height: 900 })
  expect(await width()).toBeCloseTo(400, 0)
})

test('fixture: vertical thumbnails select the large image and its own metadata', async ({ page }, info) => {
  const frames = Array.from({ length: 12 }, (_, i) => ({ ...frame(i),
    date: new Date(Date.UTC(2026, 0, i + 1, 12)).toISOString(), mjd: 61000 + i,
  }))
  await fixtures(page, { ...manifest, frames })
  for (const width of [320,375,390,600,768,1024,1280,1366,1440,1920]) {
    await page.setViewportSize({width,height:900})
    await page.goto('/?ra=37.954542&dec=89.264111')
    const gallery=page.getByRole('region',{name:'Observation images'})
    // A and B stand as a table beside the image (under it on narrow viewers), with the shown frame above it.
    const metadata=page.getByRole('region',{name:'A and B',exact:true})
    await expect(gallery.locator('.observation-card')).toHaveCount(12)
    await expect(gallery).not.toContainText('Coverage')
    await gallery.getByRole('button',{name:/^Show observation 12,/}).click()
    await expect(page.locator('.stamp')).toContainText('2026-01-12')
    await expect(metadata).toContainText('2026-01-12')
    await expect(metadata).toContainText('96 %')
    await gallery.getByRole('button',{name:/^Show observation 11,/}).click()
    await metadata.getByRole('button',{name:'Use as A',exact:true}).click()
    await expect(page.getByRole('combobox',{name:'Frame A'})).toHaveValue('10')
    const last=gallery.getByRole('button',{name:/^Show observation 12,/})
    await last.focus()
    await page.keyboard.press('ArrowUp')
    await expect(page.locator('.stamp')).toContainText('2026-01-11')
    await expect(metadata).toContainText('2026-01-11')
    const image=(await page.locator('.player .viewport').boundingBox())!
    const rail=(await gallery.boundingBox())!
    expect(rail.x+rail.width).toBeLessThanOrEqual(image.x)
    expect(Math.abs(rail.y-image.y)).toBeLessThan(2)
    expect(Math.abs(rail.height-image.height)).toBeLessThan(2)
    expect(rail.width).toBeLessThanOrEqual(90)
    // Beside the image where the viewer is wide enough, under it otherwise.
    const details=(await metadata.boundingBox())!
    expect(details.x>=image.x+image.width-1 || details.y>=image.y+image.height-1).toBe(true)
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1)
    if ([390,1440,1920].includes(width)) await page.screenshot({path:info.outputPath(`image-browser-${width}.png`)})
  }
})

test('fixture: observation history opens beside the comparison and closes without losing the frame', async ({ page }, info) => {
  await fixtures(page)
  await page.goto('/?ra=37.954542&dec=89.264111&band=6')
  await expect(page.locator('.stamp')).toBeVisible()
  await page.getByRole('button', { name: 'Next frame', exact: true }).click()
  const stamp = await page.locator('.stamp').textContent()
  for (const width of [320, 375, 390, 600, 768, 1024, 1280, 1366, 1440, 1920]) {
    for (const height of [600, 700, 768, 900]) {
      await page.setViewportSize({ width, height })
      await openTab(page, 'coverage')
      const trigger = page.getByTestId('inspect-coverage')
      await fits(page, trigger)
      await hitTarget(trigger)
      await expect(page.locator('.observation-timeline')).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
      if (height === 900 && [390, 1440].includes(width)) await page.screenshot({ path: info.outputPath(`history-${width}.png`) })
      await closeInspector(page)
      // Short phones scroll within the images.
      await page.locator('.stamp').scrollIntoViewIfNeeded()
      await expect(page.locator('.stamp')).toBeInViewport()
      await expect(page.locator('.stamp')).toHaveText(stamp!)
      await expect(page.locator('.bottom-bar')).toHaveCount(0)
    }
  }
})

test('fixture: the target, detector and blocked difference are named once', async ({ page }) => {
  await fixtures(page, { ...manifest, epochs: 1, frames: [frame(0)], differences: [] })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/?ra=37.954542&dec=89.264111&band=6&fov=0.2')
  await expect(page.locator('.stamp')).toBeVisible()
  // The search bar names the target and its detector; the viewer head does not repeat them.
  await expect(page.getByTestId('sky-search')).toHaveValue('37.954542, 89.264111')
  await expect(page.getByLabel('Search band')).toHaveValue('6')
  const head = page.locator('.viewer-head')
  await expect(head).not.toContainText('37.954542')
  await expect(head).not.toContainText('D6')
  // A blocked difference: no greyed tab; the difference image's place beside the table says why, once.
  await expect(page.locator('.changes')).toContainText('Difference needs observations from at least two epochs.')
  await expect(head).not.toContainText('Difference needs')
  await expect(head).not.toContainText('unavailable')
  // One way into the observation history; its count stands on the tab, not again in the panel.
  const trigger = page.getByTestId('inspect-coverage')
  await expect(trigger).toContainText('4')
  await trigger.click()
  const summary = page.locator('#inspect-panel-coverage .history-summary')
  await expect(summary).toContainText('2 epochs')
  await expect(summary).toContainText('4 in D6')
  await expect(summary).not.toContainText('observations')
  // The Data tab repeats neither the search bar nor the checks or the coverage.
  const data = await openTab(page, 'data')
  const region = data.locator('.data-section').first()
  await expect(region).toContainText('0.2°')
  await expect(region).not.toContainText('37.954542')
  await expect(data).toContainText('Image preparation')
  await expect(data).not.toContainText('SPHEREx coverage')
  await expect(data.getByRole('region', { name: 'Checks for this view' })).toHaveCount(0)
  // The caveat stands once, with the checks; no permanent line under the images.
  await expect(page.locator('.science-note')).toHaveCount(0)
  await expect(page.locator('#inspect-panel-quality')).toContainText('Changes are candidates')
  expect(await page.evaluate(() => document.body.textContent!.split('Changes are candidates').length - 1)).toBe(1)
})

test('fixture: an unedited search field keeps the comparison position, an edited one is resolved as a name', async ({ page }) => {
  await fixtures(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  await page.locator('.hud-chips').getByRole('button', { name: 'Polaris', exact: true }).click()
  const search = page.getByTestId('sky-search')
  await expect(search).toHaveValue('Polaris')
  await expect(page.locator('.stamp')).toBeVisible()
  // Escape without an open panel leaves the focus where it is.
  await search.focus()
  await page.keyboard.press('Escape')
  await expect(search).toBeFocused()
  await openSheet(page, 'target')
  await page.getByText('Enter precise coordinates', { exact: true }).click()
  await page.getByLabel('Right ascension').fill('10.0')
  const again = page.waitForRequest(r => r.url().endsWith('/api/frames') && r.method() === 'POST')
  await search.press('Enter')
  expect((await again).postDataJSON()).toMatchObject({ ra: '02:31:49.09', dec: '+89:15:50.8' })
  await expect(page.locator('.stamp')).toBeVisible()
  await search.fill('')
  await search.fill('Polaris')
  const resolved = page.waitForRequest(r => r.url().includes('/api/resolve'))
  await search.press('Enter')
  await resolved
  await expect(page).toHaveURL(/name=Polaris/)
})

test('fixture: a failed name search is resolved again on Enter', async ({ page }) => {
  await fixtures(page)
  let attempts = 0
  await page.route('**/api/resolve?**', route => ++attempts === 1
    ? route.fulfill({ status: 404, json: { detail: 'Unknown target: Polaris' } })
    : route.fulfill({ json: { name: 'Polaris', ra: manifest.ra, dec: manifest.dec } }))
  await page.goto('/')
  const search = page.getByTestId('sky-search')
  await search.fill('Polaris')
  await search.press('Enter')
  await expect(page.getByRole('alert')).toContainText('Unknown target')
  await search.press('Enter')
  await expect(page).toHaveURL(/name=Polaris/)
  expect(attempts).toBe(2)
})

test('full map: the search bar floats transparent over the sky, without a name; the Aladin controls sit below it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(page.locator('.aladin-logo-container')).toBeVisible()
  // The name is gone from view; the page keeps it as its one heading for screen readers.
  await expect(page.locator('.hud .brand')).toHaveCount(0)
  await expect(page.locator('.hud h1')).toHaveClass(/sr-only/)
  await expect(page.locator('.hud')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  // The sky starts at the top of the window, under the search bar.
  const sky = (await page.locator('.sky-view').boundingBox())!
  expect(sky.y).toBeLessThanOrEqual(1)
  // Aladin's top controls stand below the bar and take clicks.
  const hud = (await page.locator('.hud').boundingBox())!
  for (const selector of ['.aladin-cooFrame', '.aladin-location', '.aladin-fullScreen-control', '.aladin-widgets-toolbar']) {
    const box = (await page.locator(selector).first().boundingBox())!
    expect(box.y, selector).toBeGreaterThanOrEqual(hud.y + hud.height - 1)
    await hitTarget(page.locator(selector).first())
  }
})

test('fixture: the search bar keeps its parts apart and unclipped, with and without a sheet', async ({ page }) => {
  await fixtures(page)
  await page.goto('/?ra=37.954542&dec=89.264111&band=6&fov=0.2')
  await expect(page.locator('.stamp')).toBeVisible()
  for (const [width, height] of [[1024, 768], [1280, 800], [1440, 900], [1920, 1080]]) {
    await page.setViewportSize({ width, height })
    for (const open of [false, true]) {
      if (open) await openSheet(page, 'layers')
      const parts = await page.locator('.global-search, .examples-toggle, .header-actions').evaluateAll(els => els
        .filter(e => getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0)
        .map(e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, clipped: e.scrollWidth > e.clientWidth + 1 } })
        .sort((a, b) => a.left - b.left))
      for (let i = 1; i < parts.length; i++) expect(parts[i].left, `${width}px, panel ${open}`).toBeGreaterThanOrEqual(parts[i - 1].right - 1)
      expect(parts.some(part => part.clipped), `${width}px, panel ${open}`).toBe(false)
      await page.getByRole('button', { name: 'Examples' }).click()
      const chips = (await page.locator('.hud-chips').boundingBox())!
      expect(chips.x).toBeGreaterThanOrEqual(0)
      await page.getByRole('button', { name: 'Examples' }).click()
      if (open) await page.keyboard.press('Escape')
    }
  }
})

test('fixture: the overview map holds the top-right corner – nothing above it or to its right, a sheet opens beside it', async ({ page }) => {
  await fixtures(page)
  await page.goto('/?ra=37.954542&dec=89.264111&band=6&fov=0.2')
  await expect(page.locator('.stamp')).toBeVisible()
  const map = page.locator('.sky-area.overview')
  for (const [width, height] of [[701, 700], [800, 700], [1024, 768], [1440, 900], [1920, 1080]]) {
    await page.setViewportSize({ width, height })
    for (const open of [false, true]) {
      if (open) await openSheet(page, 'layers')
      await expect(map).toBeVisible()
      const corner = (await map.boundingBox())!
      // Nothing lies over the map: points just inside its four rounded corners hit the map itself.
      const covered = await map.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return [[r.left + 12, r.top + 12], [r.right - 12, r.top + 12], [r.left + 12, r.bottom - 12], [r.right - 12, r.bottom - 12]]
          .filter(([x, y]) => !el.contains(document.elementFromPoint(x, y))).length
      })
      expect(covered, `${width}px, sheet ${open}: map corners covered`).toBe(0)
      // Each control's visible part, cut by the window and the scrolling or clipping boxes around it (a scrolled-away
      // section link or the unfocused skip link is not on screen), stays at or below the map's top and at or left of
      // its right edge.
      const outside = await page.locator('.shell button, .shell input, .shell select, .shell a, .shell summary, .shell h2, .fpanel').evaluateAll((els, m) => els
        .filter(e => !e.closest('.sky-area') && e.getClientRects().length > 0)
        .map(e => {
          const r = e.getBoundingClientRect()
          let [top, right, bottom, left] = [Math.max(r.top, 0), Math.min(r.right, innerWidth), Math.min(r.bottom, innerHeight), Math.max(r.left, 0)]
          for (let a = e.parentElement; a; a = a.parentElement) {
            const style = getComputedStyle(a)
            if (style.display === 'contents' || (style.overflowX === 'visible' && style.overflowY === 'visible')) continue
            const c = a.getBoundingClientRect()
            top = Math.max(top, c.top); right = Math.min(right, c.right); bottom = Math.min(bottom, c.bottom); left = Math.max(left, c.left)
          }
          return { text: (e.textContent ?? '').trim().slice(0, 30), shown: right > left && bottom > top, top, right }
        })
        .filter(({ shown, top, right }) => shown && (top < m.y - 1 || right > m.x + m.width + 1))
        .map(({ text }) => text), corner)
      expect(outside, `${width}px, sheet ${open}`).toEqual([])
      if (open) {
        const sheet = (await page.locator('.fpanel').boundingBox())!
        expect(sheet.x + sheet.width, `${width}px: the sheet opens beside the map, not over it`).toBeLessThanOrEqual(corner.x + 1)
        await page.keyboard.press('Escape')
        await expect(page.locator('.fpanel')).toBeHidden()
      }
    }
  }
  // Examples open from beside the search field; Share stays in the header, left of the map.
  const search = (await page.locator('.global-search').boundingBox())!
  const examples = (await page.getByRole('button', { name: 'Examples' }).boundingBox())!
  expect(examples.x).toBeGreaterThanOrEqual(search.x + search.width - 1)
  await expect(page.locator('.hud').getByRole('button', { name: 'Share', exact: true })).toBeVisible()
})

test('fixture: the overview map expands over the page without moving anything, docks with Escape and minimizes', async ({ page }) => {
  await fixtures(page)
  await page.goto('/?ra=37.954542&dec=89.264111&band=6&fov=0.2')
  await expect(page.locator('.stamp')).toBeVisible()
  const canvas = page.locator('#sky-map')
  const bar = page.locator('.overview-bar')
  const expand = page.getByRole('button', { name: 'Expand', exact: true })
  const box = async (selector: string) => (await page.locator(selector).boundingBox())!
  for (const [width, height] of [[800, 700], [1024, 768], [1440, 900]]) {
    await page.setViewportSize({ width, height })
    // The map takes its width for the new window one render later.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const docked = (await canvas.boundingBox())!
    const frame = await box('.sky-area.overview')
    const viewer = await box('.viewer')
    await expand.click()
    // The expanded map measures the viewer head (its top edge) one render later.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const large = (await canvas.boundingBox())!
    expect(large.width, `${width}px`).toBeGreaterThan(docked.width * 1.5)
    // Nothing moves, the bar keeps the map's corner, and the map starts under the viewer head (mode switch, sections).
    expect(await box('.viewer'), `${width}px`).toEqual(viewer)
    const corner = (await bar.boundingBox())!
    expect([corner.x, corner.y, corner.width], `${width}px`).toEqual([frame.x, frame.y, frame.width])
    const head = await box('.viewer-head')
    expect(large.y, `${width}px`).toBeGreaterThanOrEqual(head.y + head.height)
    await page.getByRole('button', { name: 'Dock', exact: true }).click()
    expect(await canvas.boundingBox(), `${width}px`).toEqual(docked)
  }
  const docked = (await canvas.boundingBox())!
  // A comparison mode does not move the map.
  await page.getByRole('radio', { name: 'Combined images' }).click()
  expect(await canvas.boundingBox()).toEqual(docked)
  // Escape closes the topmost layer first: a header menu, then the expanded map, then a sheet.
  await expand.click()
  await page.getByRole('button', { name: 'Examples' }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.hud-chips')).toBeHidden()
  expect((await canvas.boundingBox())!.width).toBeGreaterThan(docked.width * 1.5)
  await openSheet(page, 'layers')
  await expect(page.locator('.fpanel')).toBeVisible()
  await page.locator('.fpanel-header h2').focus()
  await page.keyboard.press('Escape')
  expect(await canvas.boundingBox()).toEqual(docked)
  await expect(page.locator('.fpanel')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.fpanel')).toBeHidden()
  await page.getByRole('button', { name: 'Minimize', exact: true }).click()
  await expect(canvas).toBeHidden()
  await page.getByRole('button', { name: 'Show map', exact: true }).click()
  expect(await canvas.boundingBox()).toEqual(docked)
  // Phones keep the map under the viewer and have no Expand.
  await page.setViewportSize({ width: 390, height: 800 })
  await expect(expand).toBeHidden()
})

test('fixture: header menus close on Escape or a press outside, open above a sheet and never together', async ({ page }) => {
  await fixtures(page)
  await page.setViewportSize({ width: 800, height: 700 })
  await page.goto('/?ra=37.954542&dec=89.264111&band=6&fov=0.2')
  await expect(page.locator('.stamp')).toBeVisible()
  const examples = page.getByRole('button', { name: 'Examples' })
  const more = page.getByTestId('header-more')
  await examples.click()
  await expect(page.locator('.hud-chips')).toBeVisible()
  await more.click()
  await expect(page.locator('.hud-chips')).toBeHidden()
  await expect(page.locator('.header-more-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.header-more-menu')).toBeHidden()
  // With a sheet open the menu lies above it, switches the sheet, and Escape closes the menu before the sheet.
  await openSheet(page, 'target')
  await more.click()
  await page.getByTestId('menu-layers').click()
  await expect(page.locator('.fpanel-header h2')).toHaveText('Sky layers')
  await more.click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.header-more-menu')).toBeHidden()
  await expect(page.locator('.fpanel')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.fpanel')).toBeHidden()
  await examples.click()
  await page.locator('.viewer .viewport').click()
  await expect(page.locator('.hud-chips')).toBeHidden()
  // Moving the focus away (keyboard) closes it as well.
  await examples.click()
  await page.getByTestId('sky-search').focus()
  await expect(page.locator('.hud-chips')).toBeHidden()
  // Share folds into the menu on a narrow header; the focus goes back to ⋯.
  await more.click()
  await page.getByTestId('menu-share').click()
  await expect(page.locator('.share-feedback')).toBeVisible()
  await expect(more).toBeFocused()
})

test('fixture: an example shown by coordinates keeps its label in the search field and takes a new detector', async ({ page }) => {
  await fixtures(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Examples' }).click()
  await page.getByRole('button', { name: 'Pluto', exact: true }).click()
  const search = page.getByTestId('sky-search')
  await expect(search).toHaveValue('Pluto · known dwarf planet (2026)')
  await expect(page.locator('.stamp')).toBeVisible()
  let resolved = false
  page.on('request', (request) => { if (request.url().includes('/api/resolve')) resolved = true })
  await page.getByLabel('Search band').selectOption('3')
  const requested = page.waitForRequest(r => r.url().endsWith('/api/frames') && r.method() === 'POST')
  await search.press('Enter')
  expect((await requested).postDataJSON()).toMatchObject({ ra: '308.5364', dec: '-22.9153', detector: 3 })
  await expect(search).toHaveValue('Pluto · known dwarf planet (2026)')
  expect(resolved).toBe(false)
})


test('fixture: clear image choices and plain language warnings fit all widths', async ({ page }, info) => {
  await fixtures(page, { ...manifest, checks: [
    { code: 'WAVELENGTH_MISMATCH', severity: 'blocker', message: 'Different wavelengths', detail: 'Test mismatch', affects: ['difference'] },
    { code: 'FLAGGED_PIXELS', severity: 'warning', message: 'Flagged', detail: 'Test flag', affects: ['obs:fixture-0'] },
    { code: 'MIXED_RELEASES', severity: 'info', message: 'Mixed', detail: 'Test releases', affects: [] },
  ] })
  for (const width of [320, 375, 390, 600, 768, 1024, 1280, 1366, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/?ra=37.954542&dec=89.264111&fov=0.2&band=6')
    await hitTarget(page.getByRole('radio', { name: 'Single images', exact: true }))
    await hitTarget(page.getByRole('radio', { name: 'Combined images', exact: true }))
    await page.locator('.player-side').evaluate(el => el.scrollTop = 0)
    const alignment = await page.locator('.pair-panel .pair-col-head').evaluateAll(heads => heads.map(head => ({
      badge: head.querySelector('.pair-letter')!.getBoundingClientRect().top,
      picker: head.querySelector('.pair-pick')!.getBoundingClientRect().top,
    })))
    expect(Math.abs(alignment[0].badge - alignment[1].badge)).toBeLessThanOrEqual(1)
    expect(Math.abs(alignment[0].picker - alignment[1].picker)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: info.outputPath(`images-${width}.png`) })
    const quality = await openTab(page, 'quality')
    await expect(quality).toContainText('Brightness cannot be compared with this pair')
    await hitTarget(quality.getByRole('button', { name: 'Find images in the same light band' }))
    await expect(quality.locator('.check-context').first()).not.toHaveAttribute('open')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
    await page.screenshot({ path: info.outputPath(`checks-${width}.png`) })
    await closeInspector(page)
  }
})


test('fixture: adding objects remains available beyond twenty', async ({ page }) => {
  await fixtures(page)
  await page.goto('/?ra=37.954542&dec=89.264111&fov=0.2&band=6')
  const objects = page.getByRole('group', { name: 'Marked objects', exact: true })
  for (let index = 0; index < 25; index++) await objects.getByRole('button', { name: '+ Add object', exact: true }).click()
  await expect(objects.getByRole('button', { name: /^Object / })).toHaveCount(26)
  await expect(objects.getByRole('button', { name: '+ Add object', exact: true })).toBeEnabled()
})
