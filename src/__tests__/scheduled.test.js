// src/__tests__/scheduled.test.js
// The cron tick (worker.js runScheduled). Until 2026-10 poll() was the one
// league without a .catch: an NHL API error rejected the Promise.all, so
// that tick's alert-log flush never ran (audit 2026-10-06 Worker F4), and
// nothing recorded that the cron was failing at all.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../nhl.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, poll: vi.fn(), refreshPPUnits: vi.fn().mockResolvedValue({}) }
})
vi.mock('../pwhl.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, pollPWHL: vi.fn() }
})
vi.mock('../ahl.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, pollAHL: vi.fn() }
})
vi.mock('../echl.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, pollECHL: vi.fn() }
})
vi.mock('../seasons.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, refreshSeasonsCache: vi.fn().mockResolvedValue(undefined) }
})
vi.mock('../shared.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, flushAlertLog: vi.fn().mockResolvedValue(undefined) }
})

import worker, { runScheduled } from '../worker.js'
import { poll } from '../nhl.js'
import { pollPWHL } from '../pwhl.js'
import { pollAHL } from '../ahl.js'
import { pollECHL } from '../echl.js'
import { flushAlertLog } from '../shared.js'
import { makeEnv, makeCtx, flushWaitUntil } from './route-harness.js'

beforeEach(() => {
  vi.clearAllMocks()
  for (const fn of [poll, pollPWHL, pollAHL, pollECHL]) fn.mockResolvedValue(undefined)
})

describe('runScheduled', () => {
  it('an NHL poll failure neither skips the other leagues nor the alert-log flush', async () => {
    poll.mockRejectedValue(new Error('NHL 503'))
    const env = makeEnv()
    await runScheduled(env, makeCtx())

    expect(pollPWHL).toHaveBeenCalledTimes(1)
    expect(pollAHL).toHaveBeenCalledTimes(1)
    expect(pollECHL).toHaveBeenCalledTimes(1)
    expect(flushAlertLog).toHaveBeenCalledTimes(1)

    const nhl = JSON.parse(await env.CACHE.get('health:cron:nhl'))
    expect(nhl.lastError).toBe('NHL 503')
    expect(nhl.lastOkAt).toBeNull()
    for (const league of ['pwhl', 'ahl', 'echl']) {
      const rec = JSON.parse(await env.CACHE.get(`health:cron:${league}`))
      expect(rec.lastError).toBeNull()
      expect(rec.lastOkAt).toBe(rec.lastPollAt)
    }
  })

  it('still flushes the alert log when KV writes fail', async () => {
    poll.mockRejectedValue(new Error('NHL 503'))
    const env = makeEnv()
    env.CACHE.put = vi.fn().mockRejectedValue(new Error('KV down'))
    await runScheduled(env, makeCtx())
    expect(pollECHL).toHaveBeenCalledTimes(1)
    expect(flushAlertLog).toHaveBeenCalledTimes(1)
  })

  it('scheduled() hands the whole tick to waitUntil', async () => {
    const env = makeEnv()
    const ctx = makeCtx()
    await worker.scheduled({}, env, ctx)
    expect(ctx._promises).toHaveLength(1)
    await flushWaitUntil(ctx)
    expect(poll).toHaveBeenCalledTimes(1)
    expect(flushAlertLog).toHaveBeenCalledTimes(1)
  })
})
