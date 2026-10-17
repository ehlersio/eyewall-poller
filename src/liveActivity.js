// liveActivity.js
// iOS Live Activities (the lock-screen / CarPlay game tracker) for every
// league the app follows: NHL, PWHL, AHL and ECHL.
//
// Two ways an activity comes to exist:
//   - The app starts one for a game and registers its update token
//     (POST /live-activity/register). Tokens live per game in
//     `la:tokens:{gameId}` (NHL) / `la:tokens:{league}:{gameId}`.
//   - "Follow my team's games" (iOS 17.2+): the app registers one
//     ActivityKit push-to-start token for all its followed teams
//     (POST /live-activity/start-token). When one of those teams' games is
//     live, startLiveActivities() sends the token one `event: start` push,
//     the activity appears whether or not the app is open, iOS wakes the
//     app, and it reports the new activity's update token to /register.
// Each league's poll then calls pushLiveActivities() every tick with the
// game's ContentState, and once more with `end: true` at the final.
//
// KV keys keep the NHL's original names (`la:start:CAR`, `la:tokens:{id}`,
// ...) so registrations made before the other leagues existed keep
// working; every other league adds its own segment (`la:start:ahl:CHI`,
// `la:tokens:pwhl:341`).

import { kvGet, kvPut, json, badRequest, errorJson, sendLiveActivityPush, checkPublicWriteRateLimit, scorebarIntermission } from './shared.js';

export const LA_LEAGUES = ['nhl', 'pwhl', 'ahl', 'echl'];
export const LA_TOKEN_TTL = 8 * 3600;
// Most activity tokens one game's list (`la:tokens:*`), and most start
// tokens one team's list (`la:start:*`), may hold. This is a hobby app: a
// game has a handful of activities, so 200 is far above real use while
// keeping a flood of junk registrations (security audit 2026-10-13 #6) to
// 200 APNs requests a tick, not 1,000. A full list refuses a NEW token
// (429 'Live Activity token list full') rather than dropping the oldest:
// a flood may block new registrations for that game or team, but it never
// evicts a device that registered earlier -- the same posture as
// /push/subscribe's MAX_PUSH_SUBS. A token already on the list (re-sent on
// a later launch) and removals still go through.
export const LA_MAX_TOKENS = 200;
// New tokens one IP may register: activity tokens per game, start tokens
// per day. One device registers one of each (a token re-sent as-is on a
// later launch doesn't count again). 50, not a handful: fans on venue
// Wi-Fi, and iPhones behind carrier CGNAT, share one IPv4 address across
// hundreds of devices, and every phone past the cap that opens a Live
// Activity for the game would get a 429 and never receive updates. It
// still stops one address filling a game's list on its own. Counted in
// `la:ipcount:*` under a hash of the IP, never the IP itself.
export const LA_MAX_TOKENS_PER_IP = 50;
const LA_IPCOUNT_START_TTL = 24 * 3600;
const LA_START_TTL = 90 * 24 * 3600; // re-registered on every app launch
// Most teams one start token is put on; the app follows at most 20
// (nhl.js MAX_SUB_TEAMS).
const LA_MAX_START_TEAMS = 20;
// ActivityKit's update and push-to-start tokens, as the app sends them:
// the token bytes in lowercase hex (SceneDelegate.swift). Upper case is
// accepted and lowercased. 64-200 characters (32-100 bytes).
const LA_TOKEN = /^[0-9a-f]{64,200}$/;
export function normalizeLiveActivityToken(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  return LA_TOKEN.test(t) ? t : null;
}

