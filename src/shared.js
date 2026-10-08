/**
 * shared.js — EyeWall Analytics Worker
 *
 * Shared constants, KV helpers, and response utilities used by all modules.
 */

export const SB_URL  = 'https://mqgasjzywoibdgxjjkux.supabase.co';
export const SB_ANON = 'sb_publishable_e_zwr1UA7GnHq4OuQSas5Q_kO8bQ_Ct';

export const HT_BASE = 'https://lscluster.hockeytech.com/feed/index.php';
export const HT_KEY  = '446521baf8c38984';
export const HT_HDR  = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.thepwhl.com/' };

// ── KV helpers ────────────────────────────────────────────────

export async function kvPut(env, key, value, ttl) {
  await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl });
}

// cacheTtl: how long this location may serve its edge copy before
// re-reading KV (Cloudflare's default is 60s, its minimum 30s).
export async function kvGet(env, key, { cacheTtl } = {}) {
  const raw = cacheTtl ? await env.CACHE.get(key, { cacheTtl }) : await env.CACHE.get(key);
  return raw ? JSON.parse(raw) : null;
}

// ── News-feed health tracking ────────────────────────────────
// Nothing recorded success/failure/timestamps for a news fetch before this
// (added 2026-09) -- fetch loops only console.log'd, ephemeral and
// unqueryable after the fact. A tester's "news feeds are notoriously
// difficult, can we monitor them" prompted this. One record per source
// (`health:<league>:<sourceId>`), updated after every fetch attempt --
// whether a direct RSS fetch (nhl.js/pwhl.js/ahl.js/echl.js's fetch*News())
// or a GitHub-Actions-fed /ingest route (atom blogs, nightly pipeline
// posts). Read by GET /admin/health (worker.js), gated to the app owner.
const HEALTH_TTL = 30 * 24 * 3600; // 30 days -- long enough that a source
// that's been silently dead for weeks still shows up as "stale", rather
// than the key just expiring and disappearing from the panel entirely.

export async function recordHealth(env, key, ok, meta = {}) {
  const now = new Date().toISOString();
  const prevKey = `health:${key}`;
  const prev = (await kvGet(env, prevKey)) || {};
  const next = {
    key,
    ...meta,
    lastAttemptAt: now,
    lastSuccessAt: ok ? now : (prev.lastSuccessAt || null),
    lastError: ok ? null : (meta.error || 'unknown error'),
    lastErrorAt: ok ? (prev.lastErrorAt || null) : now,
    consecutiveFailures: ok ? 0 : (prev.consecutiveFailures || 0) + 1,
  };
  await kvPut(env, prevKey, next, HEALTH_TTL);
}

// ── Admin auth ────────────────────────────────────────────────
// No admin/owner concept existed anywhere in this stack before this --
// only end-user magic-link sign-in (Session 90/91, eyewall-analytics).
// Rather than invent a new auth mechanism, this verifies the SAME
// Supabase session token the browser already holds by asking Supabase's
// own Auth API whose it is (no JWT secret/signature verification needed
// here, no new secret shipped to client JS either) and checks the email
// against an allowlist. Not exported with the token itself logged
// anywhere -- only the verified user object.
//
// Allowlist is env.ADMIN_EMAILS (comma-separated, set as a Worker secret)
// falling back to a single hardcoded default -- config like "who's an
// admin" shouldn't require a source change + deploy to update, but this
// still works with zero setup if that var is never configured.
const DEFAULT_ADMIN_EMAILS = ['matt@ehlers.io'];

export async function verifyAdminUser(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const allowlist = env.ADMIN_EMAILS
    ? env.ADMIN_EMAILS.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_ADMIN_EMAILS;
  try {
    const res = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SB_ANON, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const user = await res.json();
    if (!user?.email || !allowlist.includes(user.email.toLowerCase())) return null;
    return user;
  } catch {
    return null;
  }
}

// Derive 'pre' | 'live' | 'final' from a pwhl_game_log/ahl_game_log row.
// game_status_code (HockeyTech's numeric GameStatus, added Phase 6 --
// see eyewall-pipeline's docs/live_score_refresh_ddl.sql) is preferred
// when present: confirmed live that a not-yet-started game's game_state
// string is literally its scheduled clock time ("7:00PM"), not a state
// word, so string-matching alone can't reliably tell "scheduled" apart
// from an unrecognized live state. 1=scheduled, 4=final confirmed live;
// 2/3 unconfirmed (no in-progress game observed yet) -- treated as live
// rather than guessing the exact code. Falls back to the original
// string-matching approach for rows written before this column existed
// (or if the live-score-refresh job hasn't reached this game yet).
export function deriveGameStatus(gameRow) {
  if (!gameRow) return 'pre';
  const code = gameRow.game_status_code;
  if (code != null) {
    if (code === 4) return 'final';
    if (code === 1) return 'pre';
    return 'live';
  }
  const gs = (gameRow.game_state || '').toLowerCase();
  if (gs === 'final' || gs === 'official') return 'final';
  if (gs.includes('progress') || gs.includes('live') || gs.includes('intermission')) return 'live';
  return 'pre';
}

// ── HockeyTech live scorebar ──────────────────────────────────
// {league}_game_log's live columns (game_state, game_status_code, scores)
// are written by eyewall-pipeline's live-score-refresh.yml, a */5 GitHub
// schedule that GitHub actually fired every 3-6 hours on 2026-10-03/04 --
// so a finished AHL game kept reading "live" with a stale score for hours,
// and a game going live could go unseen. The Worker's per-minute cron now
// reads the same feed=modulekit&view=scorebar itself (+/-1 day, the window
// that job reads) and overlays it onto game_log rows; the pipeline job
// stays as the persistent backstop. Cached 60s under `{client}:scorebar`
// so the cron and every route share one HockeyTech call a minute.
//
// `ht`: { client, base, key, siteId, leagueId, headers }. Resolves to
// { [gameId]: { game_status_code, game_state, home_score, away_score } },
// or {} when the feed is unreachable (callers then use game_log as-is).
export async function fetchScorebar(env, ht) {
  const kvKey = `${ht.client}:scorebar`;
  const cached = await kvGet(env, kvKey);
  if (cached) return cached;
  try {
    const res = await fetch(
      `${ht.base}?feed=modulekit&view=scorebar&numberofdaysback=1&numberofdaysahead=1&limit=100` +
      `&league_id=${ht.leagueId}&key=${ht.key}&client_code=${ht.client}&site_id=${ht.siteId}&lang=en`,
      { headers: ht.headers }
    );
    if (!res.ok) return {};
    const games = (await res.json())?.SiteKit?.Scorebar;
    if (!Array.isArray(games)) return {};
    const map = {};
    for (const g of games) {
      const id = parseInt(g.ID, 10);
      if (!id) continue;
      const code = parseInt(g.GameStatus, 10);
      map[id] = {
        game_status_code: Number.isFinite(code) ? code : null,
        game_state:       g.GameStatusString || '',
        home_score:       parseInt(g.HomeGoals, 10) || 0,
        away_score:       parseInt(g.VisitorGoals, 10) || 0,
        // GameStatusString is plain "Final" whatever the ending; the long
        // form says "Final OT" / "Final SO".
        ended_in:         code === 4 ? endedInFromStatus(g.GameStatusStringLong) : null,
      };
    }
    await kvPut(env, kvKey, map, 60);
    return map;
  } catch {
    return {};
  }
}

// game_log rows with the scorebar's live columns laid over them. Skips the
// fetch when every row is already final -- the scorebar only ever moves a
// game toward final -- unless `withEndedIn`: the AHL/ECHL game_log may not
// carry ended_in, so a route that reports OT/SO for today's finals asks
// the scorebar anyway.
export async function withLiveScorebar(env, ht, rows, { withEndedIn = false } = {}) {
  if (!withEndedIn && !rows.some(r => deriveGameStatus(r) !== 'final')) return rows;
  const live = await fetchScorebar(env, ht);
  return rows.map(r => (live[r.game_id] ? { ...r, ...live[r.game_id] } : r));
}

// 'OT' | 'SO' | null from HockeyTech's long status text ("Final OT",
// "Final SO", "Final 2OT"); mirrors eyewall-pipeline's
// hockeytech_leagues.ended_in().
export function endedInFromStatus(status) {
  const words = String(status || '').toUpperCase().trim().split(/\s+/);
  if (words[0] !== 'FINAL') return null;
  if (words.includes('SO')) return 'SO';
  if (words.slice(1).some(w => w.endsWith('OT'))) return 'OT';
  return null;
}

