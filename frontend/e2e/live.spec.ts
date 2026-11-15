import { test, expect } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

test.describe('Live services (no mocked API responses)', () => {

  test('real proxy, queue, coordinate validation and name resolution', async ({ request }, info) => {
    test.setTimeout(180_000)
    const health = await request.get('/api/health')
    expect(health.ok()).toBe(true)
    const status = await health.json()
    expect(status.redis).toBe('ok')
    const invalid = await request.get('/api/observations?ra=invalid&dec=89')
    expect(invalid.status()).toBe(422)
    const resolved = await request.get('/api/resolve?name=Polaris', { timeout: 125_000 })
    expect(resolved.ok()).toBe(true)
    const position = await resolved.json()
    expect(position.ra).toBeGreaterThan(0)
    expect(position.dec).toBeGreaterThan(89)
    const evidence = JSON.stringify({ health: status, position, invalid: await invalid.json() }, null, 2)
    await writeFile(info.outputPath('live-api.json'), evidence)
    await info.attach('live-api.json', { body: evidence, contentType: 'application/json' })
  })

  test('real SPHEREx comparison, rendered images, native map tools and source links', async ({ page }, info) => {
    test.setTimeout(240_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    const manifests: unknown[] = []
    page.on('response', async response => {
      if (/\/api\/frames(?:\/[^/]+)?$/.test(new URL(response.url()).pathname) && response.ok()) {
        try { const body = await response.json(); if (body.manifest) manifests.push(body.manifest) } catch { /* aborted request */ }
      }
    })
    await page.goto('/?ra=02%3A31%3A49.09&dec=%2B89%3A15%3A50.8&fov=0.2&band=6&mode=difference')
    await expect(page.locator('.aladin-logo-container')).toBeVisible()
    await expect(page.locator('.viewer .comparison-status')).toContainText(/images ready|No usable|Could not load/, { timeout: 210_000 })
    await info.attach('real-manifests.json', { body: JSON.stringify(manifests, null, 2), contentType: 'application/json' })
    await writeFile(info.outputPath('real-manifests.json'), JSON.stringify(manifests, null, 2))
    await expect(page.locator('.viewer [role="alert"]')).toHaveCount(0)
    await expect(page.locator('.viewer .viewport img').first()).toBeVisible()
    await expect.poll(() => page.locator('.viewer .viewport img').first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(1)
    await expect(page.locator('.layer-caption')).not.toContainText('loading', { timeout: 15_000 })
    await page.screenshot({ path: info.outputPath('live-difference-desktop.png') })
    await page.getByRole('radio', { name: 'Stacks', exact: true }).click()
    await page.getByRole('button', { name: 'Play', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await page.getByRole('button', { name: 'Next frame', exact: true }).click()
    // A's and B's provenance stands in the table beside the image.
    await expect(page.locator('.pair-table a').first()).toHaveAttribute('href', /https:\/\//)
    await page.getByTestId('inspect-data').click()
    await expect(page.locator('#inspect-panel-data')).toContainText('spherex_dr1')
    await page.screenshot({ path: info.outputPath('live-data-desktop.png') })
    await page.locator('.aladin-fullScreen-control').click()
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)
    await page.evaluate(() => document.exitFullscreen())
    await page.setViewportSize({ width: 390, height: 844 })
    // The candidate check follows under the images on phones.
    await page.locator('.candidate-side').scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('live-comparison-mobile.png') })
    await info.attach('native-controls.json', { body: JSON.stringify(await page.locator('.aladin-widgets-toolbar').evaluate(el => [...el.querySelectorAll('*')].map(e => ({ tag: e.tagName, cls: e.className, title: e.getAttribute('title'), text: e.textContent })).filter(e => e.tag === 'BUTTON' || e.title)), null, 2), contentType: 'application/json' })
  })
})