// Counts one new token against the caller's IP under `scope`; true when the
// IP is already at LA_MAX_TOKENS_PER_IP (the token is then refused).
async function ipAtTokenCap(env, request, scope, ttl) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`la-ip:${ip}`));
  const hash = [...new Uint8Array(digest).slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
  const key = `la:ipcount:${scope}:${hash}`;
  const count = Number(await kvGet(env, key)) || 0;
  if (count >= LA_MAX_TOKENS_PER_IP) return true;
  await kvPut(env, key, count + 1, ttl);
  return false;
}
const tooManyTokens = () => errorJson(429, { error: 'Too many Live Activity tokens from this network' });
const listFull = () => errorJson(429, { error: 'Live Activity token list full' });

async function readBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch { return null; }
}
const LA_FALLBACK_COLOR = '#e4e8f0';

const LA_START_ALERT = {
  en: { title: (away, home) => `${away} @ ${home}`, body: 'Puck drop — following on your Lock Screen.' },
  fr: { title: (away, home) => `${away} @ ${home}`, body: 'Mise au jeu — suivi sur votre écran verrouillé.' },
};

// The attributes' dot colours, by league then abbr: each team's on-dark
// displayColor in eyewall-analytics (what the app sends when it starts one
// itself). KEEP IN SYNC with utils/teamConfig.js (NHL), pwhlConfig.js,
// ahlConfig.js and echlConfig.js.
//
// These maps are also the list of teams a start token may follow: only
// current teams, keyed by the same abbrs as the poller's team maps
// (TEAM_CONFIGS, PWHL_TEAM_CODES, AHL_TEAM_CODES, ECHL_TEAM_CODES) --
// __tests__/live-activity.test.js holds them to it.
export const LA_TEAM_COLORS = {
  nhl: { ANA: '#F47A38', BOS: '#FFB81C', BUF: '#649cff', CAR: '#ff0f0f', CBJ: '#4e9fff', CGY: '#ef3654', CHI: '#f52c4e', COL: '#c85e80', DAL: '#009365', DET: '#ef384c', EDM: '#FF4C00', FLA: '#5b9ef9', LAK: '#818181', MIN: '#2b926b', MTL: '#e04b5b', NJD: '#ef384c', NSH: '#FFB81C', NYI: '#649cff', NYR: '#689bff', OTT: '#e24b5b', PHI: '#F74902', PIT: '#FCB514', SEA: '#99D9D9', SJS: '#008e99', STL: '#659bff', TBL: '#5f9cff', TOR: '#42a0ff', UTA: '#6CAEDF', VAN: '#009645', VGK: '#B4975A', WPG: '#5b9ef9', WSH: '#5b9ef9' },
  pwhl: { BOS: '#3DA58A', MIN: '#A77BCA', MTL: '#D4576A', NY: '#00A8AB', OTT: '#BF2B45', TOR: '#3579FF', SEA: '#5DB8B8', VAN: '#4A90D9', DET: '#E3475E', HAM: '#E14C62', LV: '#818916', SJS: '#0083ED' },
  ahl: { HFD: '#0084E0', PRO: '#FBB337', LV: '#F58220', WBS: '#FEC23D', HER: '#AC7374', CLT: '#FF0A34', SPR: '#EB3E59', ROC: '#E44861', SYR: '#4D82D5', TOR: '#0A7EFF', CLE: '#1B87D4', UTC: '#E44857', BEL: '#F13159', LAV: '#3080F2', HAM: '#0081F2', MB: '#297FF2', MIL: '#4280E1', GR: '#EC3D58', CHI: '#FF0927', RFD: '#E94358', TEX: '#1F9747', IA: '#00965B', BAK: '#327AFF', ONT: '#A4A9AD', SD: '#FF4C00', SJ: '#2C909C', TUC: '#C96081', COL: '#4E7CE8', HSK: '#C3C7C9', ABB: '#009841', CGY: '#F13755', CV: '#0082F1' },
  echl: { ADK: '#F13352', GSO: '#966EC6', MNE: '#0088CA', NOR: '#4278FF', REA: '#916FC9', TRE: '#508EC8', TR: '#D0D2CE', WOR: '#0A7CFF', ATL: '#CA5F62', FLA: '#00944F', GVL: '#147DFB', JAX: '#597ED0', ORL: '#926ED1', SAV: '#57BA47', SC: '#007DFB', BLM: '#EA3E58', CIN: '#E24860', FW: '#FF7800', IND: '#D95358', KAL: '#E24A4E', TOL: '#6799C8', WHL: '#FCB514', ALN: '#E5455B', IDH: '#4381D3', KC: '#F15F22', NM: '#DD4F57', RC: '#DF4C5C', TAH: '#5395CE', TUL: '#5181CC', WIC: '#0B7CFF' },
};