// ── Live state written back to {league}_game_log (2026-10) ───────────
// The pipeline's live-score-refresh.yml was meant to keep game_log's live
// columns current every 5 min; GitHub ran it 3-4 times a day, so a game's
// final sat unrecorded for hours and /standings' streaks and /lastgame
// read it as unplayed (audit 2026-10-06 §4). The HockeyTech pollers now
// write the two moments that matter themselves -- puck drop and the final,
// once each, from the same gates that send those pushes -- with the same
// columns live-score-refresh writes. Needs SUPABASE_SERVICE_KEY (the
// anon key can't write); without it this logs once per game and skips.
// Never throws: a failed write must not cost the game's pushes.
export async function patchGameLog(env, table, gameId, fields) {
  if (!env.SUPABASE_SERVICE_KEY) {
    const logged = `gamelog:patch:no-key:${table}:${gameId}`;
    if (!(await env.CACHE.get(logged))) {
      console.warn(`[${table}] SUPABASE_SERVICE_KEY not set: not writing game ${gameId} back to game_log`);
      await kvPut(env, logged, true, 24 * 3600);
    }
    return false;
  }
  try {
    const res = await fetch(`${SB_URL}/rest/v1/${table}?game_id=eq.${gameId}`, {
      method: 'PATCH',
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(fields),
    });
    if (!res.ok) {
      console.warn(`[${table}] game ${gameId} PATCH failed: ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[${table}] game ${gameId} PATCH error: ${e.message}`);
    return false;
  }
}

// The puck-drop and final writes. `game` is the poller's row with the
// scorebar overlay (withLiveScorebar). AHL/ECHL game_log keeps OT/SO in
// `ended_in`; PWHL's in two booleans, `ot` and `shootout` -- the same
// columns each league's live refresh in eyewall-pipeline writes.
export function gameLogLiveFields(game) {
  return {
    home_score: game.home_score ?? 0,
    away_score: game.away_score ?? 0,
    game_state: 'Live',
    game_status_code: game.game_status_code ?? null,
  };
}

export function gameLogFinalFields(game, endedIn, { pwhl = false } = {}) {
  const base = {
    home_score: game.home_score ?? 0,
    away_score: game.away_score ?? 0,
    game_state: 'Final',
    game_status_code: 4,
  };
  return pwhl
    ? { ...base, ot: endedIn === 'OT', shootout: endedIn === 'SO' }
    : { ...base, ended_in: endedIn === 'OT' || endedIn === 'SO' ? endedIn : null };
}

// The label for a finished game in every league: 'Final' after regulation,
// 'Final/OT' or 'Final/SO' otherwise. `endedIn` is 'OT' | 'SO' | anything
// else (NHL's gameOutcome.lastPeriodType 'REG', null).
export function finalLabel(endedIn) {
  return endedIn === 'OT' || endedIn === 'SO' ? `Final/${endedIn}` : 'Final';
}

// ' (OT)' / ' (SO)' for a win headline, '' after regulation.
export function endedInSuffix(endedIn) {
  return endedIn === 'OT' || endedIn === 'SO' ? ` (${endedIn})` : '';
}

// ── NHL season end ────────────────────────────────────────────
// July 1 of a season's END year (e.g. '20252026' -> 2026-07-01): the NHL
// poll's "season over" cutoff, and the Worker's self-alert's notion of
// "in season" (ops.js). A deliberately generous buffer past the latest
// realistic Cup Final date -- only needs to be "safely after the season
// can still be running", not exact to the day. Moved here from nhl.js
// (2026-10) so ops.js can share it.
export function nhlSeasonEnd(seasonId) {
  const endYear = parseInt(String(seasonId).slice(4), 10) || (new Date().getFullYear() + 1);
  return new Date(`${endYear}-07-01`);
}

// ── Eastern-time date ─────────────────────────────────────────
// Today's date where the leagues live (YYYY-MM-DD), not the viewer's and
// not UTC: an 8pm PT game is still "today" at 04:00 UTC the next morning.
// Built from Intl parts. The old idiom parsed a localized string back
// with new Date(), so the result depended on the machine's own time zone
// and the engine's string parsing -- correct on Workers (UTC) by luck
// (Phase 0 follow-up, 2026-10-06).
const ET_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
export function etDateString(now = new Date()) {
  const parts = Object.fromEntries(ET_DATE_FORMAT.formatToParts(now.getTime()).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// 'YYYY-MM-DD' plus `days` calendar days.
export function addDaysToDateString(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// How far ahead a scoreboard ("today") route looks for the next game day
// when today has none: today plus the next 6 days, the window /nhl/today
// reads (the NHL schedule's gameWeek) and the AHL/ECHL scorebar's
// numberofdaysahead. Past it the scoreboard is empty rather than showing
// a game weeks away as the day's slate.
export const TODAY_LOOKAHEAD_DAYS = 6;

// ── Query params into PostgREST URLs (2026-10) ────────────────
// Every Supabase read here is a hand-built query string, and request
// params used to be interpolated into it raw. searchParams.get() decodes,
// so `?playerId=8478427%26select%3Dplayer_id` became `player_id=eq.8478427
// &select=player_id` and rewrote the route's own query (audit 2026-10-06
// Worker F5, verified live). sbParam() validates a param against its kind
// and URL-encodes it before interpolation; a value that doesn't fit is a
// 400 (ParamError, turned into a response by withParamErrors()).
//  - int:  digits only (ids, seasons, game types, limits)
//  - abbr: 2-4 letters (team abbreviations)
//  - id:   letters, digits and _ . : - (labels like '2025-26', slugs)
// An absent or empty param is null, so `sbParam(...) || default` keeps
// working the way `searchParams.get(...) || default` did.
export class ParamError extends Error {}

const SB_PARAM_PATTERNS = {
  int:  /^\d{1,15}$/,
  abbr: /^[A-Za-z]{2,4}$/,
  id:   /^[A-Za-z0-9_.:-]{1,64}$/,
};

export function sbParam(value, { type = 'id', name = 'parameter' } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const pattern = SB_PARAM_PATTERNS[type];
  if (!pattern) throw new Error(`sbParam: unknown type ${type}`);
  const s = String(value).trim();
  if (!pattern.test(s)) throw new ParamError(`invalid ${name}`);
  return encodeURIComponent(s);
}

// A comma-separated param (`seasons=20242025,20252026`), each item checked.
export function sbParamList(value, opts) {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean).map(v => sbParam(v, opts));
}

// Wraps a route handler so a ParamError thrown anywhere inside answers 400.
export function withParamErrors(handler) {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (e) {
      if (e instanceof ParamError) return badRequest(e.message);
      throw e;
    }
  };
}

// POLL_SECRET check in constant time: the loop always runs over the whole
// secret, whatever was sent, so response timing doesn't reveal how many
// leading characters matched. An unset secret never matches.
const SECRET_ENCODER = new TextEncoder();
export function secretMatches(provided, secret) {
  if (typeof secret !== 'string' || !secret || typeof provided !== 'string') return false;
  const a = SECRET_ENCODER.encode(provided);
  const b = SECRET_ENCODER.encode(secret);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

// ── Response helpers ──────────────────────────────────────────

// `maxAge` (seconds) sets the browser cache lifetime: pass the route's KV
// TTL. Without it the response gets withHttpCache()'s default.
export function json(val, { maxAge } = {}) {
  const headers = corsHeaders();
  if (maxAge != null) headers['Cache-Control'] = cacheControl(maxAge);
  return Response.json(val, { headers });
}

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export function unauthorized() {
  return new Response('Unauthorized', { status: 401 });
}

// JSON error body with CORS headers, e.g. errorJson(404, { error: 'Player not found' }).
export function errorJson(status, body) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() });
}

export function badRequest(msg) {
  return errorJson(400, { error: msg });
}

export function tooManyRequests() {
  return new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: corsHeaders() });
}

// Guards the billed AI-calling routes (/prediction/analyze, /summary/narrative,
// /pwhl/summary/narrative, /pwhl/scout) from unbounded public-cost abuse.
// Uses the Workers-native rate limiting binding rather than a shared secret:
// these routes are called directly from the public frontend, so a secret
// would ship in browser JS and protect nothing (see Session 48 findings).
// One binding, keyed by route+IP, gives each route its own budget.
export async function checkAiRateLimit(env, request, routeName) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await env.AI_ROUTE_LIMITER.limit({ key: `${routeName}:${ip}` });
  return success ? null : tooManyRequests();
}

