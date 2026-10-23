// src/__tests__/dispatch.test.js
// The Worker starts the pipeline's daily workflows and social posts
// (dispatch.js, 2026-10) because GitHub's own cron runs them 3-7 hours late.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { maybeDispatchWorkflows, DISPATCH_SCHEDULE, DAILY_SCHEDULE, DISPATCH_RETRY_SECONDS, CONTRACTS_WORKFLOW } from '../dispatch.js'
import { makeEnv } from './route-harness.js'

const at = iso => new Date(iso)
const allDispatchCalls = () => globalThis.fetch.mock.calls.filter(([u]) => String(u).includes('/dispatches'))
const dispatchCalls = () => allDispatchCalls().filter(([u]) => !String(u).includes('nhl-contracts'))
const dispatchedWorkflows = () => dispatchCalls().map(([u]) => String(u).match(/workflows\/([^/]+)\/dispatches/)[1])
const dispatchedBodies = () => dispatchCalls().map(([, o]) => JSON.parse(o.body))
const dispatchedKinds = () => dispatchedBodies().filter(b => b.inputs).map(b => b.inputs.kind)
const SOCIAL = 'social-posts.yml'
const isDaily = w => !w.startsWith(`${SOCIAL}:`) && !w.startsWith(`${CONTRACTS_WORKFLOW}:`)
// The pipeline and social suites below ignore the nhl-contracts collector (its own suite is last).
const notContracts = w => !w.startsWith(`${CONTRACTS_WORKFLOW}:`)
const run = async (env, when) => (await maybeDispatchWorkflows(env, when)).filter(notContracts)

const realFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = vi.fn().mockResolvedValue({ status: 204, text: async () => '' })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks() })

const envWithToken = () => makeEnv({ GITHUB_DISPATCH_TOKEN: 'ghp_test' })