export function isLiveActivityTeam(league, abbr) {
  return Object.hasOwn(LA_TEAM_COLORS, league) && Object.hasOwn(LA_TEAM_COLORS[league], abbr);
}

const scoped = (league, id) => (league === 'nhl' ? `${id}` : `${league}:${id}`);
export const laKeys = {
  tokens:  (league, gameId) => `la:tokens:${scoped(league, gameId)}`,
  last:    (league, gameId) => `la:last:${scoped(league, gameId)}`,
  started: (league, gameId) => `la:started:${scoped(league, gameId)}`,
  start:   (league, abbr)   => `la:start:${scoped(league, abbr)}`,
};

// 'ahl:chi' -> 'ahl:CHI'; null unless it names a current team.
export function liveActivityTeamKey(raw) {
  const m = String(raw ?? '').trim().match(/^([a-z]+):([a-z0-9]{1,5})$/i);
  if (!m) return null;
  const league = m[1].toLowerCase(), abbr = m[2].toUpperCase();
  return isLiveActivityTeam(league, abbr) ? `${league}:${abbr}` : null;
}

// ── Push-to-start ─────────────────────────────────────────────────────
// One `event: start` push per start token per game, to every token
// following either team. `game` is { gameId, homeAbbr, awayAbbr }.
//
// A team's list (`la:start:*`) is only a lookup index; the token's own
// record (`la:startteams:{token}`, or the pre-2026-10 `la:startteam`) is
// what says which teams it follows. The two can disagree: /start-token
// removes a token only from the lists of the teams its previous record
// named, so a list entry written while a record was missing, or by two
// launches racing each other (see the handler), outlives the follow. On
// 2026-10-13 the owner's token was still on `la:start:PIT` with a record
// of ["nhl:CAR", "pwhl:MTL"], and a PIT @ CHI activity landed on their
// phone. So before a start push the record is checked, and a token whose
// record is missing or doesn't name this team is skipped and taken off
// the list -- the lists heal themselves at the next game.
export async function startLiveActivities(env, league, { gameId, homeAbbr, awayAbbr }, state) {
  const sentKey = laKeys.started(league, gameId);
  const sent = new Set((await kvGet(env, sentKey)) || []);
  let changed = false;
  for (const team of [homeAbbr, awayAbbr]) {
    if (!isLiveActivityTeam(league, team)) continue;
    const listKey = laKeys.start(league, team);
    const entries = (await kvGet(env, listKey)) || [];
    const candidates = entries.filter(e => !sent.has(e.token));
    if (!candidates.length) continue;
    const follows = await Promise.all(candidates.map(e => tokenFollows(env, e.token, league, team)));
    const stale = new Set(candidates.filter((_, i) => !follows[i]).map(e => e.token));
    if (stale.size) {
      console.log(`[la] ${league} ${team}: dropping ${stale.size} start token(s) whose record no longer follows the team`);
      await kvPut(env, listKey, entries.filter(e => !stale.has(e.token)), LA_START_TTL);
    }
    const due = candidates.filter(e => !stale.has(e.token));
    if (!due.length) continue;
    const now = Math.floor(Date.now() / 1000);
    const colors = LA_TEAM_COLORS[league];
    const attributes = {
      gameId: Number(gameId), homeAbbr, awayAbbr,
      homeColor: colors[homeAbbr] || LA_FALLBACK_COLOR, awayColor: colors[awayAbbr] || LA_FALLBACK_COLOR,
      followAbbr: team, league,
    };
    const results = await Promise.all(due.map(e => {
      const copy = LA_START_ALERT[e.locale] || LA_START_ALERT.en;
      return sendLiveActivityPush(e.token, {
        event: 'start', state, attributes, attributesType: 'GameActivityAttributes',
        alert: { title: copy.title(awayAbbr, homeAbbr), body: copy.body },
        staleDate: now + 5 * 60,
      }, env);
    }));
    // One try per device per game, whatever came back: an error here isn't
    // retried every minute for the rest of the game. A user who opens the
    // app during the game gets it started there instead. A token on both
    // teams is started once, as the home team's.
    due.forEach(e => sent.add(e.token));
    changed = true;
    const dead = new Set(due.filter((_, i) => results[i] === 'expired').map(e => e.token));
    if (dead.size) await kvPut(env, listKey, entries.filter(e => !stale.has(e.token) && !dead.has(e.token)), LA_START_TTL);
  }
  if (changed) await kvPut(env, sentKey, [...sent], LA_TOKEN_TTL);
}

