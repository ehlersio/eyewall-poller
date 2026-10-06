// src/__tests__/scheduled-dispatch.test.js
// scheduled() runs the pipeline dispatcher (dispatch.js) every tick, and a
// dispatcher failure doesn't take the tick down with it.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../nhl.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, poll: vi.fn().mockResolvedValue(undefined), refreshPPUnits: vi.fn().mockResolvedValue({}) }
})
vi.mock('../pwhl.js', async (importOriginal) => ({ ...(await importOriginal()), pollPWHL: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../ahl.js', async (importOriginal) => ({ ...(await importOriginal()), pollAHL: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../echl.js', async (importOriginal) => ({ ...(await importOriginal()), pollECHL: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../seasons.js', async (importOriginal) => ({ ...(await importOriginal()), refreshSeasonsCache: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../shared.js', async (importOriginal) => ({ ...(await importOriginal()), flushAlertLog: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../dispatch.js', () => ({ maybeDispatchWorkflows: vi.fn() }))

import worker from '../worker.js'
import { maybeDispatchWorkflows } from '../dispatch.js'
import { flushAlertLog } from '../shared.js'
import { makeEnv, makeCtx, flushWaitUntil } from './route-harness.js'

beforeEach(() => { vi.clearAllMocks() })

describe('scheduled() and the pipeline dispatcher', () => {
  it('calls maybeDispatchWorkflows every tick', async () => {
    maybeDispatchWorkflows.mockResolvedValue([])
    const env = makeEnv()
    const ctx = makeCtx()
    await worker.scheduled({}, env, ctx)
    await flushWaitUntil(ctx)
    expect(maybeDispatchWorkflows).toHaveBeenCalledWith(env)
    expect(flushAlertLog).toHaveBeenCalledTimes(1)
  })

  it('a dispatcher failure is logged and the tick still completes', async () => {
    maybeDispatchWorkflows.mockRejectedValue(new Error('KV down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const ctx = makeCtx()
    await worker.scheduled({}, makeEnv(), ctx)
    await flushWaitUntil(ctx)
    expect(flushAlertLog).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledWith('Workflow dispatch error:', 'KV down')
  })
})
