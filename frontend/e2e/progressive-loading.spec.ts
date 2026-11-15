import { expect, test } from '@playwright/test'
import type { FrameJob, FrameManifest } from '../src/types'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64')
const frames = Array.from({ length: 12 }, (_, index) => ({
  index, url: `/api/frames/fixture/frame_${index}.png`, obs_id: `test-${index}`,
  date: `2026-${String(index + 1).padStart(2, '0')}-01T00:00:00Z`, mjd: 61000 + index * 60,
  detector: 6, wavelength_min_um: 4.4, wavelength_max_um: 5, coverage: 1,
  source_url: `https://example.test/${index}`, epoch: index, n_combined: 1,
  date_end: null, wavelength_um: 4.7, bandwidth_um: 0.03, masked_fraction: 0,
}))
const final: FrameManifest = {
  collection: 'TEST_FIXTURE', ra: 269.64, dec: 4.91, size_deg: 0.2, detector: 6,
  pixel_scale_arcsec: 6.15, epochs: 12, complete: true, stacked: false,
  frames, checks: [], warnings: [], differences: [],
}

test('preview is usable before metadata and final data; inactive full-size frames stay unmounted', async ({ page }) => {
  let finish = false
  let releaseSummary!: () => void
  const summaryReady = new Promise<void>((resolve) => { releaseSummary = resolve })
  const preview = { ...final, preview: true, complete: false, epochs: 2,
    frames: frames.slice(0, 2).map((f) => ({ ...f, url: f.url.replace('frame_', 'preview_002_frame_') })) }
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('.png')) return route.fulfill({ contentType: 'image/png', body: png })
    if (path === '/api/observations') {
      await summaryReady
      return route.fulfill({ json: { collection: 'TEST_FIXTURE', ra: final.ra, dec: final.dec,
        count: 12, detectors: { '6': 12 }, epochs: [], observations: [] } })
    }
    if (path === '/api/frames' || path === '/api/frames/fixture') {
      const job: FrameJob = { job_id: 'fixture', status: finish ? 'finished' : 'started',
        progress: finish ? 12 : 2, total: 12, manifest: finish ? final : preview, error: null }
      return route.fulfill({ json: job })
    }
    return route.fulfill({ json: { epochs: [] } })
  })
  await page.setViewportSize({ width: 1280, height: 600 })
  await page.goto('/?ra=269.64&dec=4.91&fov=0.2&band=6')
  await expect(page.locator('.comparison-status')).toContainText('Preview')
  await expect(page.locator('.viewport img:visible')).toHaveAttribute('src', /preview_002/)
  await page.getByRole('button', { name: 'Next frame', exact: true }).click()
  await expect(page.locator('.controls .muted').first()).toHaveText('2/2')
  finish = true
  await expect(page.locator('.comparison-status')).toContainText('12 images ready', { timeout: 10_000 })
  await expect(page.locator('.viewport img')).toHaveCount(2)
  await expect(page.locator('.viewport img:visible')).toHaveAttribute('src', /\/frame_0.png$/)
  await expect(page.locator('.loading-state')).toHaveCount(0)
  expect(await page.locator('.observation-gallery img[src]').count()).toBeLessThan(12)
  await page.getByRole('button', { name: 'Next frame', exact: true }).click()
  await expect(page.locator('.viewport img:visible')).toHaveAttribute('src', /\/frame_11.png$/)
  await expect(page.locator('.viewport img')).toHaveCount(2)
  releaseSummary()
})