// Whether a start token's own record says it follows `team` in `league`:
// `la:startteams:{token}` lists "{league}:{ABBR}" keys; a token from a
// build before 2026-10 that hasn't launched since has only the single-NHL-
// team `la:startteam:{token}` instead. No record at all means the token
// was never registered through /start-token in its current form (rotated
// by iOS, or a list entry from before the record existed), so it isn't
// started: a device that still follows the team re-registers at its next
// launch and is back on the list within the day.
async function tokenFollows(env, token, league, team) {
  const [teams, legacy] = await Promise.all([kvGet(env, `la:startteams:${token}`), kvGet(env, `la:startteam:${token}`)]);
  if (Array.isArray(teams) && teams.includes(`${league}:${team}`)) return true;
  return league === 'nhl' && typeof legacy === 'string' && legacy === team;
}

// ── Updates ───────────────────────────────────────────────────────────
// Pushes `state` to every activity registered for the game, if it changed.
// Score/period/event changes go at priority 10 (shown right away); a
// clock- or shots-only change goes at 5. Tokens Apple says are dead are
// dropped. `state` may be an async function, called only when the game
// has an activity -- for a state that costs a fetch to build.
export async function pushLiveActivities(env, league, gameId, stateOrFn, { end = false } = {}) {
  const tokensKey = laKeys.tokens(league, gameId);
  const tokens = (await kvGet(env, tokensKey)) || [];
  if (!tokens.length) return;
  const state = typeof stateOrFn === 'function' ? await stateOrFn() : stateOrFn;
  const lastKey = laKeys.last(league, gameId);
  const last = await kvGet(env, lastKey);
  if (!end && last && JSON.stringify(last) === JSON.stringify(state)) return;
  // The clock and shots change all game long: they ride at priority 5,
  // which iOS doesn't budget. Goals, penalties and periods go at 10.
  const withoutClock = st => JSON.stringify({ ...st, clock: null, homeSog: null, awaySog: null });
  const priority = end || !last || withoutClock(state) !== withoutClock(last) ? 10 : 5;
  const now = Math.floor(Date.now() / 1000);
  const results = await Promise.all(tokens.map(t => sendLiveActivityPush(t, {
    event: end ? 'end' : 'update',
    state,
    priority,
    staleDate: end ? undefined : now + 5 * 60,
    dismissalDate: end ? now + 30 * 60 : undefined,
  }, env)));
  const alive = tokens.filter((_, i) => results[i] !== 'expired');
  if (alive.length !== tokens.length) await kvPut(env, tokensKey, alive, LA_TOKEN_TTL);
  await kvPut(env, lastKey, state, LA_TOKEN_TTL);
}