// ── AI generation (OpenRouter) ──────────────────────────────────
// Shared by nhl.js and pwhl.js for every live/on-demand narrative route
// (11 call sites). Switched 2026-08 from Cloudflare Workers AI's native
// env.AI.run() binding (llama-3.1-8b-instruct-fp8-fast) to OpenRouter's
// google/gemma-4-26b-a4b-it -- see eyewall-pipeline's ai_client.py for the
// same swap and the full reasoning (real accuracy problems found in the
// old model via side-by-side testing against this app's actual prompts,
// and why OpenRouter rather than Cloudflare's own hosting of the same new
// model -- its default "thinking" mode burns the whole completion budget
// and returns empty content, with no working way found to disable it via
// Cloudflare's endpoint; OpenRouter's own reasoning:{enabled:false} works
// correctly against the same model, which is why it's sent below).
//
// Deliberately mirrors env.AI.run()'s exact call/return shape --
// {messages, max_tokens} in, {response: string} out -- so every call site
// only needed a one-line swap (function name), not a rewrite of its
// prompt-building or response-handling code. max_tokens stays snake_case
// (inconsistent with this file's camelCase convention) for the same
// reason: it's the literal field OpenRouter's API expects, and keeping it
// unchanged from the original env.AI.run() call sites is what makes the
// swap a true one-liner per site.
// ── French/English for on-demand AI text ──────────────────────
// The Worker's AI routes (/prediction/analyze, /pwhl/prediction) generate on
// demand, so they localize here rather than reading pipeline-written rows.
// FRENCH_INSTRUCTION mirrors eyewall-pipeline's ai_persona.py
// STICKS_SYSTEM_PROMPT_FR_ADDENDUM -- same Québécois hockey glossary, same
// rule that names and advanced-stat abbreviations stay untouched -- so a
// Worker-generated prediction reads like the pipeline's French rows.
// Keep the two in step.
export const FRENCH_INSTRUCTION = `Réponds ENTIÈREMENT en français canadien (québécois) — le français utilisé par les
commentateurs francophones de la LNH et de la LPHF. N'utilise aucun mot anglais, sauf
les noms propres (joueurs, équipes, villes) et les abréviations statistiques avancées
(xG, RAPM, WAR, GSAX, Corsi, Fenwick, CF%, FF%), qui doivent rester exactement comme
fournies dans les données.

Vocabulaire de hockey à utiliser (ne traduis pas ces termes autrement) :
- avantage numérique = power play · désavantage numérique = penalty kill
- échec avant = forecheck · échec arrière = backcheck
- tir au but = shot on goal · tir raté = missed shot · tir bloqué = blocked shot
- mise en échec = hit/check · mise au jeu = faceoff
- prolongation = overtime · fusillade = shootout
- gardien de but = goalie · défenseur = defenseman · attaquant = forward
- ailier = winger · centre = center (position) · recrue = rookie
- but = goal · aide / mention d'aide = assist · trio = forward line · paire = defense pair
- but en avantage numérique = power-play goal · but en désavantage numérique = shorthanded goal
- séries (éliminatoires) = playoffs · saison régulière = regular season

Les noms de joueurs, d'équipes et de villes ne doivent jamais être traduits ou modifiés.`;

// ?locale= -> 'fr' | 'en'. Anything missing or unrecognized is 'en', same
// posture as the pipeline-backed routes' inline locale handling.
export function requestLocale(url) {
  return url.searchParams.get('locale') === 'fr' ? 'fr' : 'en';
}

// Appends the French instruction for locale 'fr'; English prompts are
// returned unchanged.
export function localizePrompt(prompt, locale) {
  return locale === 'fr' ? `${prompt}\n\n${FRENCH_INSTRUCTION}` : prompt;
}

// Cache-key suffix: '' for English, so every English KV key (and the
// frontend's /cache/ lookups of them) stays exactly as it was.
export function localeKeySuffix(locale) {
  return locale === 'fr' ? ':fr' : '';
}

// A slow upstream used to hold the request (and, from generateGameSummary,
// the cron tick) until the platform killed it (audit 2026-10-06 Worker F7).
export const AI_TIMEOUT_MS = 25000;

export async function generateText(env, { messages, max_tokens = 1024 } = {}) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    headers: {
      'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'google/gemma-4-26b-a4b-it',
      messages,
      max_tokens,
      reasoning: { enabled: false },
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
  const data = await res.json();
  return { response: data?.choices?.[0]?.message?.content ?? '' };
}

// 502 for a failed Supabase read. With no status, several reads failed
// together (a route that needs all of them).
export function sbError(status) {
  return errorJson(502, { error: status == null ? 'Supabase error' : `Supabase ${status}` });
}

// ── Route-handler helpers ─────────────────────────────────────

// Supabase GET. Resolves to the parsed rows, or to sbError(status) -- a
// Response the route returns as-is. `headers` are added to the auth headers
// (e.g. Range for paging past the 1,000-row cap).
export async function sbRows(url, headers = {}) {
  const res = await fetch(url, { headers: { ...sbHeaders(), ...headers } });
  if (!res.ok) return sbError(res.status);
  return res.json();
}

// sbRows for an optional read: `fallback` instead of an error.
export async function sbRowsOr(url, fallback) {
  const rows = await sbRows(url);
  return rows instanceof Response ? fallback : rows;
}

// sbRows for a table the pipeline adds by an owner-run migration, which
// may not exist yet. PostgREST answers a missing table with 404 (PGRST205)
// and a filter or select on a column it doesn't have with 400 (PGRST204 /
// 42703): both resolve to null ("no such table yet"), so a route can serve
// its empty shape instead of a 502. Any other failure is sbError(status).
export async function sbRowsIfTable(url, headers = {}) {
  const res = await fetch(url, { headers: { ...sbHeaders(), ...headers } });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) return sbError(res.status);
  return res.json();
}

// {ahl,echl,pwhl}_players.on_roster (eyewall-pipeline, 2026-10): the
// nightly roster ingest sets it true for players on their team's roster feed
// and false for the team's other rows (released, sent down, traded but not
// yet moved). Roster lists hide only false, so a never-marked (null) row
// still shows.
export const ON_ROSTER_FILTER = 'on_roster=not.is.false';

// sbRows for a team roster read (`url` already has a query string), minus
// players marked off the roster. Until the owner adds the column PostgREST
// rejects the filter (400); then, or on any other failure of the filtered
// read, this is the unfiltered read.
export async function sbRosterRows(url) {
  const rows = await sbRows(`${url}&${ON_ROSTER_FILTER}`);
  return rows instanceof Response ? sbRows(url) : rows;
}

// Serve `key` from KV, or run build(), cache its result and serve it.
// build() may return a Response instead (an error, a 404, a deliberately
// uncached null), which goes back as-is and uncached. `ttl` is seconds, or
// a function of the built data.
// The browser may keep the response as long as KV does (`max-age` = the
// TTL, see cacheControl()).
export async function cachedJson(env, key, ttl, build) {
  const ttlFor = data => (typeof ttl === 'function' ? ttl(data) : ttl);
  const cached = await kvGet(env, key);
  if (cached) return json(cached, { maxAge: ttlFor(cached) });
  const data = await build();
  if (data instanceof Response) return data;
  const seconds = ttlFor(data);
  await kvPut(env, key, data, seconds);
  return json(data, { maxAge: seconds });
}

// cachedJson() for a per-game view that keeps changing until the game is
// final (HockeyTech's gameSummary: periods, shots, three stars). A final
// copy is kept `finalTtl` seconds under `${key}:final`; until then the copy
// lives `liveTtl` seconds under `${key}:live`, so a copy cached mid-game is
// never served once the game is final. `isFinal()` is only asked when no
// final copy is cached, so a final game costs one KV read. KV's minimum TTL
// is 60s.
export const GAME_LIVE_TTL = 60;
export async function cachedUntilFinal(env, key, { isFinal, build, finalTtl, liveTtl = GAME_LIVE_TTL }) {
  const finalKey = `${key}:final`;
  const cached = await kvGet(env, finalKey);
  if (cached) return json(cached, { maxAge: finalTtl });
  const final = await isFinal();
  return cachedJson(env, final ? finalKey : `${key}:live`, final ? finalTtl : liveTtl, build);
}

// ── HTTP caching (audit 2026-10-06 §5) ───────────────────────
// Every GET JSON response carries `Cache-Control: public, max-age=N` and a
// weak ETag, so the browser reuses a response for N seconds and then
// revalidates it with If-None-Match (304, no body) instead of downloading
// it again. N is the route's KV TTL (json()'s `maxAge`, which cachedJson()
// fills in), capped at MAX_MAX_AGE; a route with no KV cache of its own
// gets DEFAULT_MAX_AGE. Live-game routes (LIVE_PATHS) are capped at
// LIVE_MAX_AGE whatever they ask for. POST/DELETE, errors, owner calls
// (`secret=`, `force=`, an Authorization header) are `no-store`.
export const DEFAULT_MAX_AGE = 30;
// One hour at most. A KV entry is served with its full TTL even when it
// expires a minute later, so a 24-hour max-age could leave a device a day
// behind a /cache/bust or a nightly run; past an hour the ETag makes the
// revalidation cheap anyway.
export const MAX_MAX_AGE = 3600;
// The app polls a live game every 10 s. Freshness is judged against the
// response's second-granularity Date header, so a max-age equal to the
// poll interval can still let the browser answer a poll with the previous
// copy; half the interval leaves no such window.
export const LIVE_MAX_AGE = 5;

