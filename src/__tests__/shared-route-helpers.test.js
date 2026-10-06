// src/__tests__/shared-route-helpers.test.js
// shared.js's route-handler helpers: cachedJson, sbRows, sbRowsOr, sbError,
// errorJson. Route-level behavior through them is pinned by the league
// characterization suites; these cover the helpers' own contracts.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { makeFakeCache } from './route-harness.js'
import { cachedJson, sbRows, sbRowsOr, sbRosterRows, ON_ROSTER_FILTER, sbError, errorJson, SB_ANON } from '../shared.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function envWithCache(initial) {
  const cache = makeFakeCache(initial)
  const puts = []
  const put = cache.put
  cache.put = async (key, value, opts) => { puts.push({ key, ttl: opts?.expirationTtl }); return put(key, value) }
  return { env: { CACHE: cache }, puts }
}

describe('cachedJson', () => {
  it('serves a cached value without building', async () => {
    const { env, puts } = envWithCache({ k: [1, 2] })
    const build = vi.fn()
    const res = await cachedJson(env, 'k', 60, build)
    expect(await res.json()).toEqual([1, 2])
    expect(build).not.toHaveBeenCalled()
    expect(puts).toEqual([])
  })

  it('builds, caches with the TTL and serves on a miss', async () => {
    const { env, puts } = envWithCache()
    const res = await cachedJson(env, 'k', 1800, async () => ({ a: 1 }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(await res.json()).toEqual({ a: 1 })
    expect(puts).toEqual([{ key: 'k', ttl: 1800 }])
  })

  it('takes the TTL from the data when given a function', async () => {
    const { env, puts } = envWithCache()
    await cachedJson(env, 'k', d => (d.final ? 3600 : 60), async () => ({ final: true }))
    expect(puts).toEqual([{ key: 'k', ttl: 3600 }])
  })

  it('returns a Response from build as-is and uncached', async () => {
    const { env, puts } = envWithCache()
    const res = await cachedJson(env, 'k', 60, async () => errorJson(404, { error: 'nope' }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'nope' })
    expect(puts).toEqual([])
  })
})

describe('sbRows / sbRowsOr', () => {
  it('sends the auth headers plus any extra ones and returns the rows', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => [{ id: 1 }] }))
    expect(await sbRows('https://sb.test/rest/v1/t', { Range: '0-999' })).toEqual([{ id: 1 }])
    expect(globalThis.fetch).toHaveBeenCalledWith('https://sb.test/rest/v1/t', {
      headers: { apikey: SB_ANON, Authorization: `Bearer ${SB_ANON}`, Range: '0-999' },
    })
  })

  it('returns a 502 Response on a failed read', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503 }))
    const res = await sbRows('https://sb.test/rest/v1/t')
    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'Supabase 503' })
  })

  it('sbRowsOr returns the fallback on a failed read', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500 }))
    expect(await sbRowsOr('https://sb.test/rest/v1/t', [])).toEqual([])
  })
})

describe('sbError', () => {
  it('without a status reports a combined failure', async () => {
    const res = sbError()
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'Supabase error' })
  })
})

describe('sbRosterRows', () => {
  const URL_ = 'https://sb.test/rest/v1/ahl_players?team_id=eq.335&select=player_id'

  it('hides players marked off the roster', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => [{ player_id: 1 }] }))
    expect(await sbRosterRows(URL_)).toEqual([{ player_id: 1 }])
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(String(globalThis.fetch.mock.calls[0][0])).toBe(`${URL_}&on_roster=not.is.false`)
    expect(ON_ROSTER_FILTER).toBe('on_roster=not.is.false')
  })

  it('falls back to the unfiltered read while the column is missing (PostgREST 400)', async () => {
    globalThis.fetch = vi.fn(async (u) => String(u).includes('on_roster')
      ? { ok: false, status: 400, json: async () => ({ code: '42703' }) }
      : { ok: true, json: async () => [{ player_id: 1 }, { player_id: 2 }] })
    expect(await sbRosterRows(URL_)).toEqual([{ player_id: 1 }, { player_id: 2 }])
    expect(globalThis.fetch.mock.calls.map(c => String(c[0]))).toEqual([`${URL_}&on_roster=not.is.false`, URL_])
  })

  it('still reports an error when the unfiltered read fails too', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503 }))
    const res = await sbRosterRows(URL_)
    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(502)
  })
})
