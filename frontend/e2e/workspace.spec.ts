import { test, expect, type Page, type Locator } from '@playwright/test'
import type { FrameJob, FrameManifest, ObservationSummary } from '../src/types'

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
const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64')
async function fixtures(page: Page, data = manifest) {
  await page.route(url => url.pathname.startsWith('/api/') || url.pathname.startsWith('/analysis/api/'), async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.startsWith('/analysis/')) return route.fulfill({ json: { target: {ra: manifest.ra, dec: manifest.dec}, observations: [], visits: [], checks: [], query_urls: [], fov_arcmin: 12 } })
    if (url.pathname.endsWith('.png')) return route.fulfill({ contentType: 'image/png', body: transparentPng })
    if (url.pathname === '/api/resolve') return route.fulfill({ json: { name: 'Polaris', ra: manifest.ra, dec: manifest.dec } })
    if (url.pathname === '/api/observations') return route.fulfill({ json: summary })
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
// headers); the information is on the investigate page, reached through the section bar.
const SHEET_IDS = ['target', 'layers', 'about'] as const
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
      // Below 1024 px the panel lies over the sky; beside it on desktops, Aladin keeps its corners.
      if (width < 1024) await page.getByRole('button', { name: 'Close panel' }).click()
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
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await page.getByRole('button', { name: 'Next frame', exact: true }).click()
  await expect(page.locator('.stamp')).toContainText('2026-09-10')
  await page.getByTestId('section-data').click()
  await expect(page.locator('#data')).toContainText('TEST_FIXTURE')
  await expect(page.locator('.stamp')).toContainText('2026-09-10')
  await page.getByRole('radio', { name: 'Difference', exact: true }).click()
  await expect(page.getByLabel('Epoch A (earlier)')).toBeVisible()
  await expect(page.getByLabel('Epoch B (later)')).toBeVisible()
  await expect(page.locator('.diff-legend')).toContainText('no change')
  await expect(page.locator('.viewer .meta a').first()).toHaveAttribute('href', 'https://example.test/fixture-0')
})

test('fixture: malformed coordinates surface backend validation and retry', async ({ page }) => {
  await fixtures(page)
  await page.route('**/api/observations?**', route => route.fulfill({ status: 422, json: { detail: 'Invalid right ascension' } }))
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
  await expect(page.getByRole('radio', { name: 'Difference' })).toBeDisabled()
  await expect(page.locator('.viewer')).toContainText('At least two epochs are needed.')
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
  await expect(page.getByRole('button', { name: 'Stop waiting' })).toHaveCount(0)
  await expect(page.locator('.comparison-status')).toHaveClass(/sr-only/)
  state = 'started'
  await expect(bar).toHaveAttribute('aria-valuenow', '5')
  await expect(bar).toHaveAttribute('aria-valuetext', '5 of 12 images loaded')
  state = 'finished'
  await expect(bar).toHaveCount(0)
  await expect(page.locator('.comparison-status')).toContainText('2 images ready')
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
  await page.getByRole('button', { name: 'Step through all', exact: true }).click()
  await expect(page.locator('.stamp')).not.toContainText('B ·')
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
  await page.getByTestId('section-candidate').tap()
  await expect(page.locator('#candidate')).toBeInViewport()
  await page.getByTestId('section-images').tap()
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
  await page.getByLabel('Observation detector').selectOption('3')
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
  await expect(page.locator('.viewer .meta')).toContainText('576402619921510144')
  await openSheet(page, 'layers')
  const onSky = page.locator('.layers-section').getByLabel('SPHEREx frames on the sky')
  await expect(onSky).toBeChecked()
  await expect(page.locator('.map-caption')).toContainText('SPHEREx frame on the sky · A · 2026-03-10 12:00 UTC · D6')
  await page.getByRole('button', { name: 'Next frame', exact: true }).click()
  await expect(page.locator('.map-caption')).toContainText('2026-09-10')
  await expect(page.locator('.layers-section').getByLabel(/AllWISE/)).toBeEnabled()
  await onSky.uncheck()
  await expect(page.locator('.map-caption')).not.toContainText('SPHEREx frame on the sky')
  await page.getByTestId('section-measure').click()
  await page.getByRole('button', { name: 'Build quick-look spectrum from all SPHEREx visits' }).click()
  await expect(page.locator('#measure')).toContainText('Could not build the spectrum: Not Found')
})

