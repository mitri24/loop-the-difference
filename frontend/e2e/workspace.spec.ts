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
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
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

for (const width of [320, 375, 390, 600, 768, 1024, 1280, 1366, 1440, 1920]) {
  test(`${width}px: workspace, panels, native tools and attribution fit`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    await expect(page.locator('.aladin-logo-container')).toBeVisible()
    for (const height of [600, 700, 768, 900]) {
      await page.setViewportSize({ width, height })
      await fits(page, page.locator('.sky-view'))
      await fits(page, page.locator('.app-bar'))
      await fits(page, page.getByTestId('sky-search'))
      for (const id of ['locate', 'compare', 'details']) {
        const trigger = page.getByTestId(`${id}-trigger`)
        if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
        await fits(page, page.locator('.workspace-sheet'))
        await hitTarget(page.getByRole('button', { name: 'Close panel' }))
        if (id === 'locate') await hitTarget(page.getByRole('button', { name: 'Compare this position' }))
      }
      // On narrow screens the sidebar is a dismissible drawer over the map.
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
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await page.getByRole('button', { name: 'Next frame', exact: true }).click()
  await expect(page.locator('.stamp')).toHaveText('2026-09-10')
  await page.getByTestId('details-trigger').click()
  await expect(page.locator('#details-panel')).toContainText('TEST_FIXTURE')
  await page.getByTestId('compare-trigger').click()
  await expect(page.locator('.stamp')).toHaveText('2026-09-10')
  await page.getByRole('radio', { name: 'Difference', exact: true }).click()
  await expect(page.getByLabel('Epoch A (earlier)')).toBeVisible()
  await expect(page.getByLabel('Epoch B (later)')).toBeVisible()
  await expect(page.locator('.diff-legend')).toContainText('no change')
  await expect(page.locator('#compare-panel .meta a').first()).toHaveAttribute('href', 'https://example.test/fixture-0')
})

test('fixture: malformed coordinates surface backend validation and retry', async ({ page }) => {
  await fixtures(page)
  await page.route('**/api/observations?**', route => route.fulfill({ status: 422, json: { detail: 'Invalid right ascension' } }))
  await page.goto('/')
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
  await expect(page.locator('#compare-panel')).toContainText('At least two epochs are needed.')
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeDisabled()
  await fixtures(page, { ...manifest, epochs: 0, frames: [], differences: [] })
  await page.reload()
  await expect(page.getByRole('heading', { name: 'No images to compare' })).toBeVisible()
})

test('fixture: cancellation stops polling and a new request recovers', async ({ page }) => {
  await fixtures(page)
  await page.route('**/api/frames', route => route.fulfill({ json: { ...job(), status: 'queued', manifest: null } }))
  await page.goto('/?ra=37.954542&dec=89.264111')
  await expect(page.getByRole('button', { name: 'Stop waiting' })).toBeVisible()
  await page.getByRole('button', { name: 'Stop waiting' }).click()
  await expect(page.locator('.comparison-status')).toContainText('Stopped waiting')
  await expect(page.getByRole('button', { name: 'Stop waiting' })).toBeHidden()
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop waiting' })).toBeVisible()
})

test('keyboard: panel focus, Escape, About dialog and reduced motion', async ({ page }) => {
  await fixtures(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.getByTestId('compare-trigger').click()
  await expect(page.locator('.sheet-header h2')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('.workspace-sheet')).toBeHidden()
  await expect(page.getByTestId('compare-trigger')).toBeFocused()
  await page.getByRole('button', { name: 'About', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
  await page.getByTestId('locate-trigger').click()
  await page.getByRole('button', { name: 'Polaris', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  await page.locator('.player').focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.stamp')).toHaveText('2026-09-10')
})

test('share copies canonical comparison link and embed remains usable', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await fixtures(page)
  await page.goto('/?ra=37.954542&dec=89.264111&band=6&mode=difference')
  await page.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Comparison link copied' })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('mode=difference')
  await page.goto('/?ra=37.954542&dec=89.264111&embed=1')
  await expect(page.locator('.app-bar')).toHaveCount(0)
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
  await page.getByRole('button', { name: 'Close panel' }).tap()
  await page.touchscreen.tap(180, 400)
  await page.getByTestId('locate-trigger').tap()
  await page.getByRole('button', { name: 'Polaris', exact: true }).tap()
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 667, height: 375 })
  await hitTarget(page.getByRole('button', { name: 'Close panel' }))
  await page.getByRole('button', { name: 'Close panel' }).tap()
  await expect(page.locator('.workspace-sheet')).toBeHidden()
  await context.close()
})

test('native Aladin tools remain reachable and open above the sky', async ({ page }, info) => {
  await page.goto('/')
  await page.locator('.aladin-stack-control').click()
  await expect(page.locator('.workspace-sheet')).toBeHidden()
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
  await page.getByTestId('locate-trigger').click()
  await page.getByLabel('Observation detector').selectOption('3')
  const requested = page.waitForRequest(r => r.url().endsWith('/api/frames') && r.method() === 'POST')
  await page.getByRole('button', { name: 'Compare this position' }).click()
  expect((await requested).postDataJSON().detector).toBe(3)
  await expect(page).toHaveURL(/band=3/)
  await page.reload()
  await expect(page.locator('.target-summary')).toContainText('D3')
})

test('map keyboard navigation and using map center connect to the real request contract', async ({ page }) => {
  await fixtures(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Use map center & compare' }).waitFor({ state: 'visible' })
  await expect(page.getByRole('button', { name: 'Use map center & compare' })).toBeEnabled()
  await page.getByRole('button', { name: 'Close panel' }).click()
  const map = page.locator('.sky-stage')
  await map.focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('+')
  await page.getByTestId('locate-trigger').click()
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
  await page.getByTestId('locate-trigger').click()
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
  await expect(page.locator('#compare-panel .meta')).toContainText('576402619921510144')
  const onSky = page.locator('.layers-section').getByLabel('SPHEREx frames on the sky')
  await expect(onSky).toBeChecked()
  await expect(page.locator('.map-caption')).toContainText('SPHEREx frame on the sky · 2026-03-10 · D6')
  await page.getByRole('button', { name: 'Next frame', exact: true }).click()
  await expect(page.locator('.map-caption')).toContainText('2026-09-10')
  await expect(page.locator('.layers-section').getByLabel(/AllWISE/)).toBeEnabled()
  await onSky.uncheck()
  await expect(page.locator('.map-caption')).not.toContainText('SPHEREx frame on the sky')
  await page.getByTestId('details-trigger').click()
  await page.getByRole('button', { name: 'Build quick-look spectrum from all SPHEREx visits' }).click()
  await expect(page.locator('#details-panel .spectrum-section')).toContainText('Could not build the spectrum: Not Found')
})
