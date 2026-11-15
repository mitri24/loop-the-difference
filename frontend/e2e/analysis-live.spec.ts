import { test, expect } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

test('live imported pipeline: Barnard target, matched sequence, frames and difference',async({request},info)=>{
  test.skip(process.env.SKYSHIFT_ANALYSIS_LIVE !== '1','Explicit opt-in: downloads real IRSA observations')
  test.setTimeout(480_000)
  const root='/analysis/api'
  const health=await request.get(`${root}/health`,{timeout:60_000})
  expect(health.ok()).toBe(true)
  const resolved=await request.get(`${root}/resolve?name=Barnard%27s%20Star`,{timeout:60_000})
  expect(resolved.ok()).toBe(true)
  const target=await resolved.json()
  const metadata=await request.get(`${root}/observations?ra=${target.ra}&dec=${target.dec}&fov=12&epoch=${target.epoch_jyear}&pm_ra=${target.pm_ra_mas_yr}&pm_dec=${target.pm_dec_mas_yr}`,{timeout:180_000})
  expect(metadata.ok()).toBe(true)
  const observations=await metadata.json()
  expect(observations.observations.length).toBeGreaterThan(0)
  const started=await request.post(`${root}/jobs/sequence`,{data:{ra:target.ra,dec:target.dec,name:target.name,
    pm_ra_mas_yr:target.pm_ra_mas_yr,pm_dec_mas_yr:target.pm_dec_mas_yr,target_epoch_jyear:target.epoch_jyear,
    band:'D6',fov_arcmin:12,mode:'matched'}})
  expect(started.ok()).toBe(true)
  let job=await started.json()
  await expect.poll(async()=>{
    const response=await request.get(`${root}/jobs/${job.id}`)
    job=await response.json()
    return job.state
  },{timeout:180_000,intervals:[1200,2000,4000]}).toMatch(/done|error/)
  expect(job.error).toBeNull()
  expect(job.result.frames.length).toBeGreaterThanOrEqual(2)
  const frames=job.result.frames
  const image=await request.get(`/analysis${frames[0].png_url}`)
  expect(image.ok()).toBe(true)
  expect((await image.body()).length).toBeGreaterThan(100)
  const difference=await request.post(`${root}/difference`,{data:{frame_a:frames[0].id,frame_b:frames.at(-1).id,force:false},timeout:120_000})
  expect(difference.ok()).toBe(true)
  const result=await difference.json()
  expect(result.checks.length).toBeGreaterThan(0)
  if(result.comparable) {
    const map=await request.get(`/analysis${result.significance_png_url}`)
    expect(map.ok()).toBe(true)
  }
  await writeFile(info.outputPath('real-analysis.json'),JSON.stringify({target,observations:observations.observations.length,job,difference:result},null,2))
})