describe('maybeDispatchWorkflows', () => {
  it('dispatches nothing before the first slot', async () => {
    const env = envWithToken()
    expect(await run(env, at('2026-10-07T06:59:00Z'))).toEqual([])
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('dispatches each workflow once its slot has passed, with the GitHub API contract', async () => {
    const env = envWithToken()
    expect(await run(env, at('2026-10-07T07:00:00Z'))).toEqual(['nightly.yml'])
    const [url, opts] = dispatchCalls()[0]
    expect(url).toBe('https://api.github.com/repos/ehlersio/eyewall-pipeline/actions/workflows/nightly.yml/dispatches')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ ref: 'main' })
    expect(opts.headers).toMatchObject({
      Authorization: 'Bearer ghp_test',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'eyewall-poller',
    })

    expect(await run(env, at('2026-10-07T07:39:00Z'))).toEqual(['pwhl-nightly.yml'])
    expect(await run(env, at('2026-10-07T13:59:00Z'))).toEqual(['ahl-nightly.yml', 'echl-nightly.yml', 'moneypuck-ingest.yml'])
    expect(await run(env, at('2026-10-07T14:00:00Z'))).toEqual(['ai_pipeline.yml'])
    expect(dispatchedWorkflows()).toEqual(DAILY_SCHEDULE.map(e => e.workflow))
  })

  it('fires once per UTC day: the marker holds it for the rest of the day, the next day fires again', async () => {
    const env = envWithToken()
    const put = vi.spyOn(env.CACHE, 'put')
    await run(env, at('2026-10-07T07:05:00Z'))
    await run(env, at('2026-10-07T07:06:00Z'))
    await run(env, at('2026-10-07T07:15:00Z'))
    expect(dispatchedWorkflows()).toEqual(['nightly.yml'])
    expect(put.mock.calls.find(([k]) => k === 'ops:dispatched:nightly.yml:2026-10-07')[2]).toEqual({ expirationTtl: 36 * 3600 })

    await run(env, at('2026-10-08T07:01:00Z'))
    expect(dispatchedWorkflows()).toEqual(['nightly.yml', 'nightly.yml'])
  })

  it('records each dispatch under health:ops:dispatch-<workflow>', async () => {
    const env = envWithToken()
    await run(env, at('2026-10-07T07:00:00Z'))
    const rec = JSON.parse(await env.CACHE.get('health:ops:dispatch-nightly.yml'))
    expect(rec).toMatchObject({
      status: 'ok',
      title: 'Dispatched nightly.yml',
      url: 'https://github.com/ehlersio/eyewall-pipeline/actions/workflows/nightly.yml',
    })
    expect(rec.at).toBeTruthy()
  })

  it('without the token: dispatches nothing and logs once a day', async () => {
    const env = makeEnv()
    await run(env, at('2026-10-07T08:00:00Z'))
    await run(env, at('2026-10-07T08:01:00Z'))
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(await env.CACHE.get('ops:dispatch:no-token:2026-10-07')).not.toBeNull()
    expect(await env.CACHE.get('ops:dispatched:nightly.yml:2026-10-07')).toBeNull()

    await run(env, at('2026-10-08T08:00:00Z'))
    expect(console.warn).toHaveBeenCalledTimes(2)
  })

  it('records a failed dispatch, writes no marker, and retries after the back-off rather than every minute', async () => {
    const env = envWithToken()
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 401, text: async () => '{"message":"Bad credentials"}' })
    const put = vi.spyOn(env.CACHE, 'put')
    expect(await run(env, at('2026-10-07T07:00:00Z'))).toEqual([])

    const rec = JSON.parse(await env.CACHE.get('health:ops:dispatch-nightly.yml'))
    expect(rec.status).toBe('failure')
    expect(rec.body).toContain('GitHub 401')
    expect(rec.body).toContain('Bad credentials')
    expect(await env.CACHE.get('ops:dispatched:nightly.yml:2026-10-07')).toBeNull()
    expect(put.mock.calls.find(([k]) => k === 'ops:dispatch:retry:nightly.yml:2026-10-07')[2]).toEqual({ expirationTtl: DISPATCH_RETRY_SECONDS })

    // Held back while the retry key lives (the fake KV ignores TTLs, so
    // drop it by hand to stand in for its expiry).
    await run(env, at('2026-10-07T07:01:00Z'))
    expect(dispatchCalls()).toHaveLength(1)
    await env.CACHE.delete('ops:dispatch:retry:nightly.yml:2026-10-07')
    globalThis.fetch.mockResolvedValue({ status: 204, text: async () => '' })
    expect(await run(env, at('2026-10-07T07:11:00Z'))).toEqual(['nightly.yml'])
    expect(JSON.parse(await env.CACHE.get('health:ops:dispatch-nightly.yml')).status).toBe('ok')
  })

  it('a network error is recorded as a failure too', async () => {
    const env = envWithToken()
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connect ETIMEDOUT'))
    await run(env, at('2026-10-07T07:00:00Z'))
    const rec = JSON.parse(await env.CACHE.get('health:ops:dispatch-nightly.yml'))
    expect(rec.status).toBe('failure')
    expect(rec.body).toContain('connect ETIMEDOUT')
  })

  it('one workflow failing does not hold back the others', async () => {
    const env = envWithToken()
    globalThis.fetch = vi.fn(async url => (String(url).includes('pwhl-nightly')
      ? { status: 500, text: async () => 'boom' }
      : { status: 204, text: async () => '' }))
    expect(await run(env, at('2026-10-07T07:45:00Z'))).toEqual(['nightly.yml', 'ahl-nightly.yml'])
  })

  it('the six daily workflows keep running past the social posts\' window, and still send no inputs', async () => {
    const env = envWithToken()
    // 23:50 Wednesday: every daily slot has passed, every post slot is past its window.
    expect(await run(env, at('2026-10-07T23:50:00Z'))).toEqual(DAILY_SCHEDULE.map(e => e.workflow))
    expect(dispatchedBodies()).toEqual(DAILY_SCHEDULE.map(() => ({ ref: 'main' })))
    expect(await env.CACHE.get('ops:dispatched:ai_pipeline.yml:2026-10-07')).not.toBeNull()
  })
})