// ── HockeyTech (PWHL/AHL/ECHL) ContentState ─────────────────────────
// A HockeyTech period name as the Live Activity labels periods (the NHL's
// '1st'..'3rd', 'OT', '2OT'.., 'SO'), or '' when there isn't one. The
// feeds name overtimes differently: the AHL's scorebar and PBP say 'OT',
// '2OT', '3OT'; the ECHL's and PWHL's 'OT1', 'OT2'.. (all three checked
// against every final in their scorebars, 2026-10-09). Takes the
// scorebar's PeriodNameShort or a PBP event's period.shortName / .id.
export function hockeyTechPeriodName(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  const reg = { 1: '1st', 2: '2nd', 3: '3rd' }[s];
  if (reg) return reg;
  if (s === 'SO') return 'SO';
  const ot = s.match(/^OT(\d*)$/) || s.match(/^(\d+)OT$/);
  if (!ot) return '';
  const n = Number(ot[1] || 1);
  return n <= 1 ? 'OT' : `${n}OT`;
}

const lastNameOf = p => (typeof p?.lastName === 'string' && p.lastName.trim()) || null;
const periodOf = ev => {
  const p = ev?.details?.period || {};
  return hockeyTechPeriodName(p.shortName) || hockeyTechPeriodName(p.id);
};

// The Live Activity's ContentState for a PWHL/AHL/ECHL game -- the same
// keys as nhl.js's liveActivityState(), which GameActivityAttributes
// .ContentState in eyewall-analytics decodes.
//   game:   the poller's game_log row with the scorebar overlay
//           (withLiveScorebar(..., { withClock: true })): home_score,
//           away_score, home_team_id, away_team_id, period_name_short,
//           game_clock, intermission, game_state / game_status_code,
//           ended_in
//   events: the game's gameCenterPlayByPlay events, or null
// Strength is always null: HockeyTech has no reliable power-play state to
// read it from, and it isn't inferred from penalties.
export function hockeyTechLiveActivityState(game, events, { teamCodes = {}, final = false } = {}) {
  const homeId = Number(game.home_team_id), awayId = Number(game.away_team_id);
  const abbrOf = (id, fallback) => teamCodes[Number(id)] || fallback || null;
  const plays = Array.isArray(events) ? events : null;
  // Not just the scorebar's Intermission flag: it never read '1' through
  // an intermission of ECHL 25487 (2026-10-16). See scorebarIntermission().
  const inIntermission = !final && scorebarIntermission(game);
  const periodLabel = hockeyTechPeriodName(game.period_name_short);

  let lastEvent = null;
  const last = plays && [...plays].reverse().find(e => e?.event === 'goal' || e?.event === 'penalty');
  if (last) {
    const d = last.details || {};
    const when = `${periodOf(last)} ${d.time || ''}`.trim();
    if (last.event === 'goal') {
      const who = lastNameOf(d.scoredBy);
      // scorerGoalNumber is the scorer's goal count for the season (AHL
      // 1028853, April 2026: 20, 13, 15), as the NHL's scoringPlayerTotal.
      const num = /^\d+$/.test(String(d.scorerGoalNumber ?? '')) ? ` (${d.scorerGoalNumber})` : '';
      lastEvent = ['GOAL', abbrOf(d.team?.id, d.team?.abbreviation), who ? `${who}${num}` : null, when || null]
        .filter(Boolean).join(' · ');
    } else {
      // A bench penalty has no takenBy name (AHL: null; PWHL: blank
      // names); servedBy then names the skater in the box. The description
      // is HockeyTech's own text ("Too many men - Bench minor").
      const taken = lastNameOf(d.takenBy);
      const served = lastNameOf(d.servedBy);
      const servedOther = served && (d.servedBy?.id != null && d.takenBy?.id != null
        ? d.servedBy.id !== d.takenBy.id : served !== taken);
      const mins = parseFloat(d.minutes);
      lastEvent = [
        'PEN',
        abbrOf(d.againstTeam?.id, d.againstTeam?.abbreviation),
        taken,
        (typeof d.description === 'string' && d.description.trim()) || null,
        Number.isFinite(mins) && mins > 0 ? `${mins} min` : null,
        servedOther ? `served by ${served}` : null,
      ].filter(Boolean).join(' · ');
    }
  }

  // Shots on goal: PBP `shot` events by shooterTeamId. A goal is a `shot`
  // with isGoal plus its own `goal` event, so only `shot` is counted;
  // shootout attempts are `shootout` events. Matched the box score
  // exactly in AHL 1029093 and ECHL 26586 / PWHL 341 (2026-10-09). null
  // without a play-by-play -- never a made-up 0.
  let homeSog = null, awaySog = null;
  if (plays) {
    homeSog = 0; awaySog = 0;
    for (const e of plays) {
      if (e?.event !== 'shot') continue;
      const t = Number(e.details?.shooterTeamId);
      if (t === homeId) homeSog++;
      else if (t === awayId) awaySog++;
    }
  }

  // A final's label says how it ended: 'SO' (the scorebar can leave a
  // shootout game on period 'OT'), 'OT'/'2OT'.., else the last period.
  let label = periodLabel;
  if (final && game.ended_in === 'SO') label = 'SO';
  else if (final && game.ended_in === 'OT' && !periodLabel.endsWith('OT')) label = 'OT';

  return {
    homeScore: game.home_score ?? 0,
    awayScore: game.away_score ?? 0,
    periodLabel: label,
    clock: (typeof game.game_clock === 'string' && game.game_clock) || '',
    inIntermission,
    status: final ? 'final' : 'live',
    lastEvent,
    strength: null,
    homeSog,
    awaySog,
  };
}