// Matched against the decoded path (the app sends /cache/schedule%3ACAR%3A...).
const LIVE_PATHS = [
  /^\/nhl\/today$/,
  /^\/(pwhl|ahl|echl)\/today$/,
  /^\/(pwhl|ahl|echl)\/live\//,
  // AHL/ECHL schedules carry the live scorebar's scores (hockeytech.js live()).
  /^\/(ahl|echl)\/schedule$/,
  /^\/cache\/(pbp|boxscore|schedule):/,
];

export function cacheControl(maxAge) {
  const seconds = Math.max(0, Math.min(Math.floor(Number(maxAge) || 0), MAX_MAX_AGE));
  return `public, max-age=${seconds}`;
}

export function isLivePath(pathname) {
  let path = pathname;
  try { path = decodeURIComponent(pathname); } catch { /* keep it raw */ }
  return LIVE_PATHS.some(re => re.test(path));
}

const ETAG_ENCODER = new TextEncoder();
export async function weakEtag(body) {
  const digest = await crypto.subtle.digest('SHA-1', ETAG_ENCODER.encode(body));
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `W/"${hex}"`;
}

// If-None-Match uses weak comparison: W/"x" and "x" match.
function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch) return false;
  const bare = t => t.trim().replace(/^W\//, '');
  return ifNoneMatch.split(',').some(t => t.trim() === '*' || bare(t) === bare(etag));
}

function noStore(request, res, url) {
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') return true;
  if (res.status >= 400) return true;
  return url.searchParams.has('secret') || url.searchParams.has('force') || request.headers.has('Authorization');
}

// Sets the caching headers on one response (see above). OPTIONS and
// WebSocket upgrades pass through untouched.
export async function applyHttpCache(request, res) {
  // (A consumed body can't be re-wrapped; only a test double does that.)
  if (!(res instanceof Response) || res.webSocket || res.bodyUsed || request.method === 'OPTIONS') return res;
  const url = new URL(request.url);
  const headers = new Headers(res.headers);
  const init = status => ({ status, statusText: res.statusText, headers });

  if (noStore(request, res, url)) {
    headers.set('Cache-Control', 'no-store');
    return new Response(res.body, init(res.status));
  }
  const isJson = (headers.get('Content-Type') || '').includes('application/json');
  if (res.status !== 200 || !isJson) return new Response(res.body, init(res.status));

  const live = isLivePath(url.pathname);
  const current = headers.get('Cache-Control');
  if (!current) {
    headers.set('Cache-Control', cacheControl(live ? LIVE_MAX_AGE : DEFAULT_MAX_AGE));
  } else if (live) {
    const m = current.match(/max-age=(\d+)/);
    if (!m || Number(m[1]) > LIVE_MAX_AGE) headers.set('Cache-Control', cacheControl(LIVE_MAX_AGE));
  }
  if (request.method !== 'GET') return new Response(res.body, init(res.status));

  const body = await res.text();
  const etag = await weakEtag(body);
  headers.set('ETag', etag);
  if (etagMatches(request.headers.get('If-None-Match'), etag)) {
    headers.delete('Content-Type');
    headers.delete('Content-Length');
    return new Response(null, init(304));
  }
  return new Response(body, init(200));
}

export function withHttpCache(handler) {
  return async (request, ...rest) => applyHttpCache(request, await handler(request, ...rest));
}

// ── JSONP unwrap ──────────────────────────────────────────────
// HockeyTech responses are wrapped in parens: ([...])

export function unwrapJsonp(text) {
  text = text.trim();
  if (text.startsWith('(')) text = text.slice(1, text.lastIndexOf(')'));
  return JSON.parse(text);
}

// ── HockeyTech view=player table parsers ─────────────────────
// Moved here from pwhl.js (originally PWHL-only) since AHL's ahl.js needs
// the exact same parsers for its own /ahl/player/career route -- these are
// generic parsers over HockeyTech's standard sections[].data[].row table
// shape (view=player's careerStats/draftInfo/gameByGame all use it), with
// zero PWHL-specific field names or assumptions. Confirmed live 2026-08-29
// that AHL's view=player response uses the identical shape (careerStats
// Regular Season/Playoffs sections each end in a season_name: 'Total' row,
// info.bio is the same <ul><li> HTML, media.images[] has the same
// is_primary convention).

// Pulls the server-computed "Total" row out of one careerStats section
// (view=player's Regular Season / Playoffs split), coercing HockeyTech's
// stringified numeric fields (e.g. "16.9") to real numbers and dropping
// season_name/team_name, which don't apply to an aggregate row. Returns
// null if the player has no rows in that section at all (e.g. hasn't made
// the playoffs yet) -- callers must not assume both sections exist.
export function extractCareerTotal(sections, title) {
  const section = (sections || []).find(s => s.title === title);
  const totalItem = (section?.data || []).find(item => item.row?.season_name === 'Total');
  if (!totalItem) return null;

  const out = {};
  for (const [k, v] of Object.entries(totalItem.row)) {
    if (k === 'season_name' || k === 'team_name') continue;
    const n = typeof v === 'string' ? Number(v) : v;
    out[k] = typeof v === 'string' && v !== '' && !Number.isNaN(n) ? n : v;
  }
  return out;
}

// Generalizes extractCareerTotal to return EVERY row in a titled section
// (not just the one matching season_name === 'Total'), same numeric-string
// coercion. Used for draftInfo/gameByGame -- both are the same HockeyTech
// sections[].data[].row table shape as careerStats, just with a blank
// section title ('') rather than 'Regular Season'/'Playoffs'.
export function extractRows(sections, title) {
  const section = (sections || []).find(s => s.title === title);
  return (section?.data || []).map(item => {
    const out = {};
    for (const [k, v] of Object.entries(item.row || {})) {
      const n = typeof v === 'string' ? Number(v) : v;
      out[k] = typeof v === 'string' && v !== '' && !Number.isNaN(n) ? n : v;
    }
    return out;
  });
}

