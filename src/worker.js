/**
 * worker.js — EyeWall Analytics Worker
 *
 * Thin router. Delegates to nhl.js and pwhl.js.
 * Entry points: scheduled (cron poll) and fetch (HTTP).
 *
 * Environment variables (set in Cloudflare Worker dashboard or wrangler.toml secrets):
 *   POLL_SECRET       — protects /poll manual trigger
 *   VAPID_PUBLIC_KEY  — Web Push VAPID public key
 *   VAPID_PRIVATE_KEY — Web Push VAPID private key
 *   VAPID_SUBJECT     — mailto: or https: identifier
 *   NHL_SEASON        — e.g. "20252026" (legacy manual flip — nhl.js/pwhl.js
 *                        internals still read their own hardcoded season
 *                        until the follow-up described in seasons.js lands;
 *                        GET /config/seasons is the live-resolved value)
 *
 * KV namespace binding: CACHE
 */

import { handleNHL, poll, refreshPPUnits } from './nhl.js';
import { handlePWHL, pollPWHL }             from './pwhl.js';
import { corsHeaders, json }                 from './shared.js';
import { getSeasonsConfig, refreshSeasonsCache } from './seasons.js';

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // Live-resolved current season for both leagues. Frontend and the
  // Python pipeline both read this instead of a hardcoded constant.
  // See seasons.js for resolution + fallback logic.
  if (url.pathname === '/config/seasons') {
    const config = await getSeasonsConfig(env);
    return json(config);
  }

  // Route PWHL endpoints
  if (url.pathname.startsWith('/pwhl/')) {
    return handlePWHL(request, env, ctx, url);
  }

  // Route everything else to NHL handler
  return handleNHL(request, env, ctx, url);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([
      poll(env, ctx),
      pollPWHL(env).catch(e => console.error('PWHL poll error:', e.message)),
      refreshPPUnits(env)
        .then(map => console.log(`PP units scheduled: ${Object.keys(map).length} teams`))
        .catch(e => console.error('PP units scheduled error:', e.message)),
      refreshSeasonsCache(env)
        .catch(e => console.error('Season cache refresh error:', e.message)),
    ]));
  },
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};