// ── Routes ────────────────────────────────────────────────────────────
// POST /live-activity/register and /live-activity/start-token; null for
// any other request.
export async function handleLiveActivity(request, env, url) {
  if (request.method !== 'POST') return null;

  // POST /live-activity/register { gameId, token, league? } -- one
  // activity's update token. league defaults to 'nhl' (older app builds).
  // Public: rate-limited per IP, at most LA_MAX_TOKENS_PER_IP new tokens
  // per IP per game, and a new token is refused once the game has
  // LA_MAX_TOKENS.
  if (url.pathname === '/live-activity/register') {
    const limited = await checkPublicWriteRateLimit(env, request, 'la-register');
    if (limited) return limited;
    const body = await readBody(request);
    if (!body) return badRequest('invalid JSON');
    const gameId = Number(body.gameId);
    const token = normalizeLiveActivityToken(body.token);
    const league = body.league == null ? 'nhl' : String(body.league).toLowerCase();
    if (!LA_LEAGUES.includes(league)) return badRequest(`league must be one of ${LA_LEAGUES.join(', ')}`);
    if (!Number.isSafeInteger(gameId) || gameId <= 0) return badRequest('gameId required');
    if (!token) return badRequest('token must be 64-200 hex characters');
    const key = laKeys.tokens(league, gameId);
    let tokens = (await kvGet(env, key)) || [];
    if (!tokens.includes(token)) {
      if (tokens.length >= LA_MAX_TOKENS) return listFull();
      if (await ipAtTokenCap(env, request, `${league}:${gameId}`, LA_TOKEN_TTL)) return tooManyTokens();
      tokens = [...tokens, token];
      await kvPut(env, key, tokens, LA_TOKEN_TTL);
    }
    return json({ ok: true, count: tokens.length });
  }

  // POST /live-activity/start-token { token, teams, enabled, locale } --
  // the push-to-start token for "Follow my team's games", on every team in
  // `teams` (["nhl:CAR", "ahl:CHI", ...]). Older builds send `team: "CAR"`
  // instead, read as ["nhl:CAR"]. Unknown teams are dropped. The token's
  // teams are kept in `la:startteams:{token}`, so a team that's no longer
  // listed loses it; enabled:false takes it off every team.
  // Public: rate-limited per IP, and at most LA_MAX_TOKENS_PER_IP tokens
  // per IP per day that the Worker hasn't seen before. A team list at
  // LA_MAX_TOKENS refuses the whole request (nothing is changed) when it
  // would ADD this token; one already on it, a removal, or enabled:false
  // always go through.
  if (url.pathname === '/live-activity/start-token') {
    const limited = await checkPublicWriteRateLimit(env, request, 'la-start-token');
    if (limited) return limited;
    const body = await readBody(request);
    if (!body) return badRequest('invalid JSON');
    const token = normalizeLiveActivityToken(body.token);
    const enabled = body.enabled !== false;
    const locale = body.locale === 'fr' ? 'fr' : 'en';
    if (!token) return badRequest('token must be 64-200 hex characters');
    const requested = Array.isArray(body.teams) ? body.teams
      : body.team != null ? [`nhl:${body.team}`] : [];
    const teams = [...new Set(requested.slice(0, LA_MAX_START_TEAMS).map(liveActivityTeamKey).filter(Boolean))];
    if (enabled && !teams.length) return badRequest('teams must include a known team, e.g. ["nhl:CAR"]');

    const teamsKey = `la:startteams:${token}`;
    const legacyKey = `la:startteam:${token}`; // pre-2026-10 single NHL team
    const [previous, legacy] = await Promise.all([kvGet(env, teamsKey), kvGet(env, legacyKey)]);
    const before = new Set(Array.isArray(previous) ? previous : []);
    if (typeof legacy === 'string' && legacy) before.add(`nhl:${legacy}`);
    const keep = new Set(enabled ? teams : []);

    const listKeyOf = teamKey => {
      const [league, abbr] = teamKey.split(':');
      return laKeys.start(league, abbr);
    };
    // Every list this token joins, read up front: if one is full the
    // request is refused before anything is written.
    const keepLists = new Map();
    for (const t of keep) {
      const entries = (await kvGet(env, listKeyOf(t))) || [];
      if (!entries.some(e => e.token === token) && entries.length >= LA_MAX_TOKENS) return listFull();
      keepLists.set(t, entries);
    }
    if (enabled && previous == null && legacy == null
        && await ipAtTokenCap(env, request, 'start', LA_IPCOUNT_START_TTL)) return tooManyTokens();
    for (const t of before) {
      if (keep.has(t)) continue;
      const listKey = listKeyOf(t);
      const entries = (await kvGet(env, listKey)) || [];
      if (entries.some(e => e.token === token)) {
        await kvPut(env, listKey, entries.filter(e => e.token !== token), LA_START_TTL);
      }
    }
    // Read-modify-write without a compare-and-set: KV has none. The JS
    // app and the native LiveActivityRegistrar both POST the same token at
    // launch, so two of these can interleave. Same token, same teams: both
    // write the same list, harmless. Two tokens joining one team at once:
    // one write can drop the other's entry, and that device isn't started
    // until its next launch re-registers it (one list write per team, so
    // the window is one KV round trip). A record and a list can also end
    // up disagreeing; startLiveActivities() checks the record before every
    // start push and prunes the list, so that heals at the next game.
    for (const [t, list] of keepLists) {
      const entries = list.filter(e => e.token !== token);
      entries.push({ token, locale });
      await kvPut(env, listKeyOf(t), entries, LA_START_TTL);
    }
    if (enabled) await kvPut(env, teamsKey, teams, LA_START_TTL);
    else if (previous) await kvPut(env, teamsKey, null, 60);
    if (legacy) await kvPut(env, legacyKey, null, 60);

    const nhl = enabled ? teams.find(t => t.startsWith('nhl:')) : null;
    return json({ ok: true, teams: enabled ? teams : [], team: nhl ? nhl.slice(4) : null });
  }

  return null;
}
