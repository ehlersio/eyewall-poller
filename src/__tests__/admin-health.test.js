// src/__tests__/admin-health.test.js
// Coverage for the news-feed health tracking + admin auth added 2026-09
// (recordHealth/verifyAdminUser in shared.js, GET /admin/health in
// worker.js) — nothing recorded fetch success/failure before this, and
// there was no admin/owner concept anywhere in the stack. See shared.js's
// own comments on both for the full "why".

import { describe, it, expect, vi, afterEach } from 'vitest'
import { recordHealth, verifyAdminUser } from '../shared.js'
import { handleRequest } from '../worker.js'
import { makeEnv, makeCtx, makeRequest } from './route-harness.js'

describe('recordHealth', () => {
  it('records a first success with no prior state', async () => {
    const env = makeEnv()
    await recordHealth(env, 'echl:test-source', true, { itemCount: 5 })
    const raw = await env.CACHE.get('health:echl:test-source')
    const rec = JSON.parse(raw)
    expect(rec.key).toBe('echl:test-source')
    expect(rec.itemCount).toBe(5)
    expect(rec.lastError).toBeNull()
    expect(rec.consecutiveFailures).toBe(0)
    expect(rec.lastSuccessAt).toBeTruthy()
  })

  it('increments consecutiveFailures across repeated failures and preserves the last real success', async () => {
    const env = makeEnv()
    await recordHealth(env, 'echl:test-source', true, { itemCount: 3 })
    const afterSuccess = JSON.parse(await env.CACHE.get('health:echl:test-source'))

    await recordHealth(env, 'echl:test-source', false, { error: 'HTTP 500' })
    const afterFail1 = JSON.parse(await env.CACHE.get('health:echl:test-source'))
    expect(afterFail1.consecutiveFailures).toBe(1)
    expect(afterFail1.lastError).toBe('HTTP 500')
    // A failure doesn't erase the last time it actually worked
    expect(afterFail1.lastSuccessAt).toBe(afterSuccess.lastSuccessAt)

    await recordHealth(env, 'echl:test-source', false, { error: 'HTTP 500' })
    const afterFail2 = JSON.parse(await env.CACHE.get('health:echl:test-source'))
    expect(afterFail2.consecutiveFailures).toBe(2)
  })

  it('a success after failures resets consecutiveFailures to 0 and clears lastError', async () => {
    const env = makeEnv()
    await recordHealth(env, 'echl:test-source', false, { error: 'boom' })
    await recordHealth(env, 'echl:test-source', false, { error: 'boom' })
    await recordHealth(env, 'echl:test-source', true, { itemCount: 1 })
    const rec = JSON.parse(await env.CACHE.get('health:echl:test-source'))
    expect(rec.consecutiveFailures).toBe(0)
    expect(rec.lastError).toBeNull()
  })
})

describe('verifyAdminUser', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })

  it('returns null with no Authorization header', async () => {
    const env = makeEnv()
    const req = makeRequest('/admin/health')
    expect(await verifyAdminUser(req, env)).toBeNull()
  })

  it('returns null when Supabase rejects the token', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false })
    const env = makeEnv()
    const req = makeRequest('/admin/health', { headers: { Authorization: 'Bearer bad-token' } })
    expect(await verifyAdminUser(req, env)).toBeNull()
  })

  it('returns null when the verified email is not on the allowlist', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ email: 'someone-else@example.com' }) })
    const env = makeEnv()
    const req = makeRequest('/admin/health', { headers: { Authorization: 'Bearer some-token' } })
    expect(await verifyAdminUser(req, env)).toBeNull()
  })

  it('returns the user when the verified email is on the allowlist', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ email: 'matt@ehlers.io' }) })
    const env = makeEnv()
    const req = makeRequest('/admin/health', { headers: { Authorization: 'Bearer some-token' } })
    const user = await verifyAdminUser(req, env)
    expect(user?.email).toBe('matt@ehlers.io')
  })
})

describe('GET /admin/health', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })

  it('401s without auth', async () => {
    const env = makeEnv()
    const res = await handleRequest(makeRequest('/admin/health'), env, makeCtx())
    expect(res.status).toBe(401)
  })

  it('returns recorded health sources, sorted by key, once authorized', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ email: 'matt@ehlers.io' }) })
    const env = makeEnv()
    await recordHealth(env, 'pwhl:espn', true, { itemCount: 2 })
    await recordHealth(env, 'ahl:theahl', false, { error: 'timeout' })

    const res = await handleRequest(
      makeRequest('/admin/health', { headers: { Authorization: 'Bearer some-token' } }),
      env, makeCtx()
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sources.map(s => s.key)).toEqual(['ahl:theahl', 'pwhl:espn'])
    expect(body.sources.find(s => s.key === 'ahl:theahl').lastError).toBe('timeout')
    expect(body.checkedAt).toBeTruthy()
  })
})
