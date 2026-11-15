import { test, expect, type Page } from '@playwright/test'

const ra = 269.452077, dec = 4.693365
const target = { ra, dec, name: "Barnard's Star", epoch_jyear: 2000, pm_ra_mas_yr: null, pm_dec_mas_yr: null, source: 'TEST_FIXTURE' }
const frame = (i: number) => ({ id: `frame${i}`, kind: 'single', band: 'D6', visit: i,
  visit_label: `Visit ${i + 1}`, mjd: 61000 + i * 180, mjd_start: 61000 + i * 180, mjd_end: 61000 + i * 180,
  date_utc: i ? '2026-05-20T00:00:00Z' : '2025-11-21T00:00:00Z', lambda_um: 4.7,
  lambda_min_um: 4.69, lambda_max_um: 4.71, bandwidth_um: 0.02, n_exposures: 1,
  obs_ids: [`obs${i}`], source_urls: ['https://example.test/science'], collections: ['TEST_FIXTURE'],
  flags_at_target: [], hard_flag_fraction: 0, coverage: 1, psf_fwhm_arcsec: 7, background_mjy_sr: 0,
  noise_mjy_sr: 1, png_url: `/api/frames/${i}.png`, fits_url: `/api/frames/${i}.fits`, target_px: [16,16] })
const observation = (i: number) => ({ ...frame(i), obs_id: `obs${i}`, detector: 6,
  collection: 'TEST_FIXTURE', lambda_est_um: 4.7, resolving_power: 100, fov_coverage: 1 })
const search = { target, ra_epoch: ra, dec_epoch: dec, epoch_jyear: 2000, fov_arcmin: 12,
  collections: ['TEST_FIXTURE'], observations: [observation(0), observation(1)],
  visits: [0,1].map(i => ({ index:i, label:`Visit ${i+1}`, mjd_start:61000+i*180, mjd_end:61000+i*180, n_observations:1 })),
  checks: [{code:'test',severity:'info',title:'Fixture observation search',detail:'Synthetic UI contract only'}], query_urls: [] }
const sequence = { grid: { ra, dec, npix:32, pixel_arcsec:6.15, fov_arcmin:12,wcs_header:{} },
  band:'D6',mode:'matched',frames:[frame(0),frame(1)],checks:[],failed:[] }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64')
const url = '/?ra=269.452077&dec=4.693365&fov=0.2&band=6&name=Barnard%27s+Star'
async function fixtures(page:Page) {
  await page.route(url => url.pathname.startsWith('/api/') || url.pathname.startsWith('/analysis/api/'), async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('.png')) return route.fulfill({contentType:'image/png',body:png})
    if (path.startsWith('/analysis/')) {
      if (path.endsWith('/observations')) return route.fulfill({json:search})
      if (path.endsWith('/jobs/sequence')) return route.fulfill({json:{id:'seq',state:'done',progress:1,message:'Done',result:sequence,error:null}})
      if (path.endsWith('/difference')) return route.fulfill({json:{id:'diff',frame_a:'frame0',frame_b:'frame1',comparable:true,
        png_url:'/api/frames/diff.png',significance_png_url:'/api/frames/sig.png',checks:[],residuals:[],delta_days:180,delta_lambda_um:0,solar_system:[]}})
      if (path.endsWith('/jobs/spectrum')) return route.fulfill({json:{id:'spectrum',state:'done',progress:1,message:'Done',error:null,
        result:{target_ra:ra,target_dec:dec,aperture_arcsec:12.3,checks:[],points:[{obs_id:'obs0',band:'D6',visit:0,mjd:61000,lambda_um:4.7,flux_mjy:1,flux_err_mjy:0.1,quality:'good',flags:[],source_url:'https://example.test/science'}]}}})
      return route.fulfill({status:503,json:{detail:'Fixture service unavailable'}})
    }
    if (path==='/api/observations') return route.fulfill({json:{collection:'TEST_FIXTURE',ra,dec,count:2,detectors:{'6':2},epochs:[],observations:[]}})
    if (path==='/api/resolve') return route.fulfill({json:target})
    return route.fulfill({json:{job_id:'primary',status:'finished',progress:0,total:0,manifest:null,error:null}})
  })
}
// No sidebar: the analysis parts are tabs of the inspector under the overview map (on phones it opens with Inspect
// under the images); controls open as sheets.
const tabs = ['frame','quality','candidate','measure','coverage','analysis','data']
async function openTab(page:Page, id:string) {
  const toggle=page.locator('.inspect-toggle')
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded')!=='true') await toggle.click()
  await page.getByTestId(`inspect-${id}`).click()
  return page.locator(`#inspect-panel-${id}`)
}
const sheets = ['target','layers','about'] as const
async function openSheet(page:Page, id:(typeof sheets)[number]) {
  const direct=page.getByTestId(`open-${id}`)
  if (await direct.isVisible()) { if (await direct.getAttribute('aria-expanded')!=='true') await direct.click(); return direct }
  const more=page.getByTestId('header-more')
  await more.click()
  await page.getByTestId(`menu-${id}`).click()
  return more
}