// info.bio is HockeyTech's own CMS content, consistently a
// <ul><li><p>text</p></li></ul> block of career-highlight bullets in every
// real response seen. Extracted server-side into plain strings rather than
// ever sending raw HTML to the frontend -- this repo has no HTML-
// sanitization tooling and no dangerouslySetInnerHTML precedent, so this
// is the one place that content gets neutralized.
const HTML_ENTITIES = { nbsp: ' ', amp: '&', quot: '"', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', mdash: '—', ndash: '–' };
function decodeHtmlEntities(s) {
  return s
    .replace(/&([a-z]+);/gi, (m, name) => HTML_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (m, code) => String.fromCharCode(parseInt(code, 10)));
}
export function extractBioPoints(html) {
  if (!html) return [];
  const items = html.match(/<li>[\s\S]*?<\/li>/gi) || [];
  return items
    .map(li => decodeHtmlEntities(li.replace(/<[^>]+>/g, '')).trim())
    .filter(Boolean);
}

// media.images[] is a photo gallery; is_primary ('1'/'0', a string per
// HockeyTech convention) flags the one to show, falling back to the first
// entry if none is flagged (seen in practice: single-photo players).
export function extractPhoto(images) {
  const primary = (images || []).find(img => img.is_primary === '1') || (images || [])[0];
  if (!primary?.url) return null;
  return {
    url:    primary.url,
    width:  primary.width  != null ? parseInt(primary.width, 10)  : null,
    height: primary.height != null ? parseInt(primary.height, 10) : null,
  };
}

// ── Supabase headers factory ──────────────────────────────────

export function sbHeaders() {
  return { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` };
}

// ── RSS/news parser helpers ─────────────────────────────────

export function extractTag(str, tag) {
  const re1 = new RegExp('<' + tag + '[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/' + tag + '>');
  const re2 = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>');
  const m = str.match(re1) || str.match(re2);
  return m ? m[1].trim() : '';
}

export function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, ' ')          // remove tags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/\s+/g, ' ')
    .trim();
}

export function safeId(sourceId, link) {
  // Hash the FULL link, not a truncated prefix of it -- a truncated
  // base64 prefix (the previous approach, "12 chars was too short" fixed
  // by widening to 32) still collides whenever two article URLs share a
  // long common path prefix: confirmed live 2026-08-29 against theahl.com's
  // own RSS feed, which republishes NHL.com's "32 in 32" prospect series --
  // those URLs are identical for well past the first 32 base64 characters,
  // so every article in that series produced the same id and collapsed to
  // one row after dedup. A full-string hash has no such blind spot.
  let h = 0;
  for (let i = 0; i < link.length; i++) h = (Math.imul(31, h) + link.charCodeAt(i)) | 0;
  return sourceId + '-' + Math.abs(h).toString(36);
}

// Two different pieces of code independently mint news-item ids from the
// same article link -- this Worker's own safeId() above (a JS rolling
// hash), and eyewall-pipeline's echl_news.py/ahl_news.py/pwhl_news.py
// (Python's hashlib.md5). Same article, different id, so an id-only dedupe
// (as every news merge used to do) let both copies of the same story
// through whenever the nightly pipeline ingest and this Worker's own live
// fetch both picked it up -- confirmed live as the ECHL "duplicate story"
// bug reported 2026-09. Comparing normalized links closes that gap without
// having to keep two languages' hash functions in sync.
export function normalizeLink(url) {
  if (!url) return '';
  return url.trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

// ── RSS/ESPN news parsers (used by NHL and PWHL news fetchers) ──

export function parseRSS(xml, source) {
  const items = [];
  const chunks = xml.split('<item');
  // 30, not 11 -- team-filtered league-wide sources (Athletic, Bleacher
  // Report) need a wider window before filtering or a specific team's
  // news is rarely in the raw feed's first 11 items at all (Session:
  // news ingestion investigation, most sources otherwise near-zero yield
  // per team most cycles).
  for (const chunk of chunks.slice(1, 31)) {
    const title   = stripHtml(extractTag(chunk, 'title'));
    // Try <link> plain, then <guid>, then link href attr
    const linkM   = chunk.match(/<link>([^<]+)<\/link>/) ||
                    chunk.match(/<guid[^>]*>([^<]+)<\/guid>/) ||
                    chunk.match(/<link[^>]+href="([^"]+)"/);
    const link    = linkM ? linkM[1].trim() : '';
    const rawDesc = extractTag(chunk, 'description') || extractTag(chunk, 'summary');
    const desc    = stripHtml(rawDesc).slice(0, 200);
    const pubDate = extractTag(chunk, 'pubDate') || extractTag(chunk, 'published');
    if (!title || !link) continue;
    if (source.filter) {
      const re = new RegExp(source.filter, 'i');
      if (!re.test(title) && !re.test(desc)) continue;
    }
    let publishedAt;
    try { publishedAt = new Date(pubDate).toISOString(); } catch { publishedAt = new Date().toISOString(); }
    items.push({
      id:          safeId(source.id, link),
      source:      source.id,
      sourceName:  source.name,
      sourceColor: source.color,
      title,
      excerpt:     desc,
      url:         link,
      publishedAt,
      imageUrl:    null,
    });
  }
  return items;
}

// Parse ESPN RSS — uses <guid> as the canonical URL

// Parse Sportsnet RSS — uses <headline> for title and CDATA <link>
export function parseSportsnet(xml, source) {
  const items = [];
  const chunks = xml.split('<item');
  for (const chunk of chunks.slice(1, 50)) {
    // Sportsnet uses <headline> not <title> for article headlines
    const headline = stripHtml(extractTag(chunk, 'headline') || extractTag(chunk, 'title'));
    if (!headline || headline.trim().length < 5) continue;
    // Link is in CDATA
    const rawLink = extractTag(chunk, 'link');
    const link    = rawLink.trim();
    const rawDesc = extractTag(chunk, 'description') || extractTag(chunk, 'summary');
    const desc    = stripHtml(rawDesc).slice(0, 200);
    const pubDate = extractTag(chunk, 'pubDate') || extractTag(chunk, 'dc:date');
    if (!link || !link.startsWith('http')) continue;
    // Apply filter
    if (source.filter) {
      const re = new RegExp(source.filter, 'i');
      if (!re.test(headline) && !re.test(desc)) continue;
    }
    let publishedAt;
    try { publishedAt = new Date(pubDate).toISOString(); } catch { publishedAt = new Date().toISOString(); }
    items.push({
      id:          safeId(source.id, link),
      source:      source.id,
      sourceName:  source.name,
      sourceColor: source.color,
      title:       headline,
      excerpt:     desc,
      url:         link,
      publishedAt,
      imageUrl:    null,
    });
  }
  return items;
}

// Parse Google News RSS
export function parseGoogleNews(xml, source) {
  const items = [];
  const chunks = xml.split('<item');
  for (const chunk of chunks.slice(1, 15)) {
    const rawTitle = extractTag(chunk, 'title');
    // Google News appends " - Outlet Name" to titles — strip it
    let title = stripHtml(rawTitle);
    const dashIdx = title.lastIndexOf(' - ');
    let outlet = '';
    if (dashIdx > 20) {
      outlet = title.slice(dashIdx + 3).trim();
      title  = title.slice(0, dashIdx).trim();
    }
    // Also try <source> tag
    const sourceM = chunk.match(/<source[^>]*>([^<]+)<\/source>/);
    if (sourceM) outlet = sourceM[1].trim();

    // Link is a Google redirect — extract from <link> after </title>
    const linkM = chunk.match(/<link>([^<]+)<\/link>/) ||
                  chunk.match(/<guid[^>]*>([^<]+)<\/guid>/);
    const link  = linkM ? linkM[1].trim() : '';
    const pubDate = extractTag(chunk, 'pubDate');
    if (!title || !link) continue;
    let publishedAt;
    try { publishedAt = new Date(pubDate).toISOString(); } catch { publishedAt = new Date().toISOString(); }
    items.push({
      id:          safeId(source.id, link),
      source:      source.id,
      sourceName:  outlet || source.name,
      sourceColor: outlet ? '#555555' : source.color,
      title,
      excerpt:     outlet,
      url:         link,
      publishedAt,
      imageUrl:    null,
    });
  }
  return items;
}

export function parseESPN(xml, source) {
  const items = [];
  // ESPN: <link> appears right after <item> opening before <title>
  // Split on '<item>' (with closing >) to capture the link at start of chunk
  const chunks = xml.split('<item>');
  for (const chunk of chunks.slice(1, 31)) {
    const title   = stripHtml(extractTag(chunk, 'title'));
    // ESPN link is the first URL in the chunk — appears before <title>
    // Clean a URL by removing RSS CDATA artifacts
    const cleanUrl = u => u ? u.replace(/\]\]>.*$/, '').replace(/[\]>]+$/, '').trim() : '';
    const guidM   = chunk.match(/<guid[^>]*>([^<]+)<\/guid>/);
    const linkM   = chunk.match(/<link>([^<]+)<\/link>/);
    const rawLink = extractTag(chunk, 'link') || extractTag(chunk, 'guid') || guidM?.[1] || linkM?.[1] || '';
    const link    = cleanUrl(rawLink);
    const rawDesc = extractTag(chunk, 'description');
    const desc    = stripHtml(rawDesc).slice(0, 200);
    const pubDate = extractTag(chunk, 'pubDate');
    if (!title || !link) continue;
    let publishedAt;
    try { publishedAt = new Date(pubDate).toISOString(); } catch { publishedAt = new Date().toISOString(); }
    items.push({
      id:          safeId(source.id, link),
      source:      source.id,
      sourceName:  source.name,
      sourceColor: source.color,
      title,
      excerpt:     desc,
      url:         link,
      publishedAt,
      imageUrl:    null,
    });
  }
  return items;
}

// Parse Atom <entry> feeds (Canes Country uses Atom)

export function parseAtom(xml, source) {
  const items = [];
  const chunks = xml.split(/<entry[\s>]/);
  for (const chunk of chunks.slice(1, 31)) {
    const title   = stripHtml(extractTag(chunk, 'title'));
    const linkM   = chunk.match(/<link[^>]+href="([^"]+)"[^>]*\/>/i) ||
                    chunk.match(/<link[^>]+href="([^"]+)"/i);
    const link    = linkM ? linkM[1].trim() : '';
    const rawDesc = extractTag(chunk, 'summary') || extractTag(chunk, 'content');
    const desc    = stripHtml(rawDesc).slice(0, 200);
    const pubDate = extractTag(chunk, 'published') || extractTag(chunk, 'updated');
    if (!title || !link) continue;
    let publishedAt;
    try { publishedAt = new Date(pubDate).toISOString(); } catch { publishedAt = new Date().toISOString(); }
    items.push({
      id:          safeId(source.id, link),
      source:      source.id,
      sourceName:  source.name,
      sourceColor: source.color,
      title,
      excerpt:     desc,
      url:         link,
      publishedAt,
      imageUrl:    null,
    });
  }
  return items;
}


export function parseNHLNews(data) {
  // NHL club-news returns { items: [...] } or { items: [] } off-season
  const items = data?.items || data?.content || [];
  if (!items.length) {
    console.log('News: nhl returned empty items array, keys:', Object.keys(data || {}));
    return [];
  }
  return items.slice(0, 8).map(item => ({
    id:          `nhl-${item.slug || item.id || Math.random().toString(36).slice(2)}`,
    source:      'nhl',
    sourceName:  'NHL.com',
    sourceColor: '#000000',
    title:       item.headline || item.title || '',
    excerpt:     (item.preview || item.summary || item.description || '').slice(0, 180),
    url:         item.webUrl || item.shareUrl || `https://www.nhl.com/hurricanes/news/${item.slug}`,
    publishedAt: item.publishedTime || item.date || new Date().toISOString(),
    imageUrl:    item.thumbnail?.thumbnailUrl || item.images?.[0]?.url || null,
  })).filter(a => a.title);
}