describe('maybeDispatchWorkflows: social posts', () => {
  // A Wednesday with the six daily markers already written, so only posts dispatch.
  const dailyDone = async (env, date) => {
    for (const { workflow } of DAILY_SCHEDULE) await env.CACHE.put(`ops:dispatched:${workflow}:${date}`, '"x"')
  }
  const dropSpacing = env => env.CACHE.delete(`ops:dispatch:spacing:${SOCIAL}`)

  it('mirrors social-posts.yml: every kind has a first slot and a backup an hour later, all sent live', () => {
    const social = DISPATCH_SCHEDULE.filter(e => e.workflow === SOCIAL)
    expect(social).toHaveLength(36)
    const byKind = Object.groupBy(social, e => e.kind)
    expect(Object.keys(byKind)).toHaveLength(18)
    for (const [kind, [first, backup, ...rest]] of Object.entries(byKind)) {
      expect(rest, kind).toEqual([])
      const mins = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))
      expect(mins(backup.atUTC) - mins(first.atUTC), kind).toBe(60)
      expect(first.days, kind).toEqual(backup.days)
      for (const e of [first, backup]) {
        expect(e.inputs).toEqual({ kind, dry_run: 'false' })
        expect(e.windowMinutes).toBeLessThan(60)
        expect(mins(e.atUTC) + e.windowMinutes).toBeLessThan(24 * 60) // never spills into the next UTC day
      }
    }
  })

  it('a post slot sends its kind and dry_run "false" (the workflow defaults dry_run to true on a dispatch)', async () => {
    const env = envWithToken()
    await dailyDone(env, '2026-10-07')
    expect(await run(env, at('2026-10-07T15:30:00Z'))).toEqual([`${SOCIAL}:winners`])
    const [url, opts] = dispatchCalls()[0]
    expect(url).toBe('https://api.github.com/repos/ehlersio/eyewall-pipeline/actions/workflows/social-posts.yml/dispatches')
    expect(JSON.parse(opts.body)).toEqual({ ref: 'main', inputs: { kind: 'winners', dry_run: 'false' } })
    expect(await env.CACHE.get(`ops:dispatched:${SOCIAL}:winners:15:30:2026-10-07`)).not.toBeNull()
    const rec = JSON.parse(await env.CACHE.get(`health:ops:dispatch-${SOCIAL}:winners`))
    expect(rec).toMatchObject({ status: 'ok', title: 'Dispatched social-posts.yml (winners 15:30)' })
    expect(await env.CACHE.get(`health:ops:dispatch-${SOCIAL}`)).toBeNull()
  })

  it('weekday slots go out only on their UTC weekday', async () => {
    // 15:00 UTC: rankings Mondays, trends Fridays, cherry-picked Sundays, nothing else.
    const kindsAt = async iso => {
      const env = envWithToken()
      await dailyDone(env, iso.slice(0, 10))
      globalThis.fetch.mockClear()
      await run(env, at(iso))
      return dispatchedKinds()
    }
    expect(await kindsAt('2026-10-12T15:00:00Z')).toEqual(['rankings'])      // Monday
    expect(await kindsAt('2026-10-13T15:00:00Z')).toEqual([])                // Tuesday
    expect(await kindsAt('2026-10-14T15:00:00Z')).toEqual([])                // Wednesday
    expect(await kindsAt('2026-10-16T15:00:00Z')).toEqual(['trends'])        // Friday
    expect(await kindsAt('2026-10-18T15:00:00Z')).toEqual(['cherry-picked']) // Sunday
    // Thursday's minor-leaders at 21:00, and not on a Wednesday.
    expect(await kindsAt('2026-10-15T21:00:00Z')).toEqual(['minor-leaders'])
    expect(await kindsAt('2026-10-14T21:00:00Z')).toEqual([])
  })

  it('a kind\'s first slot and its backup dispatch separately on the same day, each once', async () => {
    const env = envWithToken()
    await dailyDone(env, '2026-10-07')
    expect(await run(env, at('2026-10-07T15:30:00Z'))).toEqual([`${SOCIAL}:winners`])
    await dropSpacing(env)
    expect(await run(env, at('2026-10-07T15:36:00Z'))).toEqual([])
    // 16:30: pwhl-winners 15:45 and minor-winners 16:15 went out in between.
    await run(env, at('2026-10-07T15:45:00Z')); await dropSpacing(env)
    await run(env, at('2026-10-07T16:15:00Z')); await dropSpacing(env)
    expect(await run(env, at('2026-10-07T16:30:00Z'))).toEqual([`${SOCIAL}:winners`])
    expect(await env.CACHE.get(`ops:dispatched:${SOCIAL}:winners:16:30:2026-10-07`)).not.toBeNull()
    expect(JSON.parse(await env.CACHE.get(`health:ops:dispatch-${SOCIAL}:winners`)).title).toBe('Dispatched social-posts.yml (winners 16:30)')
    await dropSpacing(env)
    expect(await run(env, at('2026-10-07T16:31:00Z'))).toEqual([])
    expect(dispatchedKinds()).toEqual(['winners', 'pwhl-winners', 'minor-winners', 'winners'])
  })

  it('a slot is not dispatched once its window has passed (the backup or the GitHub fallback covers it)', async () => {
    const env = envWithToken()
    await dailyDone(env, '2026-10-07')
    // 16:20: winners 15:30 is 50 min old (window 45); pwhl-winners 15:45 is still in its window.
    expect(await run(env, at('2026-10-07T16:20:00Z'))).toEqual([`${SOCIAL}:pwhl-winners`])
  })

  it('slots that come due together go out a spacing apart, earliest first (one pending run per concurrency group)', async () => {
    const env = envWithToken()
    await dailyDone(env, '2026-10-15')
    // Thursday 17:20, e.g. right after a deploy: pwhl-winners 16:45, pwhl-leaders 17:00 and
    // minor-winners 17:15 are all in their windows.
    expect(await run(env, at('2026-10-15T17:20:00Z'))).toEqual([`${SOCIAL}:pwhl-winners`])
    const put = vi.spyOn(env.CACHE, 'put')
    expect(await run(env, at('2026-10-15T17:21:00Z'))).toEqual([])
    expect(put).not.toHaveBeenCalled()
    await dropSpacing(env) // stands in for the 5-minute TTL
    expect(await run(env, at('2026-10-15T17:25:00Z'))).toEqual([`${SOCIAL}:pwhl-leaders`])
    expect(put.mock.calls.find(([k]) => k === `ops:dispatch:spacing:${SOCIAL}`)[2]).toEqual({ expirationTtl: 300 })
    await dropSpacing(env)
    expect(await run(env, at('2026-10-15T17:30:00Z'))).toEqual([`${SOCIAL}:minor-winners`])
  })

  it('spacing holds back only social posts: daily workflows due in the same tick still go', async () => {
    const env = envWithToken()
    const done = await run(env, at('2026-10-15T17:20:00Z'))
    expect(done.filter(isDaily)).toEqual(DAILY_SCHEDULE.map(e => e.workflow))
    expect(done.filter(w => !isDaily(w))).toEqual([`${SOCIAL}:pwhl-winners`])
  })

  it('a failed post dispatch retries on its own slot key and does not hold back the next post', async () => {
    const env = envWithToken()
    await dailyDone(env, '2026-10-15')
    globalThis.fetch = vi.fn(async (url, opts) => (JSON.parse(opts.body).inputs?.kind === 'pwhl-winners'
      ? { status: 422, text: async () => 'Unexpected inputs provided' }
      : { status: 204, text: async () => '' }))
    expect(await run(env, at('2026-10-15T17:20:00Z'))).toEqual([`${SOCIAL}:pwhl-leaders`])
    expect(await env.CACHE.get(`ops:dispatch:retry:${SOCIAL}:pwhl-winners:16:45:2026-10-15`)).not.toBeNull()
    expect(await env.CACHE.get(`ops:dispatched:${SOCIAL}:pwhl-winners:16:45:2026-10-15`)).toBeNull()
    const rec = JSON.parse(await env.CACHE.get(`health:ops:dispatch-${SOCIAL}:pwhl-winners`))
    expect(rec).toMatchObject({ status: 'failure', title: 'Dispatch of social-posts.yml (pwhl-winners 16:45) failed' })
    expect(rec.body).toContain('GitHub 422')
  })

  it('without the token: posts are not dispatched either, and the day is still logged once', async () => {
    const env = makeEnv()
    await run(env, at('2026-10-07T15:30:00Z'))
    await run(env, at('2026-10-07T16:30:00Z'))
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.warn.mock.calls[0][0]).toContain('social-posts.yml (winners 15:30)')
  })
})