test('the inspector opens every tab inside the window and every control sheet opens, at all widths', async ({page},info) => {
  test.setTimeout(240_000)
  await fixtures(page)
  await page.goto(url)
  for (const width of [320,375,390,600,768,1024,1280,1366,1440,1920]) {
    for (const height of [600,900]) {
      await page.setViewportSize({width,height})
      for (const id of tabs) {
        const panel=await openTab(page,id)
        await expect(panel).toBeVisible()
        const tab=page.getByTestId(`inspect-${id}`)
        await expect(tab).toHaveAttribute('aria-selected','true')
        const box=(await tab.boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x+box.width).toBeLessThanOrEqual(width+1)
        expect(box.y).toBeGreaterThanOrEqual(0)
        expect(box.y+box.height).toBeLessThanOrEqual(height+1)
      }
      for (const id of sheets) {
        const trigger=await openSheet(page,id)
        await expect(page.locator('.fpanel')).toBeVisible()
        const close=page.getByRole('button',{name:'Close panel'})
        const box=(await close.boundingBox())!
        expect(box.y).toBeGreaterThanOrEqual(0)
        expect(box.y+box.height).toBeLessThanOrEqual(height+1)
        await close.click()
        await expect(trigger).toBeFocused()
      }
      expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1)
    }
  }
  await page.setViewportSize({width:1440,height:900})
  await page.screenshot({path:info.outputPath('page-desktop.png')})
})

test('additional algorithms use the current target, share their sequence and sit in their tabs',async({page},info)=>{
  await fixtures(page)
  await page.goto(url)
  const aligned=await openTab(page,'analysis')
  const build=aligned.getByRole('button',{name:'Build aligned sequence',exact:true})
  await expect(build).toBeEnabled()
  const request=page.waitForRequest(r=>r.url().endsWith('/analysis/api/jobs/sequence'))
  await build.click()
  expect((await request).postDataJSON()).toMatchObject({ra,dec,band:'D6',fov_arcmin:12,mode:'matched'})
  await expect(aligned.locator('.reference-analysis .blink')).toBeVisible()
  await expect(aligned.locator('.reference-analysis .blink')).toContainText('4.7000')
  // Blink and difference share the sequence, in the same section.
  await aligned.getByRole('button',{name:'Compare A − B',exact:true}).click()
  await expect(page.getByRole('tab',{name:'Significance (σ)'})).toBeVisible()
  await page.getByRole('tab',{name:'Significance (σ)'}).click()
  await expect(page.locator('.diff__main img')).toHaveAttribute('src','/analysis/api/frames/sig.png')
  const coverage=await openTab(page,'coverage')
  // The analysis service's coverage is a second view of the same visits: folded under the history.
  await coverage.locator('summary',{hasText:'Wavelength coverage & other archives'}).click()
  await expect(coverage.getByRole('img',{name:'SPHEREx exposures covering the target: date versus wavelength'})).toBeVisible()
  await expect(coverage.getByRole('button',{name:'Search the CADC archive (2–20 s)'})).toBeVisible()
  await expect(coverage.locator('.reference-analysis')).toContainText('Fixture observation search')
  const measure=await openTab(page,'measure')
  // The aligned aperture spectrum is the second method: folded under the quick-look measurement.
  await measure.locator('summary',{hasText:'Second method: aligned aperture spectrum'}).click()
  await measure.getByRole('button',{name:'Measure spectrum',exact:true}).click()
  await expect(measure.getByRole('img',{name:'SPHEREx spectrum of the target: flux density versus wavelength'})).toBeVisible()
  await page.screenshot({path:info.outputPath('page-analysis-desktop.png')})
  await expect(await openTab(page,'candidate')).toBeInViewport()
  await page.setViewportSize({width:390,height:844})
  await openTab(page,'analysis')
  await expect(page.getByRole('tab',{name:'Significance (σ)'})).toBeVisible()
  await page.screenshot({path:info.outputPath('page-analysis-mobile.png')})
})

test('analysis service error offers retry under Coverage; the other parts wait and the inspector stays usable',async({page})=>{
  await fixtures(page)
  let attempt = 0
  await page.route('**/analysis/api/observations?**',route => {
    attempt++
    if (attempt === 1) return route.fulfill({status:503,json:{detail:'Archive unavailable'}})
    if (attempt === 2) return route.fulfill({json:{...search, observations:[], checks:[{code:'archive_error',severity:'warn',title:'IRSA request failed',detail:'ReadTimeout'}]}})
    return route.fulfill({json:search})
  })
  await page.goto(url)
  const coverage=await openTab(page,'coverage')
  await coverage.locator('summary',{hasText:'Wavelength coverage & other archives'}).click()
  await expect(coverage.locator('.reference-analysis [role=alert]')).toContainText('Archive unavailable')
  await expect(page.locator('#inspect-panel-analysis')).toContainText('needs the archive search, which failed: retry it in the Coverage tab under Wavelength coverage & other archives')
  await coverage.getByRole('button',{name:'Retry observation search'}).click()
  await expect(coverage.locator('.reference-analysis [role=status]')).toContainText('archive search is incomplete')
  await coverage.getByRole('button',{name:'Retry archive search'}).click()
  await expect((await openTab(page,'analysis')).getByRole('button',{name:'Build aligned sequence',exact:true})).toBeEnabled()
  await expect(await openTab(page,'data')).toBeInViewport()
})