// ── VAPID / Web Push ─────────────────────────────────────────

// ── VAPID / Web Push ──────────────────────────────────────────

export function base64urlToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const b   = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...b].map(c => c.charCodeAt(0)));
}

export function uint8ArrayToBase64url(arr) {
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function buildVAPIDAuthHeader(endpoint, env) {
  const audience = new URL(endpoint).origin;
  const now      = Math.floor(Date.now() / 1000);

  // Build JWT header + payload
  const header  = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: now + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'mailto:admin@eyewallanalytics.com',
  };

  const enc    = s => uint8ArrayToBase64url(new TextEncoder().encode(JSON.stringify(s)));
  const toSign = `${enc(header)}.${enc(payload)}`;

  // Import private key via JWK.
  // VAPID_PRIVATE_KEY = base64url raw scalar (d).
  // VAPID_PUBLIC_KEY  = base64url uncompressed EC point (0x04 || x || y, 65 bytes).
  const pubBytes = base64urlToUint8Array(env.VAPID_PUBLIC_KEY);
  // pubBytes[0] = 0x04 (uncompressed), then 32 bytes x, 32 bytes y
  const x = uint8ArrayToBase64url(pubBytes.slice(1, 33));
  const y = uint8ArrayToBase64url(pubBytes.slice(33, 65));

  const privKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE_KEY, x, y, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privKey,
    new TextEncoder().encode(toSign)
  );

  const jwt = `${toSign}.${uint8ArrayToBase64url(new Uint8Array(sig))}`;
  return `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`;
}

// ── RFC 8291 Web Push encryption ─────────────────────────────
// Encrypts notification payload per RFC 8291 (aes128gcm) so the
// service worker can read e.data.json() directly — no KV fetch needed.

export async function encryptPushPayload(sub, payloadObj) {
  const plaintext = new TextEncoder().encode(JSON.stringify(payloadObj));

  // Decode subscription keys
  const p256dh = base64urlToUint8Array(sub.keys.p256dh);
  const auth   = base64urlToUint8Array(sub.keys.auth);

  // Generate ephemeral ECDH key pair
  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
  );

  // Import receiver's public key (p256dh)
  const receiverKey = await crypto.subtle.importKey(
    'raw', p256dh, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );

  // Derive shared ECDH secret
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: receiverKey }, ephemeral.privateKey, 256
  );

  // Export ephemeral public key (uncompressed, 65 bytes)
  const ephPub = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));

  // Salt: 16 random bytes
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // HKDF-SHA-256 for PRK using auth secret
  // PRK = HKDF-Extract(auth, IKM=sharedSecret)
  const ikmKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey', 'deriveBits']);

  // auth_info = "WebPush: info " || receiverKey || senderKey
  const authInfo = new Uint8Array([
    ...new TextEncoder().encode('WebPush: info '),
    ...p256dh, ...ephPub
  ]);

  // PRK_key = HKDF(salt=auth, IKM=sharedBits, info=authInfo, length=32)
  const prkBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: auth, info: authInfo }, ikmKey, 256
  );

  const prkKey = await crypto.subtle.importKey('raw', prkBits, 'HKDF', false, ['deriveBits']);

  // CEK = HKDF(salt=salt, IKM=PRK, info="Content-Encoding: aes128gcm ", length=16)
  const cekInfo = new TextEncoder().encode('Content-Encoding: aes128gcm ');
  const cekBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: cekInfo }, prkKey, 128
  );

  // Nonce = HKDF(salt=salt, IKM=PRK, info="Content-Encoding: nonce ", length=12)
  const nonceInfo = new TextEncoder().encode('Content-Encoding: nonce ');
  const nonceBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: nonceInfo }, prkKey, 96
  );

  // Encrypt with AES-128-GCM
  const cekAes = await crypto.subtle.importKey('raw', cekBits, 'AES-GCM', false, ['encrypt']);

  // Padding: plaintext || 0x02 (delimiter)
  const padded = new Uint8Array([...plaintext, 0x02]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonceBits }, cekAes, padded
  ));

  // aes128gcm content header: salt(16) || rs(4) || idlen(1) || keyid(ephPub, 65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false); // record size big-endian
  const header = new Uint8Array([...salt, ...rs, ephPub.length, ...ephPub]);

  // Final body = header || ciphertext
  const body = new Uint8Array([...header, ...ciphertext]);
  return body;
}

// Stable per-subscriber identifier for dedup/pruning, regardless of
// platform: Web Push subs are keyed by `endpoint`, native iOS subs (see
// sendAPNsPush below) by `token` -- callers that need to prune an expired
// subscriber from `push:subs` must match on whichever one the sub actually
// has, not assume `endpoint` unconditionally.
export function subId(sub) {
  return sub.token || sub.endpoint;
}

// ── Who gets a team's alert ───────────────────────────────────
// A subscription follows one or more teams, each with its own alert
// choices: `teams: [{ key: 'NHL:CAR', prefs }]` in the user's order,
// primary first (eyewall-analytics' followed teams, 2026-09). Older
// subscriptions -- and app versions still installed -- have a single
// `teamAbbr` + `prefs`, read here as a one-team list.
export function subTeams(sub) {
  if (Array.isArray(sub.teams) && sub.teams.length) return sub.teams;
  return [{ key: sub.teamAbbr || 'NHL:CAR', prefs: sub.prefs || null }];
}

// The subscribers who get `teamKey`'s `eventType` alert. `pair` is the
// game's two team keys when known: someone following both teams gets
// each alert once, from the side of whichever is higher in their list,
// rather than one copy per team.
export function pushTargets(subs, teamKey, eventType, pair) {
  const opponentKey = pair?.find(k => k !== teamKey);
  return subs.filter(s => {
    const teams = subTeams(s);
    const i = teams.findIndex(t => t.key === teamKey);
    if (i < 0) return false;
    if (opponentKey) {
      const j = teams.findIndex(t => t.key === opponentKey);
      if (j >= 0 && j < i) return false;
    }
    const prefs = teams[i].prefs;
    return !prefs || prefs[eventType] !== false; // a type not mentioned is on
  });
}

// ── Recent alerts (the app's notifications bell) ──────────────
// Every alert the pollers send is kept, per league, for the app's bell
// to list whether or not the user has push on. Collected in memory during
// a cron run and written once per league at its end (flushAlertLog), not
// once per alert: a busy night is hundreds of alerts.
export const ALERT_LOG_HOURS = 72;
const ALERT_LOG_MAX = 400;
const alertLogKey = league => `alerts:recent:${league}`;
let pendingAlerts = [];

export function recordAlert(teamKey, eventType, payload, pair, at = Date.now()) {
  if (!teamKey || !payload?.title) return;
  pendingAlerts.push({
    team: teamKey,
    vs: pair?.find(k => k !== teamKey) || null,
    type: eventType || null,
    title: payload.title,
    body: payload.body || '',
    url: payload.url || '/',
    at,
  });
}

// Pure: a league's stored list plus new alerts, oldest dropped.
export function mergeAlertLog(stored, added, now = Date.now()) {
  const since = now - ALERT_LOG_HOURS * 3600 * 1000;
  return [...(stored || []), ...added].filter(a => a.at >= since).slice(-ALERT_LOG_MAX);
}

export async function flushAlertLog(env) {
  const batch = pendingAlerts;
  pendingAlerts = [];
  const byLeague = new Map();
  for (const a of batch) {
    const league = a.team.split(':')[0];
    byLeague.set(league, [...(byLeague.get(league) || []), a]);
  }
  for (const [league, added] of byLeague) {
    try {
      const stored = (await kvGet(env, alertLogKey(league))) || [];
      await kvPut(env, alertLogKey(league), mergeAlertLog(stored, added), (ALERT_LOG_HOURS + 24) * 3600);
    } catch (e) {
      console.warn(`alert log ${league}: ${e.message}`);
    }
  }
}

// The recent alerts for `teamKeys` (LEAGUE:ABBR), newest first.
export async function readAlertLog(env, teamKeys, limit = 50) {
  const wanted = new Set(teamKeys);
  const leagues = [...new Set(teamKeys.map(k => k.split(':')[0]))];
  const lists = await Promise.all(leagues.map(l => kvGet(env, alertLogKey(l)).catch(() => null)));
  const since = Date.now() - ALERT_LOG_HOURS * 3600 * 1000;
  return lists.flat().filter(a => a && wanted.has(a.team) && a.at >= since)
    .sort((a, b) => b.at - a.at).slice(0, limit);
}

