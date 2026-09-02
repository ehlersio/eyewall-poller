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

export async function kvGet(env, key) {
  const raw = await env.CACHE.get(key);
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

// ── Response helpers ──────────────────────────────────────────

export function json(val) {
  return Response.json(val, { headers: corsHeaders() });
}

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// Server-side Supabase REST upsert (insert-or-update via PostgREST's
// on_conflict + merge-duplicates). Uses the same anon key as sbRows()
// (nhl.js) -- deliberately not a service-role key. The Worker has only
// ever read from Supabase before this; rather than introduce a broad
// write credential for the first time, this relies on a narrow RLS policy
// scoped to just the one table needing it (see
// eyewall-poller/docs/nhl_odds_table.sql).
export async function sbUpsert(table, rows, onConflict) {
  if (!rows.length) return;
  const r = await fetch(`${SB_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: {
      'apikey': SB_ANON,
      'Authorization': `Bearer ${SB_ANON}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Supabase upsert ${r.status}: ${table}`);
}

export function unauthorized() {
  return new Response('Unauthorized', { status: 401 });
}

export function badRequest(msg) {
  return new Response(JSON.stringify({ error: msg }), { status: 400, headers: corsHeaders() });
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
export async function generateText(env, { messages, max_tokens = 1024 } = {}) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
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

export function sbError(status) {
  return new Response(JSON.stringify({ error: `Supabase ${status}` }), { status: 502, headers: corsHeaders() });
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

// Send a Web Push notification with encrypted payload (RFC 8291).
// Service worker reads e.data.json() — no KV fetch needed.
export async function sendPush(sub, payload, env) {
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
