// src/__tests__/dispatch.test.js
// The Worker starts the pipeline's daily workflows (dispatch.js, 2026-10)
// because GitHub's own cron runs them 3-7 hours late.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { maybeDispatchWorkflows, DISPATCH_SCHEDULE, DISPATCH_RETRY_SECONDS } from '../dispatch.js'
import { makeEnv } from './route-harness.js'

const at = iso => new Date(iso)
const dispatchCalls = () => globalThis.fetch.mock.calls.filter(([u]) => String(u).includes('/dispatches'))
const dispatchedWorkflows = () => dispatchCalls().map(([u]) => String(u).match(/workflows\/([^/]+)\/dispatches/)[1])

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
    expect(await maybeDispatchWorkflows(env, at('2026-10-07T06:59:00Z'))).toEqual([])
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('dispatches each workflow once its slot has passed, with the GitHub API contract', async () => {
    const env = envWithToken()
    expect(await maybeDispatchWorkflows(env, at('2026-10-07T07:00:00Z'))).toEqual(['nightly.yml'])
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

    expect(await maybeDispatchWorkflows(env, at('2026-10-07T07:39:00Z'))).toEqual(['pwhl-nightly.yml'])
    expect(await maybeDispatchWorkflows(env, at('2026-10-07T13:59:00Z'))).toEqual(['ahl-nightly.yml', 'echl-nightly.yml', 'moneypuck-ingest.yml'])
    expect(await maybeDispatchWorkflows(env, at('2026-10-07T14:00:00Z'))).toEqual(['ai_pipeline.yml'])
    expect(dispatchedWorkflows()).toEqual(DISPATCH_SCHEDULE.map(e => e.workflow))
  })

  it('fires once per UTC day: the marker holds it for the rest of the day, the next day fires again', async () => {
    const env = envWithToken()
    const put = vi.spyOn(env.CACHE, 'put')
    await maybeDispatchWorkflows(env, at('2026-10-07T07:05:00Z'))
    await maybeDispatchWorkflows(env, at('2026-10-07T07:06:00Z'))
    await maybeDispatchWorkflows(env, at('2026-10-07T07:15:00Z'))
    expect(dispatchedWorkflows()).toEqual(['nightly.yml'])
    expect(put.mock.calls.find(([k]) => k === 'ops:dispatched:nightly.yml:2026-10-07')[2]).toEqual({ expirationTtl: 36 * 3600 })

    await maybeDispatchWorkflows(env, at('2026-10-08T07:01:00Z'))
    expect(dispatchedWorkflows()).toEqual(['nightly.yml', 'nightly.yml'])
  })

  it('records each dispatch under health:ops:dispatch-<workflow>', async () => {
    const env = envWithToken()
    await maybeDispatchWorkflows(env, at('2026-10-07T07:00:00Z'))
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
    await maybeDispatchWorkflows(env, at('2026-10-07T08:00:00Z'))
    await maybeDispatchWorkflows(env, at('2026-10-07T08:01:00Z'))
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(await env.CACHE.get('ops:dispatch:no-token:2026-10-07')).not.toBeNull()
    expect(await env.CACHE.get('ops:dispatched:nightly.yml:2026-10-07')).toBeNull()

    await maybeDispatchWorkflows(env, at('2026-10-08T08:00:00Z'))
    expect(console.warn).toHaveBeenCalledTimes(2)
  })

  it('records a failed dispatch, writes no marker, and retries after the back-off rather than every minute', async () => {
    const env = envWithToken()
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 401, text: async () => '{"message":"Bad credentials"}' })
    const put = vi.spyOn(env.CACHE, 'put')
    expect(await maybeDispatchWorkflows(env, at('2026-10-07T07:00:00Z'))).toEqual([])

    const rec = JSON.parse(await env.CACHE.get('health:ops:dispatch-nightly.yml'))
    expect(rec.status).toBe('failure')
    expect(rec.body).toContain('GitHub 401')
    expect(rec.body).toContain('Bad credentials')
    expect(await env.CACHE.get('ops:dispatched:nightly.yml:2026-10-07')).toBeNull()
    expect(put.mock.calls.find(([k]) => k === 'ops:dispatch:retry:nightly.yml:2026-10-07')[2]).toEqual({ expirationTtl: DISPATCH_RETRY_SECONDS })

    // Held back while the retry key lives (the fake KV ignores TTLs, so
    // drop it by hand to stand in for its expiry).
    await maybeDispatchWorkflows(env, at('2026-10-07T07:01:00Z'))
    expect(dispatchCalls()).toHaveLength(1)
    await env.CACHE.delete('ops:dispatch:retry:nightly.yml:2026-10-07')
    globalThis.fetch.mockResolvedValue({ status: 204, text: async () => '' })
    expect(await maybeDispatchWorkflows(env, at('2026-10-07T07:11:00Z'))).toEqual(['nightly.yml'])
    expect(JSON.parse(await env.CACHE.get('health:ops:dispatch-nightly.yml')).status).toBe('ok')
  })

  it('a network error is recorded as a failure too', async () => {
    const env = envWithToken()
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connect ETIMEDOUT'))
    await maybeDispatchWorkflows(env, at('2026-10-07T07:00:00Z'))
    const rec = JSON.parse(await env.CACHE.get('health:ops:dispatch-nightly.yml'))
    expect(rec.status).toBe('failure')
    expect(rec.body).toContain('connect ETIMEDOUT')
  })

  it('one workflow failing does not hold back the others', async () => {
    const env = envWithToken()
    globalThis.fetch = vi.fn(async url => (String(url).includes('pwhl-nightly')
      ? { status: 500, text: async () => 'boom' }
      : { status: 204, text: async () => '' }))
    expect(await maybeDispatchWorkflows(env, at('2026-10-07T07:45:00Z'))).toEqual(['nightly.yml', 'ahl-nightly.yml'])
  })
})