// Sends `payload` to pushTargets() and prunes subscriptions the push
// service says are gone. Shared by the NHL, PWHL and AHL/ECHL pollers.
// `send` is the caller's own sendPush import, so a test that mocks
// shared.js's sendPush export still catches every send.
export async function broadcastToTeam(env, payload, teamKey, eventType, { pair, tag = 'push', send = sendPush } = {}) {
  // Kept for the bell whether or not anyone is subscribed.
  recordAlert(teamKey, eventType, payload, pair);
  const subs = (await kvGet(env, 'push:subs')) || [];
  if (!subs.length) return;
  const targets = pushTargets(subs, teamKey, eventType, pair);
  console.log(`[${tag}] ${targets.length}/${subs.length} targets for ${teamKey}:${eventType}`);
  if (!targets.length) return;

  const results = await Promise.all(targets.map(s => send(s, payload, env)));

  // subId() covers both Web Push (endpoint-keyed) and native iOS
  // (token-keyed) subscribers. Re-read before writing, as the others did.
  const expiredIds = new Set(targets.filter((_, i) => results[i] === 'expired').map(subId));
  if (expiredIds.size > 0) {
    const allSubs = (await kvGet(env, 'push:subs')) || [];
    await kvPut(env, 'push:subs', allSubs.filter(s => !expiredIds.has(subId(s))), 365 * 24 * 3600);
    console.log(`[${tag}] removed ${expiredIds.size} expired subscription(s)`);
  }
  console.log(`[${tag}] results: ${results.join(', ')}`);
}

// Send a Web Push notification with encrypted payload (RFC 8291).
// Service worker reads e.data.json() — no KV fetch needed.
export async function sendPush(sub, payload, env) {
  if (sub.platform === 'ios') return sendAPNsPush(sub, payload, env);
  try {
    const auth = await buildVAPIDAuthHeader(sub.endpoint, env);

    let body, headers;
    if (sub.keys?.p256dh && sub.keys?.auth) {
      // Send encrypted payload
      const encrypted = await encryptPushPayload(sub, payload);
      body    = encrypted;
      headers = {
        'Authorization':   auth,
        'Content-Type':    'application/octet-stream',
        'Content-Encoding':'aes128gcm',
        'TTL':             '60',
      };
    } else {
      // No keys — send payloadless push (SW will show generic notification)
      body    = null;
      headers = { 'Authorization': auth, 'TTL': '60', 'Content-Length': '0' };
    }

    const res = await fetch(sub.endpoint, { method: 'POST', headers, body });

    const status = res.status;
    const resBody = await res.text().catch(() => '');
    console.log(`sendPush: status=${status} to ${sub.endpoint.slice(0,50)}...`);
    if (status === 200 || status === 201) console.log(`sendPush: body=${resBody.slice(0,100)}`);

    if (status === 410 || status === 404) return 'expired';
    if (!res.ok) { console.warn(`sendPush failed ${status}: ${resBody.slice(0,100)}`); return 'error'; }
    return 'ok';
  } catch (err) {
    console.error('sendPush error:', err.message);
    return 'error';
  }
}

// ── APNs / native iOS push (2026-09) ─────────────────────────
// Real push for the Capacitor iOS app -- Web Push (above) doesn't reach a
// native shell, only a browser/installed-PWA context (see
// usePushNotifications.js's Capacitor.isNativePlatform() guard on the
// frontend). Same token-based-auth (ES256 JWT) shape as VAPID above, just
// APNs's own claim set (iss=team id, no aud/exp/sub) and its own transport
// (HTTP/2 to Apple's push gateway with the device token in the URL, not an
// arbitrary per-subscriber endpoint).
//
// Needs three Worker secrets that don't exist yet as of this writing:
// APNS_KEY_ID, APNS_TEAM_ID, APNS_AUTH_KEY (the .p8 auth key's PEM text,
// from Certificates, Identifiers & Profiles → Keys on the Apple Developer
// portal). Until those are set, sendAPNsPush errors per-send rather than
// silently no-op-ing, so a misconfiguration shows up in logs immediately
// instead of looking like "sent but nothing ever arrives."

function pemToDer(pem) {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s+/g, '');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// APNs tokens are valid up to 1hr and Apple asks clients not to mint a
// fresh one per request -- cache in KV (55min TTL, safely inside that
// window) same as every other KV-cache-then-generate pattern in this file.
async function buildAPNsJWT(env) {
  const cached = await kvGet(env, 'apns:jwt');
  if (cached?.token && cached.expiresAt > Date.now()) return cached.token;

  const now     = Math.floor(Date.now() / 1000);
  const header  = { alg: 'ES256', kid: env.APNS_KEY_ID };
  const payload = { iss: env.APNS_TEAM_ID, iat: now };

  const enc    = s => uint8ArrayToBase64url(new TextEncoder().encode(JSON.stringify(s)));
  const toSign = `${enc(header)}.${enc(payload)}`;

  // .p8 key is PKCS8 PEM (unlike VAPID's raw-scalar JWK above) -- import
  // directly for signing, no x/y components needed.
  const privKey = await crypto.subtle.importKey(
    'pkcs8', pemToDer(env.APNS_AUTH_KEY),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, privKey, new TextEncoder().encode(toSign)
  );

  const jwt = `${toSign}.${uint8ArrayToBase64url(new Uint8Array(sig))}`;
  await kvPut(env, 'apns:jwt', { token: jwt, expiresAt: Date.now() + 55 * 60 * 1000 }, 55 * 60);
  return jwt;
}

// sub: { platform: 'ios', token, teamAbbr, prefs }
export async function sendAPNsPush(sub, payload, env) {
  if (!env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_AUTH_KEY) {
    console.error('sendAPNsPush: APNS_KEY_ID/APNS_TEAM_ID/APNS_AUTH_KEY not configured');
    return 'error';
  }
  try {
    const jwt   = await buildAPNsJWT(env);
    // env.APNS_ENV defaults to 'sandbox' -- matches this app's entitlement
    // (App.entitlements' aps-environment is still 'development' as of this
    // writing; flip both together once shipping to TestFlight/App Store).
    const host  = env.APNS_ENV === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
    const topic = env.APNS_BUNDLE_ID || 'com.eyewallanalytics.app';

    const res = await fetch(`https://${host}/3/device/${sub.token}`, {
      method:  'POST',
      headers: {
        'authorization':  `bearer ${jwt}`,
        'apns-topic':     topic,
        'apns-push-type': 'alert',
        'apns-priority':  '10',
      },
      body: JSON.stringify({
        aps: { alert: { title: payload.title || '', body: payload.body || '' }, sound: 'default' },
        // Where a tap should land, as for Web Push (sw.js's data.url); the
        // app's pushNotificationActionPerformed listener reads it.
        ...(payload.url ? { url: payload.url } : {}),
        ...(payload.data || {}),
      }),
    });

    const status  = res.status;
    const resBody = await res.text().catch(() => '');
    console.log(`sendAPNsPush: status=${status} to ${sub.token.slice(0, 12)}...`);

    // 410 = "Unregistered" -- APNs's equivalent of Web Push's 410/404 expiry
    if (status === 410) return 'expired';
    if (!res.ok) { console.warn(`sendAPNsPush failed ${status}: ${resBody.slice(0, 150)}`); return 'error'; }
    return 'ok';
  } catch (err) {
    console.error('sendAPNsPush error:', err.message);
    return 'error';
  }
}