describe('maybeDispatchWorkflows: nhl-contracts collector', () => {
  const contractsCalls = () => allDispatchCalls().filter(([u]) => String(u).includes('nhl-contracts'))
  const contractsOnly = list => list.filter(w => w.startsWith(`${CONTRACTS_WORKFLOW}:`))

  it('has an hourly slot at :05 all year and three extra slots an hour from July 1 to 15', () => {
    const entries = DISPATCH_SCHEDULE.filter(e => e.workflow === CONTRACTS_WORKFLOW)
    expect(entries.every(e => e.repo === 'ehlersio/nhl-contracts')).toBe(true)
    expect(entries.filter(e => e.kind === 'hourly').map(e => e.atUTC)).toEqual(
      Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:05`))
    const july = entries.filter(e => e.kind === 'july')
    expect(july).toHaveLength(72)
    expect(july.every(e => e.dates[0] === '07-01' && e.dates[1] === '07-15' && /:(20|35|50)$/.test(e.atUTC))).toBe(true)
  })

  it('dispatches the hourly slot to the nhl-contracts repository once an hour, within its window', async () => {
    const env = envWithToken()
    expect(contractsOnly(await maybeDispatchWorkflows(env, at('2026-10-24T13:05:00Z')))).toEqual([`${CONTRACTS_WORKFLOW}:hourly`])
    const [url, opts] = contractsCalls()[0]
    expect(url).toBe('https://api.github.com/repos/ehlersio/nhl-contracts/actions/workflows/update-contracts.yml/dispatches')
    expect(JSON.parse(opts.body)).toEqual({ ref: 'main' })
    expect(contractsOnly(await maybeDispatchWorkflows(env, at('2026-10-24T13:06:00Z')))).toEqual([])  // marker
    expect(contractsOnly(await maybeDispatchWorkflows(env, at('2026-10-24T14:05:00Z')))).toEqual([`${CONTRACTS_WORKFLOW}:hourly`])
    expect(contractsCalls()).toHaveLength(2)
    expect(JSON.parse(await env.CACHE.get('health:ops:dispatch-update-contracts.yml:hourly')).url)
      .toBe('https://github.com/ehlersio/nhl-contracts/actions/workflows/update-contracts.yml')
  })

  it('a missed hourly slot is not sent late: after 30 minutes the next hour covers it', async () => {
    const env = envWithToken()
    expect(contractsOnly(await maybeDispatchWorkflows(env, at('2026-10-24T13:40:00Z')))).toEqual([])
    expect(contractsCalls()).toHaveLength(0)
  })

  it('the 15-minute slots fire only from July 1 to 15', async () => {
    const env = envWithToken()
    await maybeDispatchWorkflows(env, at('2026-07-03T13:05:00Z'))  // the hourly slot, as every day
    expect(contractsOnly(await maybeDispatchWorkflows(env, at('2026-07-03T13:20:00Z')))).toEqual([`${CONTRACTS_WORKFLOW}:july`])
    expect(contractsOnly(await maybeDispatchWorkflows(env, at('2026-07-03T13:35:00Z')))).toEqual([`${CONTRACTS_WORKFLOW}:july`])
    expect(contractsOnly(await maybeDispatchWorkflows(env, at('2026-07-03T13:50:00Z')))).toEqual([`${CONTRACTS_WORKFLOW}:july`])
    expect(contractsCalls()).toHaveLength(4)
    const julyOnly = list => list.filter(w => w === `${CONTRACTS_WORKFLOW}:july`)
    expect(julyOnly(await maybeDispatchWorkflows(env, at('2026-07-16T13:20:00Z')))).toEqual([])
    expect(julyOnly(await maybeDispatchWorkflows(env, at('2026-10-24T13:20:00Z')))).toEqual([])
    expect(contractsCalls()).toHaveLength(6)  // 4 July slots + the two hourly ones
  })

  it('the pipeline workflows still go to eyewall-pipeline', async () => {
    const env = envWithToken()
    await maybeDispatchWorkflows(env, at('2026-10-24T07:00:00Z'))
    expect(dispatchCalls().map(([u]) => String(u))).toContain(
      'https://api.github.com/repos/ehlersio/eyewall-pipeline/actions/workflows/nightly.yml/dispatches')
  })
})