test('the analysis searches the exact selected coordinates and draws its graphs at the panel width, wider when expanded', async ({ page }, info) => {
  await fixtures(page)
  const selected = { ...target, ra:269.640817, dec:4.910194, name:null }
  await page.route('**/api/observations?**', route => route.fulfill({json:{collection:'TEST_FIXTURE',ra:selected.ra,dec:selected.dec,count:2,detectors:{'6':2},epochs:[],observations:[]}}))
  await page.route('**/analysis/api/observations?**', route => route.fulfill({json:{...search,target:selected}}))
  await page.setViewportSize({width:1440,height:900})
  await page.goto('/?ra=269.640817&dec=4.910194&fov=0.2&band=6')
  await expect(page.locator('.viewer')).toBeVisible()
  // The archive search starts once its results are asked for: here the folded coverage part, opened.
  const coverage=await openTab(page,'coverage')
  const request = page.waitForRequest('**/analysis/api/observations?**')
  await coverage.locator('summary',{hasText:'Wavelength coverage & other archives'}).click()
  const params = new URL((await request).url()).searchParams
  expect(params.get('ra')).toBe('269.640817')
  expect(params.get('dec')).toBe('4.910194')
  expect(params.get('fov')).toBe('12')
  const graph=coverage.getByRole('img',{name:'SPHEREx exposures covering the target: date versus wavelength'})
  await expect(graph).toBeVisible()
  const panel=(await coverage.boundingBox())!
  expect((await graph.boundingBox())!.width).toBeGreaterThan(panel.width*0.75)
  // Expand gives the graphs the room of the images.
  await page.getByRole('button',{name:'Expand inspector'}).click()
  await expect.poll(async()=>(await graph.boundingBox())!.width).toBeGreaterThan(500)
  await page.screenshot({path:info.outputPath('page-coverage-desktop.png')})
  await page.getByRole('button',{name:'Dock inspector'}).click()
  const measure=await openTab(page,'measure')
  await measure.locator('summary',{hasText:'Second method: aligned aperture spectrum'}).click()
  await measure.getByRole('button',{name:'Measure spectrum',exact:true}).click()
  const spectrum=measure.getByRole('img',{name:'SPHEREx spectrum of the target: flux density versus wavelength'})
  await expect(spectrum).toBeVisible()
  await page.setViewportSize({width:390,height:844})
  await openTab(page,'measure')
  await expect(spectrum).toBeVisible()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(391)
})

test('aligned image browser, expanded, places metadata and vertical thumbnails beside the selected image',async({page},info)=>{
  await fixtures(page)
  await page.setViewportSize({width:1920,height:900})
  await page.goto(url)
  const aligned=await openTab(page,'analysis')
  await page.getByRole('button',{name:'Expand inspector'}).click()
  await aligned.getByRole('button',{name:'Build aligned sequence',exact:true}).click()
  const browser=aligned.locator('.reference-analysis .blink')
  const rail=browser.getByRole('list',{name:'Observation thumbnails'})
  await rail.getByRole('button',{name:/^Show observation 2,/}).click()
  const metadata=browser.getByRole('region',{name:'Selected observation metadata'})
  await expect(metadata).toContainText('2026-05-20T00:00:00Z')
  await expect(metadata).toContainText('frame1')
  await expect(metadata).toContainText('4.7000')
  await expect(metadata.getByRole('link',{name:'Download FITS'})).toHaveAttribute('href','/analysis/api/frames/1.fits')
  await rail.getByRole('button',{name:/^Show observation 2,/}).focus()
  await page.keyboard.press('ArrowUp')
  await expect(metadata).toContainText('frame0')
  await expect(browser.locator('.blink__stage img')).toHaveAttribute('src','/analysis/api/frames/0.png')
  const image=(await browser.locator('.blink__stage').boundingBox())!
  const details=(await metadata.boundingBox())!
  const thumbs=(await browser.locator('.blink__thumbnails').boundingBox())!
  expect(details.x).toBeGreaterThanOrEqual(image.x+image.width)
  expect(thumbs.x+thumbs.width).toBeLessThanOrEqual(image.x)
  expect(Math.abs(thumbs.y-image.y)).toBeLessThan(2)
  expect(Math.abs(thumbs.height-image.height)).toBeLessThan(2)
  expect(details.height).toBeLessThanOrEqual(image.height+1)
  await page.screenshot({path:info.outputPath('aligned-browser-desktop.png')})
  await page.setViewportSize({width:390,height:844})
  await openTab(page,'analysis')
  await expect(metadata).toBeVisible()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(391)
  await page.screenshot({path:info.outputPath('aligned-browser-mobile.png')})
})
