// src/__tests__/route-harness.js
// Shared harness for HTTP-route-level tests (Session 47, Item 2 — audit #9).
//
// No route handler (handleNHL/handlePWHL/handleRequest) had any test
// coverage before this — the only existing test file (seasons.test.js)
// covers pure resolution logic and never constructs a Request or invokes
// a handler. This harness fills that gap using the same "mock at the
// fetch/KV boundary" approach seasons.test.js already established, per
// CLAUDE.md's documented choice not to use a real Workers runtime
// (Miniflare/@cloudflare/vitest-pool-workers) — plain Node is sufficient
// since these handlers only touch Workers-specific APIs via env.CACHE,
// easy to fake here (AI generation used to be a second such API,
// env.AI.run() — since the 2026-08 OpenRouter migration it's a plain
// fetch() call like everything else, so it's mocked the same way as
// Supabase/HockeyTech calls now; see mockFetchWithAI() below).

import { vi } from 'vitest'

// In-memory KV namespace stand-in — real enough for kvGet/kvPut (shared.js)
// and any direct env.CACHE.get/put/delete calls in route handlers.
export function makeFakeCache(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]))
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null
    },
    async put(key, value) {
      store.set(key, value)
    },
    async delete(key) {
      store.delete(key)
    },
    // Real KV's getWithMetadata — poll() uses this (not plain get) to check
    // the news cache age without deserializing the value.
    async getWithMetadata(key) {
      return { value: store.has(key) ? store.get(key) : null, metadata: null }
    },
    _store: store, // test-only escape hatch for asserting on raw cache state
  }
}

// ── AI generation mocking (shared.js's generateText(), OpenRouter) ─────
// Post-2026-08-migration, AI calls go through plain fetch() like every
// other external call in this suite — mockFetchWithAI() wraps a test's
// own fetch dispatch (Supabase/HockeyTech/etc., if any) and adds the
// openrouter.ai branch on top, so most call sites only need to change
// what they pass in rather than rewrite their whole fetch mock.
export function mockFetchWithAI(aiResponseText, otherHandler) {
  globalThis.fetch = vi.fn((url, opts) => {
    if (String(url).includes('openrouter.ai')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: aiResponseText } }] }),
      })
    }
    return otherHandler
      ? otherHandler(url, opts)
      : Promise.resolve({ ok: true, json: async () => ({}) })
  })
}

// Same shape, but the OpenRouter call rejects — for routes' "AI call
// throws -> 502" coverage.
export function mockFetchWithFailingAI(otherHandler) {
  globalThis.fetch = vi.fn((url, opts) => {
    if (String(url).includes('openrouter.ai')) {
      return Promise.reject(new Error('AI unavailable'))
    }
    return otherHandler
      ? otherHandler(url, opts)
      : Promise.resolve({ ok: true, json: async () => ({}) })
  })
}

// Reads back what a mocked fetch()'s OpenRouter call(s) received — the
// fetch-boundary equivalent of the old env.AI.run.mock.calls[i][1].
export function aiCalls(fetchMock) {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('openrouter.ai'))
}

export function aiPrompt(fetchMock, callIndex = 0) {
  const call = aiCalls(fetchMock)[callIndex]
  return JSON.parse(call[1].body).messages
}

// Fake env.AI_ROUTE_LIMITER — the Workers-native rate-limit binding guarding
// the AI-calling routes (Session 48, Item 3). Defaults to always-allow so
// existing/new tests don't need to know about it; override per-test to
// exercise the 429 path once a route actually checks it.
export function makeFakeRateLimiter(limitImpl) {
  return { limit: limitImpl || vi.fn().mockResolvedValue({ success: true }) }
}

export function makeEnv(overrides = {}) {
  return {
    CACHE: makeFakeCache(),
    AI_ROUTE_LIMITER: makeFakeRateLimiter(),
    OPENROUTER_API_KEY: 'test-openrouter-key',
    POLL_SECRET: 'test-poll-secret',
    VAPID_PUBLIC_KEY: undefined,
    VAPID_PRIVATE_KEY: undefined,
    VAPID_SUBJECT: undefined,
    ...overrides,
  }
}

// ctx.waitUntil in real Workers keeps the isolate alive until the promise
// settles, but doesn't block the response. Tests need explicit control:
// collect the promises so a test can `await flushWaitUntil(ctx)` after
// asserting on the immediate (cold-cache) response, to then assert on
// what the background fetch/write eventually did.
export function makeCtx() {
  const promises = []
  return {
    waitUntil(p) {
      promises.push(p)
    },
    _promises: promises,
  }
}

export async function flushWaitUntil(ctx) {
  await Promise.allSettled(ctx._promises)
}

export function makeRequest(path, { method = 'GET', body, headers } = {}) {
  const url = path.startsWith('http') ? path : `https://example.com${path}`
  const init = { method }
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    init.headers = { 'Content-Type': 'application/json', ...headers }
  } else if (headers) {
    init.headers = headers
  }
  return new Request(url, init)
}

export function urlFor(path) {
  return new URL(path.startsWith('http') ? path : `https://example.com${path}`)
}
