// src/__tests__/sb-params.test.js
// Query params are validated and encoded before they reach a PostgREST
// URL (shared.js's sbParam(), 2026-10). Before, `?playerId=8478427%26select
// %3Dplayer_id` decoded into `player_id=eq.8478427&select=player_id` and
// replaced the route's own column list (audit 2026-10-06 Worker F5,
// verified live). POLL_SECRET is compared in constant time.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sbParam, sbParamList, ParamError, secretMatches, withParamErrors } from '../shared.js'
import { handleRequest } from '../worker.js'
import { handleNHL } from '../nhl.js'
import { handlePWHL } from '../pwhl.js'
import { handleAHL } from '../ahl.js'
import { makeEnv, makeCtx, makeRequest } from './route-harness.js'

const INJECTED = '8478427%26select%3Dplayer_id'

const realFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => [], text: async () => '[]' }))
})
afterEach(() => { globalThis.fetch = realFetch })

const supabaseCalls = () => globalThis.fetch.mock.calls.map(([u]) => String(u)).filter(u => u.includes('/rest/v1/'))

describe('sbParam', () => {
  it('passes valid values through, URL-encoded', () => {
    expect(sbParam('8478427', { type: 'int' })).toBe('8478427')
    expect(sbParam('CAR', { type: 'abbr' })).toBe('CAR')
    expect(sbParam('NY', { type: 'abbr' })).toBe('NY')
    expect(sbParam('2025-26', { type: 'id' })).toBe('2025-26')
    expect(sbParam('a:b', { type: 'id' })).toBe('a%3Ab')
  })

  it('is null for an absent or empty param, so `|| default` still works', () => {
    expect(sbParam(null, { type: 'int' })).toBeNull()
    expect(sbParam(undefined, { type: 'int' })).toBeNull()
    expect(sbParam('', { type: 'int' })).toBeNull()
  })

  it('rejects anything that could extend the PostgREST query', () => {
    for (const bad of ['8478427&select=player_id', '1,2', '1)', '-1', '12.5', '1 or 1']) {
      expect(() => sbParam(bad, { type: 'int', name: 'playerId' })).toThrow(ParamError)
    }
    expect(() => sbParam('CAR&limit=1', { type: 'abbr' })).toThrow(ParamError)
    expect(() => sbParam('CAROLINA', { type: 'abbr' })).toThrow(ParamError)
    expect(() => sbParam('x&order=id.desc', { type: 'id' })).toThrow(ParamError)
    expect(() => sbParam('a b', { type: 'id' })).toThrow('invalid parameter')
    expect(() => sbParam('1x', { type: 'int', name: 'gameId' })).toThrow('invalid gameId')
  })

  it('throws a plain error on an unknown type (a code bug, not a bad request)', () => {
    expect(() => sbParam('1', { type: 'nope' })).toThrow('unknown type')
    expect(() => sbParam('1', { type: 'nope' })).not.toThrow(ParamError)
  })

  it('sbParamList checks every item of a comma-separated param', () => {
    expect(sbParamList('20242025, 20252026', { type: 'int' })).toEqual(['20242025', '20252026'])
    expect(sbParamList(null, { type: 'int' })).toEqual([])
    expect(() => sbParamList('20242025,2025&x=1', { type: 'int', name: 'seasons' })).toThrow(ParamError)
  })

  it('withParamErrors turns a ParamError into a 400 and rethrows anything else', async () => {
    const bad = withParamErrors(async () => { throw new ParamError('invalid team') })
    const res = await bad()
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid team' })
    const broken = withParamErrors(async () => { throw new Error('boom') })
    await expect(broken()).rejects.toThrow('boom')
  })
})