test('fixture: a shared link with a name adds the Gaia marker; new coordinates drop the name', async ({ page }) => {
  await fixtures(page)
  const motion = { source_id: '576402619921510144', ra: manifest.ra, dec: manifest.dec, ref_epoch: 2016,
    pmra_mas_yr: 44.5, pmdec_mas_yr: -11.9, parallax_mas: 7.3 }
  await page.route('**/api/resolve?**', route => route.fulfill({ json: { name: 'Polaris', ra: manifest.ra, dec: manifest.dec, proper_motion: motion } }))
  await page.goto('/?ra=37.954542&dec=89.264111&fov=0.2&band=6&name=Polaris')
  await expect(page.locator('.player .marker')).toBeVisible()
  await expect(page.locator('.viewer .meta')).toContainText('576402619921510144')
  await openSheet(page, 'target')
  await page.getByText('Enter precise coordinates', { exact: true }).click()
  await page.getByLabel('Right ascension').fill('37.9')
  await page.getByRole('button', { name: 'Compare this position' }).click()
  await expect(page).toHaveURL(/ra=37\.9&/)
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  expect(page.url()).not.toContain('name=')
  await expect(page.locator('.viewer .meta')).not.toContainText('Gaia DR3')
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

test('fixture: Mark detected sources in two frames lists candidate marks A and B', async ({ page }, info) => {
  const detected = (index: number) => ({ ...frame(index), sources: [{ ra: manifest.ra + 0.05 * (index + 1), dec: manifest.dec - 0.02,
    x: 40, y: 50, peak_mjy_sr: 2, snr: 122, match: 'none' as const, catalog_id: null, separation_arcsec: null,
    catalog_mag: null, catalog_band: null }] })
  await fixtures(page, { ...manifest, frames: [detected(0), detected(1)] })
  const panel = page.locator('.candidate-check')
  for (const width of [320, 1920]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/?ra=37.954542&dec=89.264111&fov=0.2&band=6')
    await page.getByTestId('section-candidate').click()
    await expect(panel).toContainText('Spotted motion? Mark the object in two frames')
    await hitTarget(panel.getByRole('button', { name: 'Mark in this frame' }))
    await page.locator('summary', { hasText: 'Detected sources' }).click()
    await page.getByRole('button', { name: /^Mark source at RA .* in frame 1$/ }).click()
    await expect(panel).toContainText('Now mark it in another frame')
    await page.getByRole('button', { name: 'Next frame', exact: true }).click()
    await page.getByRole('button', { name: /^Mark source at RA .* in frame 2$/ }).click()
    await expect(panel.locator('.candidate-marks li')).toHaveText([/^◎ A · 2026-03-10 12:00 UTC .*\(S\/N 122\)/, /^◎ B · 2026-09-10 12:00 UTC/])
    await expect(panel).toContainText('Unverified candidate – needs verification')
    await hitTarget(panel.getByRole('button', { name: 'Clear marks' }))
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(scroll).toBeLessThanOrEqual(width + 1)
    await page.screenshot({ path: info.outputPath(`candidate-${width}.png`) })
    await panel.getByRole('button', { name: 'Clear marks' }).click()
    await expect(panel.locator('.candidate-marks li')).toHaveCount(0)
  }
  // Sky path on the full sky (Explore): armed, a click outside the frame explains itself, one inside marks the shown frame.
  await page.getByRole('button', { name: 'Back to sky' }).click()
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

test('fixture: Explore picks a region on the sky, Investigate shows its images, Back to sky keeps everything', async ({ page }) => {
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
  await page.getByTestId('section-checks').click()
  await expect(page.locator('#checks')).toBeInViewport()
  await page.getByRole('button', { name: 'Back to sky' }).click()
  await expect(page.locator('.viewer')).toBeHidden()
  await page.getByRole('button', { name: /^Back to images/ }).click()
  // The page keeps its frame and its place.
  await expect(page.locator('.stamp')).toContainText('2026-09-10')
  await expect(page.locator('#checks')).toBeInViewport()
  await expect(page.locator('.sky-area.overview')).toBeVisible()
  await page.getByRole('button', { name: 'Hide map' }).click()
  await expect(page.locator('.sky-area.overview .sky-stage')).toBeHidden()
  await page.getByTestId('section-coverage').click()
  await expect(page.locator('.observation-timeline')).toBeInViewport()
  const bounds = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }))
  expect(bounds).toEqual({ w: 1440, h: 900 })
})

test('panel width: keyboard and double-click resize within limits and persist per viewport class', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  const handle = page.getByRole('separator', { name: 'Panel width' })
  const width = async () => (await page.locator('.fpanel').boundingBox())!.width
  const start = await width()
  await handle.focus()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  expect(await width()).toBeCloseTo(start + 32, 0)
  await page.reload()
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
    const metadata=page.getByRole('region',{name:'Shown frame'})
    await expect(gallery.locator('.observation-card')).toHaveCount(12)
    await expect(gallery).not.toContainText('Coverage')
    await gallery.getByRole('button',{name:/^Show observation 12,/}).click()
    await expect(page.locator('.stamp')).toContainText('2026-01-12')
    await expect(metadata).toContainText('2026-01-12')
    await expect(metadata).toContainText('96 %')
    await gallery.getByRole('button',{name:/^Show observation 11,/}).click()
    await metadata.getByRole('button',{name:'Set A',exact:true}).click()
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
    const player=(await page.locator('.observation-player').boundingBox())!
    if(player.width>=850) {
      const details=(await metadata.boundingBox())!
      expect(details.x).toBeGreaterThanOrEqual(image.x+image.width)
      expect(details.height).toBeLessThanOrEqual(image.height+1)
    }
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
      const trigger = page.getByTestId('section-coverage')
      await fits(page, trigger)
      await hitTarget(trigger)
      await trigger.click()
      await expect(page.locator('.observation-timeline')).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
      if (height === 900 && [390, 1440].includes(width)) await page.screenshot({ path: info.outputPath(`history-${width}.png`) })
      await page.getByTestId('section-images').click()
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
  // A blocked difference: the greyed tab and its reason, without "Difference unavailable" again.
  await expect(page.getByRole('radio', { name: 'Difference' })).toBeDisabled()
  await expect(head).toContainText('At least two epochs are needed.')
  await expect(head).not.toContainText('unavailable')
  // One way into the observation history; its count stands on the section bar, not again in the section.
  const trigger = page.getByTestId('section-coverage')
  await expect(trigger).toContainText('4')
  await trigger.click()
  const summary = page.locator('#coverage .history-summary')
  await expect(summary).toContainText('2 epochs')
  await expect(summary).toContainText('4 in D6')
  await expect(summary).not.toContainText('observations')
  // The Data section repeats neither the search bar nor the checks or the coverage.
  await page.getByTestId('section-data').click()
  const region = page.locator('#data .data-section').first()
  await expect(region).toContainText('0.2°')
  await expect(region).not.toContainText('37.954542')
  await expect(page.locator('#data')).toContainText('Image preparation')
  await expect(page.locator('#data')).not.toContainText('SPHEREx coverage')
  await expect(page.locator('#data').getByRole('region', { name: 'Checks for this view' })).toHaveCount(0)
  // The science note stands once, under the images.
  await expect(page.locator('.science-note')).toHaveCount(1)
  await expect(page.locator('#images .science-note')).toHaveCount(1)
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

test('fixture: a panel narrows the search bar without overlapping or clipping its neighbours', async ({ page }) => {
  await fixtures(page)
  await page.goto('/?ra=37.954542&dec=89.264111&band=6&fov=0.2')
  await expect(page.locator('.stamp')).toBeVisible()
  for (const [width, height] of [[1024, 768], [1280, 800], [1440, 900], [1920, 1080]]) {
    await page.setViewportSize({ width, height })
    for (const open of [false, true]) {
      if (open) await openSheet(page, 'layers')
      const parts = await page.locator('.brand, .global-search, .examples-toggle, .share-button').evaluateAll(els => els
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