// Live Activity update/end for one activity push token (the iOS app's
// lock-screen game tracker -- see nhl.js's pushLiveActivities()). Same APNs
// key and JWT as sendAPNsPush, with the Live Activity push type and topic.
// `state` is the activity's ContentState; its keys must match
// GameActivityAttributes.swift in eyewall-analytics. Priority 10 is for
// changes worth showing right away (score, period); 5 for the clock, which
// Apple delivers opportunistically and doesn't count against the budget.
// event 'start' is a push-to-start (iOS 17.2+): `token` is the app's
// push-to-start token, and the payload also carries the activity's
// attributes, their Swift type name and the alert shown as it starts.
export async function sendLiveActivityPush(token, { event = 'update', state, priority = 10, staleDate, dismissalDate, attributes, attributesType, alert }, env) {
  if (!env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_AUTH_KEY) {
    console.error('sendLiveActivityPush: APNS_KEY_ID/APNS_TEAM_ID/APNS_AUTH_KEY not configured');
    return 'error';
  }
  try {
    const jwt  = await buildAPNsJWT(env);
    const host = env.APNS_ENV === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
    const now  = Math.floor(Date.now() / 1000);
    const aps  = { timestamp: now, event, 'content-state': state };
    if (staleDate) aps['stale-date'] = staleDate;
    if (dismissalDate) aps['dismissal-date'] = dismissalDate;
    if (event === 'start') {
      aps['attributes-type'] = attributesType;
      aps.attributes = attributes;
      if (alert) aps.alert = alert;
    }
    const res = await fetch(`https://${host}/3/device/${token}`, {
      method:  'POST',
      headers: {
        'authorization':  `bearer ${jwt}`,
        'apns-topic':     `${env.APNS_BUNDLE_ID || 'com.eyewallanalytics.app'}.push-type.liveactivity`,
        'apns-push-type': 'liveactivity',
        'apns-priority':  String(priority),
      },
      body: JSON.stringify({ aps }),
    });
    if (res.status === 410) return 'expired';
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // A token for an activity the user dismissed comes back 400 BadDeviceToken
      if (res.status === 400 && body.includes('BadDeviceToken')) return 'expired';
      console.warn(`sendLiveActivityPush failed ${res.status}: ${body.slice(0, 150)}`);
      return 'error';
    }
    return 'ok';
  } catch (err) {
    console.error('sendLiveActivityPush error:', err.message);
    return 'error';
  }
}

// Head-to-head derived insights (Session 88, Team vs Team Mode 2) -- shared
// by nhl.js's /team-seasons/head-to-head and pwhl.js's
// /pwhl/team-seasons/head-to-head. Each route queries its own league's
// game_log-shaped table (NHL: one row per team per game; PWHL: one row per
// game with both teams in columns -- see those routes' own comments) and
// normalizes to this common per-game shape before calling this function,
// so the actual record/streak/window math has exactly one definition
// instead of being duplicated per league.
//
// `games` must already be sorted chronologically ascending (oldest first):
// [{ gameId, season, gameDate, teamAWon, teamAScore, teamBScore, homeTeam }]
export function buildHeadToHeadPayload(teamA, teamB, games) {
  const totalMeetings = games.length;
  const teamAWins = games.filter(g => g.teamAWon).length;
  const teamBWins = totalMeetings - teamAWins;

  // Recent-window size is deliberately not a fixed "last 14" -- it's
  // min(10, totalMeetings), reusing this app's existing L10 convention and
  // naturally collapsing to the pair's full history when they haven't met
  // many times yet, rather than claiming a "last 10" sample that doesn't exist.
  const windowSize = Math.min(10, totalMeetings);
  const recentGames = games.slice(-windowSize);
  const recentTeamAWins = recentGames.filter(g => g.teamAWon).length;
  const recentTeamBWins = windowSize - recentTeamAWins;

  // Walk backward from the most recent meeting until the winner changes.
  let streakHolder = null, streakCount = 0;
  for (let i = games.length - 1; i >= 0; i--) {
    const holder = games[i].teamAWon ? 'A' : 'B';
    if (streakHolder === null) { streakHolder = holder; streakCount = 1; }
    else if (holder === streakHolder) { streakCount++; }
    else break;
  }

  return {
    teamA, teamB, totalMeetings,
    allTimeRecord: { teamAWins, teamBWins },
    recentWindow: { size: windowSize, teamAWins: recentTeamAWins, teamBWins: recentTeamBWins },
    currentStreak: totalMeetings > 0 ? { holder: streakHolder, count: streakCount } : null,
    // Session 86 v1 brief's guardrail: don't present a 2-4 game sample as
    // an established trend. Frontend uses this to qualify its language
    // rather than stating the record/streak as if it were statistically
    // meaningful.
    isThinSample: totalMeetings > 0 && totalMeetings <= 4,
    games,
  };
}

// ── Pre-game prediction prompt helpers ──────────────────────────
// Shared by every league's AI prediction route: NHL's /prediction/analyze
// (nhl.js) and /pwhl/prediction, /ahl/prediction, /echl/prediction
// (hockeytechPrediction.js). The rule they all follow: a stat the data
// doesn't have is "not available" in the prompt, never a stand-in like 0
// or a hardcoded default -- a made-up "PK%: 0.0%" reads to the AI as a real
// weakness (NHL Opening Night 2026-09-29).

// Early-season blending. A few games say little about a team -- one bad
// night is a 0-for-3 PK, "0.0%" -- so while a stat's sample is small it's
// shrunk toward the same team's last-season number:
// (gp * thisSeason + k * lastSeason) / (gp + k). k is how many games of
// this season it takes to count as much as last season; from k games on,
// this season's number stands alone. Shot volume and share settle
// quickly, goal rates slower, special teams (a few chances a night)
// slowest.
export const EARLY_SEASON_K = { shots: 10, goals: 20, specialTeams: 30 };

// { value, cur, gp, prior, k }, or null when neither season has the stat
// -- a missing stat is never replaced with a made-up number.
export function blendStat(cur, gp, prior, k) {
  const hasCur = cur != null && gp > 0;
  const hasPrior = prior != null;
  if (!hasCur && !hasPrior) return null;
  if (!hasCur) return { value: prior, cur: null, gp: 0, prior, k };
  if (!hasPrior || gp >= k) return { value: cur, cur, gp, prior, k };
  return { value: (gp * cur + k * prior) / (gp + k), cur, gp, prior, k };
}

// Prompt text for a blendStat() result: says where the number came from
// whenever it isn't simply this season's. `words` lets a playoff prompt
// say "these playoffs" where the default says "this season".
const SEASON_WORDS = { current: 'this season', estimate: 'early-season estimate' };
export function describeStat(label, s, priorLabel, fmt, words = SEASON_WORDS) {
  if (!s) return `${label}: not available`;
  if (s.cur == null) return `${label}: ${fmt(s.value)} (${priorLabel}; none ${words.current} yet)`;
  if (s.gp >= s.k) return `${label}: ${fmt(s.value)}`;
  if (s.prior == null) return `${label}: ${fmt(s.value)} (${s.gp} GP ${words.current}, small sample)`;
  return `${label}: ${fmt(s.value)} ${words.estimate} (${fmt(s.cur)} in ${s.gp} GP ${words.current}, blended with ${fmt(s.prior)} in ${priorLabel})`;
}

export const fmtPct = v => `${v.toFixed(1)}%`;
export const fmtRate = v => v.toFixed(2);

// team_seasons (NHL) and {pwhl,ahl,echl}_team_seasons all store pp_pct/
// pk_pct as 0-1 fractions (0.249 = 24.9%); NHL's corsi columns too (PWHL's
// corsi_for_pct[_5v5] are already percentages -- see pwhl.js).
export const asPct = v => (v != null ? v * 100 : null);

// League-average PP%/PK% for one season: the mean of every team's
// pp_pct/pk_pct, as percentages -- real data, never a stand-in. Each is
// null (and left out of the prompt) unless at least `minTeams` teams have
// the stat, so a handful of rows never passes for the league.
export function leagueSpecialTeams(rows, minTeams) {
  const mean = key => {
    const vals = rows.map(r => r[key]).filter(v => v != null);
    return vals.length >= minTeams ? { value: asPct(vals.reduce((a, b) => a + b, 0) / vals.length), teams: vals.length } : null;
  };
  return { pp: mean('pp_pct'), pk: mean('pk_pct') };
}

// "League average (2025-26, mean of 32 teams): PP% 21.0% · PK% 79.0%", or
// null when neither average is available. seasonText names the season.
export function leagueAverageLine(avg, seasonText) {
  const parts = [];
  if (avg.pp) parts.push(`PP% ${fmtPct(avg.pp.value)}`);
  if (avg.pk) parts.push(`PK% ${fmtPct(avg.pk.value)}`);
  if (!parts.length) return null;
  const teams = Math.max(avg.pp?.teams ?? 0, avg.pk?.teams ?? 0);
  return `League average (${seasonText}, mean of ${teams} teams): ${parts.join(' · ')}`;
}

// Pythagorean expected score, as "3.1"-style strings, or nulls when either
// team's goal rates are unavailable -- never computed from zeros. expCar is
// the first team's (the side whose rates come first), expOpp the other's.
export function expectedScore(carGf, carGa, oppGf, oppGa, isHome) {
  if ([carGf, carGa, oppGf, oppGa].some(v => v == null)) return { expCar: null, expOpp: null };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const homeAdj = isHome ? 0.12 : -0.12;
  return {
    expCar: clamp(Math.sqrt(Math.max(carGf, 0.5) * Math.max(oppGa, 0.5)) + homeAdj, 1.5, 5.0).toFixed(1),
    expOpp: clamp(Math.sqrt(Math.max(oppGf, 0.5) * Math.max(carGa, 0.5)) - homeAdj, 1.5, 5.0).toFixed(1),
  };
}