describe('routes reject an injected param with a 400 before any Supabase read', () => {
  it(`/player-shots?playerId=${INJECTED} (the audit's live repro)`, async () => {
    const res = await handleRequest(makeRequest(`/player-shots?playerId=${INJECTED}&team=CAR`), makeEnv(), makeCtx())
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid playerId' })
    expect(supabaseCalls()).toEqual([])
  })

  it('the same route still answers a clean request', async () => {
    const res = await handleRequest(makeRequest('/player-shots?playerId=8478427&team=CAR&season=20252026'), makeEnv(), makeCtx())
    expect(res.status).toBe(200)
    expect(supabaseCalls()[0]).toContain('player_id=eq.8478427&')
  })

  it('handleNHL called directly answers 400 too', async () => {
    const path = `/goalie-shots?goalieId=${INJECTED}`
    const res = await handleNHL(makeRequest(path), makeEnv(), makeCtx(), new URL(`https://example.com${path}`))
    expect(res.status).toBe(400)
  })

  it('NHL team and list params', async () => {
    for (const path of [
      '/team-lines?team=CAR%26limit%3D1',
      '/team-seasons/compare?team=CAR&seasons=20242025,2025%26x%3D1',
      '/team-seasons/compare-teams?teams=CAR,TOR)&season=20252026',
    ]) {
      const res = await handleRequest(makeRequest(path), makeEnv(), makeCtx())
      expect(res.status, path).toBe(400)
    }
    expect(supabaseCalls()).toEqual([])
  })

  it('PWHL and AHL player ids', async () => {
    const pwhl = `/pwhl/player/landing?id=${INJECTED}`
    expect((await handlePWHL(makeRequest(pwhl), makeEnv(), makeCtx(), new URL(`https://example.com${pwhl}`))).status).toBe(400)
    const ahl = `/ahl/player/landing?id=${INJECTED}`
    expect((await handleAHL(makeRequest(ahl), makeEnv(), makeCtx(), new URL(`https://example.com${ahl}`))).status).toBe(400)
    expect(supabaseCalls()).toEqual([])
  })

  it('a PWHL salaries season label still works', async () => {
    const res = await handleRequest(makeRequest('/pwhl/salaries?teamId=1&season=2025-26'), makeEnv(), makeCtx())
    expect(res.status).toBe(200)
    expect(supabaseCalls().some(u => u.includes('2025-26'))).toBe(true)
  })

  it('worker.js routes: /trivia/today team', async () => {
    const res = await handleRequest(makeRequest('/trivia/today?sport=nhl&team=CAR%26tier%3Deq.hard'), makeEnv(), makeCtx())
    expect(res.status).toBe(400)
    expect(supabaseCalls()).toEqual([])
  })
})

describe('secretMatches', () => {
  it('matches only the exact secret', () => {
    expect(secretMatches('s3cret', 's3cret')).toBe(true)
    expect(secretMatches('s3creT', 's3cret')).toBe(false)
    expect(secretMatches('s3cre', 's3cret')).toBe(false)
    expect(secretMatches('s3crets', 's3cret')).toBe(false)
    expect(secretMatches('', 's3cret')).toBe(false)
    expect(secretMatches(null, 's3cret')).toBe(false)
  })

  it('an unset secret never matches, not even an absent one', () => {
    expect(secretMatches(null, undefined)).toBe(false)
    expect(secretMatches('', '')).toBe(false)
    expect(secretMatches(undefined, undefined)).toBe(false)
  })

  it('gates the secret routes', async () => {
    const env = makeEnv()
    const wrong = await handleRequest(makeRequest('/cache/bust?key=standings&secret=nope', { method: 'POST' }), env, makeCtx())
    expect(wrong.status).toBe(401)
    const right = await handleRequest(makeRequest('/cache/bust?key=standings&secret=test-poll-secret', { method: 'POST' }), env, makeCtx())
    expect(right.status).toBe(200)
    const unset = await handleRequest(makeRequest('/cache/bust?key=standings', { method: 'POST' }), makeEnv({ POLL_SECRET: undefined }), makeCtx())
    expect(unset.status).toBe(401)
  })
})
