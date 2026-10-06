/**
 * hockeytech.js — EyeWall Analytics Worker
 *
 * Shared implementation for the leagues on HockeyTech/LeagueStat's feed
 * that sit at the same data depth: AHL and ECHL. createHockeyTechLeague()
 * builds one league's HTTP routes (/{league}/*), live-game push poll, and
 * news fetch from a small config; ahl.js/echl.js hold only that config.
 * The two used to be ~1,750-line near-copies of each other. PWHL stays in
 * pwhl.js -- same vendor, but a richer feed (shift data, goalie on goal
 * events, PBP-derived 5v5) and routes that have diverged.
 *
 * Every table, KV key, push topic and route below is prefixed by the
 * league's `key` ('ahl' -> ahl_game_log, ahl:standings:90, /ahl/standings)
 * and user-facing text by its `label` ('AHL'). The characterization suite
 * (__tests__/hockeytech-leagues.characterization.test.js) pins every
 * route's exact requests, KV writes and responses for both leagues.
 *
 * Data-shape ceiling shared by both leagues, confirmed live against
 * production data (see the README's "AHL & ECHL" section):
 *   - No shift data, and no hit/faceoff/blocked_shot PBP events. Box scores
 *     carry hits/faceoff fields, but hardcoded "0" -- /summary strips them.
 *   - {league}_game_log.ended_in ('OT' | 'SO' | null) says how a final
 *     game ended, so standings L10/streaks and /prediction's streaks split
 *     OT/SO losses ('OT') from regulation losses ('L').
 *   - {league}_team_seasons has ot_losses and shootout_losses as separate
 *     columns; {league}_player_seasons has no shot_pct/gw_goals/pp_assists/
 *     sh_assists.
 *   - No {league}_pbp_events table, so /team-season-summary has no hits/
 *     faceoff/penalties section.
 *   - PBP goal events carry goalie_id: null, so there's no /goalie-shots
 *     route -- a goalie heat map would silently under-count goals.
 *   - No Corsi/Fenwick/PDO: there's no shot-attempts source beyond
 *     shots on goal.
 *   - /prediction's win probability is Elo from {league}_team_elo_ratings
 *     (eyewall-pipeline's hockeytech_elo.py), not the additive point split
 *     /pwhl/prediction uses -- that split backtested worse than a coin flip
 *     for AHL/ECHL (docs/hockeytech_elo_backtest_results.md).
 */

import { kvGet, kvPut, json, cachedJson, sbRows, sbRowsOr, sbError, errorJson, badRequest, unauthorized, SB_URL, unwrapJsonp, extractCareerTotal, extractRows, extractBioPoints, extractPhoto, checkAiRateLimit, generateText, buildHeadToHeadPayload, parseRSS, sendPush, deriveGameStatus, withLiveScorebar, finalLabel, endedInSuffix, endedInFromStatus, normalizeLink, recordHealth, requestLocale, localeKeySuffix, broadcastToTeam } from './shared.js';
import { buildHockeyTechPrediction, gameResult } from './hockeytechPrediction.js';
import { gameSummaryPlayers, fetchGameSummary, isExtraAttackerPull } from './hockeytechGame.js';
import { combineSeasonRows, combineByPlayer } from './hockeytechSeasonRows.js';

// Elo constants -- match eyewall-pipeline/elo.py (and nhl.js's
// ELO_HOME_ADVANTAGE). hockeytech_elo.py writes the ratings these apply to.
const ELO_INITIAL_RATING = 1500;
const ELO_HOME_ADVANTAGE = 35;

// Both leagues' regular season starts early October and playoffs run
// through June.
function seasonActive() {
  const month = new Date().getUTCMonth() + 1; // 1-12
  return month >= 10 || month <= 6;
}

/**
 * @param {object} cfg
 * @param {string} cfg.key          'ahl' | 'echl' -- route, table, KV and
 *                                  push-tag prefix, and HockeyTech client_code
 * @param {string} cfg.label        'AHL' | 'ECHL' -- push topic prefix and
 *                                  user-facing text
 * @param {object} cfg.teamCodes    { [teamId]: abbr }
 * @param {Array}  cfg.newsSources  RSS sources for fetchNews()
 * @param {string} cfg.headshotSize LeagueStat headshot path segment
 * @param {Function} cfg.resolveSeason     (env) => { seasonId, seasonType }
 * @param {Function} cfg.getAllSeasonTypes (env) => { [seasonId]: seasonType }
 * @param {Function} cfg.getAllSeasons     (env) => [{ seasonId, seasonType, startYear, startDate }]
 *                                  -- /prediction's "last regular season"
 * @param {number} cfg.leagueAvgFloor fewest teams /prediction's league-
 *                                  average PP%/PK% may be the mean of
 * @param {object} cfg.ht           { base, key, headers, siteId, leagueId }
 *                                  for HockeyTech; read at call time, never
 *                                  at creation
 * @returns {{ handle: Function, poll: Function, fetchNews: Function }}
 */
export function createHockeyTechLeague(cfg) {
  const { key, label, teamCodes, newsSources, headshotSize } = cfg;
  const P = `/${key}`;
  const table = (name) => `${SB_URL}/rest/v1/${key}_${name}`;
  const headshot = (playerId) => `https://assets.leaguestat.com/${key}/${headshotSize}/${playerId}.jpg`;
  const htGameUrl = (view, gameId) =>
    `${cfg.ht.base}?feed=statviewfeed&view=${view}&game_id=${gameId}&key=${cfg.ht.key}&client_code=${key}&lang=en&league_id=`;
  const htFetch = (url) => fetch(url, { headers: cfg.ht.headers });
  // game_log rows with live status/scores from the scorebar (shared.js).
  const live = (env, rows, opts) => withLiveScorebar(env, {
    client: key, base: cfg.ht.base, key: cfg.ht.key,
    siteId: cfg.ht.siteId, leagueId: cfg.ht.leagueId, headers: cfg.ht.headers,
  }, rows, opts);

  // ?season= param, live-resolving the current season when omitted.
  async function seasonParam(url, env) {
    const raw = url.searchParams.get('season');
    if (raw) return parseInt(raw, 10);
    return (await cfg.resolveSeason(env)).seasonId;
  }

  // Every row of a Supabase read, a 1,000-row page at a time (its per-
  // request cap). `url` needs a stable order=. A failed page returns that
  // Response, like sbRows().
  async function sbAllRows(url) {
    const PAGE = 1000;
    const all = [];
    for (let offset = 0; ; offset += PAGE) {
      const rows = await sbRows(url, { Range: `${offset}-${offset + PAGE - 1}`, 'Range-Unit': 'items', Prefer: 'count=none' });
      if (rows instanceof Response) return rows;
      all.push(...rows);
      if (rows.length < PAGE) return all;
    }
  }

  async function resolveSeasonType(env, seasonId) {
    const types = await cfg.getAllSeasonTypes(env);
    return types?.[String(seasonId)] || 'regular';
  }

  // /prediction's league config for hockeytechPrediction.js. No Corsi:
  // there's no shot-attempts source for either league.
  const predictionCfg = {
    key,
    label,
    article: 'an',
    teamCodes,
    getSeasonTypes: (env) => cfg.getAllSeasonTypes(env),
    getSeasons: (env) => cfg.getAllSeasons(env),
    gameLogSelect: 'game_id,home_team_id,away_team_id,home_score,away_score,ended_in',
    recordFields: ['wins', 'losses', 'ot_losses', 'shootout_losses'],
    corsi: false,
    playoffFocus: 'goaltending and recent form',
    leagueAvgFloor: cfg.leagueAvgFloor,
    eloInitial: ELO_INITIAL_RATING,
    eloHomeAdvantage: ELO_HOME_ADVANTAGE,
  };

  // ── News ───────────────────────────────────────────────────────────
  // Every source is league-scoped by construction, but a source can still
  // set filter: [keywords]. Merges with whatever's cached rather than
  // overwriting: /{league}/news/ingest (eyewall-pipeline's nightly
  // {league}_news.py, GH Actions IPs) also writes this key, and a thin
  // live-fallback result shouldn't wipe out a fuller nightly one.
  async function fetchNews(env) {
    const allItems = [];
    for (const source of newsSources) {
      try {
        console.log(`${label} news: fetching ${source.id} from ${source.url}`);
        const res = await fetch(source.url, {
          headers: { 'User-Agent': 'EyeWall-Analytics/1.0', 'Accept': 'application/rss+xml,text/xml,*/*' },
          cf: { cacheTtl: 0 },
        });
        console.log(`${label} news: ${source.id} status=${res.status}`);
        if (!res.ok) {
          console.warn(`${label} news: ${source.id} failed ${res.status}`);
          await recordHealth(env, `${key}:${source.id}`, false, { error: `HTTP ${res.status}` });
          continue;
        }
        const xml = await res.text();
        let parsed = parseRSS(xml, source);
        if (source.filter?.length) {
          parsed = parsed.filter(item => {
            const text = (item.title + ' ' + (item.excerpt || '')).toLowerCase();
            return source.filter.some(kw => text.includes(kw));
          });
        }
        allItems.push(...parsed);
        console.log(`${label} news: ${source.id} → ${parsed.length} items`);
        await recordHealth(env, `${key}:${source.id}`, true, { itemCount: parsed.length });
      } catch (err) {
        console.warn(`${label} news: ${source.id} error: ${err.message}`);
        await recordHealth(env, `${key}:${source.id}`, false, { error: err.message });
      }
    }
    const seenIds = new Set();
    const deduped = allItems
      .filter(item => { if (seenIds.has(item.id)) return false; seenIds.add(item.id); return true; })
      .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
    const existing = (await kvGet(env, `${key}:news`)) || [];
    const merged = [
      ...deduped,
      ...existing.filter(item => !deduped.find(d => d.id === item.id || normalizeLink(d.url) === normalizeLink(item.url))),
    ].sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
      .slice(0, 60);
    await kvPut(env, `${key}:news`, merged, merged.length > 0 ? 25 * 3600 : 300);
    return merged;
  }

  // ── Push notification poll ─────────────────────────────────────────
  // Called from the Worker's per-minute scheduled trigger. Mirrors
  // pollPWHL/pollPWHLGame/broadcastPWHL in pwhl.js. PBP event shapes
  // (goal/penalty/goalie_change) confirmed identical across AHL, ECHL and
  // PWHL against real completed games (AHL 1028925, ECHL 24296).
  async function poll(env) {
    if (!seasonActive()) { console.log(`[${label} poll] Off-season — skipping`); return; }
    if (!env.VAPID_PRIVATE_KEY) return;

    try {
      const { seasonId } = await cfg.resolveSeason(env);

      const nowET    = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const todayStr = nowET.toISOString().slice(0, 10);

      const logged = await sbRowsOr(
        `${table('game_log')}?game_date=eq.${todayStr}&season_id=eq.${seasonId}` +
        `&select=game_id,home_team_id,away_team_id,home_score,away_score,game_state,game_status_code&limit=10`,
        []
      );
      if (!logged?.length) return;
      const games = await live(env, logged);

      // Live games, plus games that have gone final -- pollGame() sends a
      // final game's game-over push once, then skips it.
      const activeGames = games.filter(g => ['live', 'final'].includes(deriveGameStatus(g)));
      if (!activeGames.length) return;

      for (const game of activeGames) {
        await pollGame(env, game).catch(e =>
          console.error(`[${label} poll] game ${game.game_id}: ${e.message}`)
        );
      }
    } catch (e) {
      console.error(`[${label} poll] error:`, e.message);
    }
  }

  async function pollGame(env, game) {
    const gameId   = game.game_id;
    const homeId   = game.home_team_id;
    const awayId   = game.away_team_id;
    const homeAbbr = teamCodes[homeId] || String(homeId);
    const awayAbbr = teamCodes[awayId] || String(awayId);
    // This game's two teams, so someone following both gets each alert once.
    const pair = [`${label}:${homeAbbr}`, `${label}:${awayAbbr}`];
    const send = (payload, teamKey, eventType) => broadcast(env, payload, teamKey, eventType, pair);

    // A final game gets its game-over push only if this poll followed it
    // live (a push state exists), and only once. Checked before the PBP
    // fetch, so a finished game costs two KV reads a tick, not a HockeyTech
    // call -- and one that ended before the Worker ever saw it live (e.g.
    // right after a deploy) gets no stale "Final" push.
    if (deriveGameStatus(game) === 'final') {
      if (await kvGet(env, `${key}:push:final:${gameId}`)) return;
      if (!(await kvGet(env, `${key}:push:state:${gameId}`))) return;
    }

    const pbpRes = await htFetch(htGameUrl('gameCenterPlayByPlay', gameId));
    if (!pbpRes.ok) return;

    let events;
    try {
      events = unwrapJsonp(await pbpRes.text());
    } catch { return; }
    if (!Array.isArray(events) || !events.length) return;

    const stateKey = `${key}:push:state:${gameId}`;
    const lastState = (await kvGet(env, stateKey)) || {
      homeScore: 0, awayScore: 0, eventCount: 0, started: false, period: 0,
      scorerGoalCounts: {},
    };

    const newEvents = events.slice(lastState.eventCount);
    const period    = events[events.length - 1]?.details?.period?.id;
    const periodNum = typeof period === 'string' && period.startsWith('OT')
      ? 4 : (parseInt(period, 10) || 1);
    const periodLabel = n => n <= 3 ? `P${n}` : n === 4 ? 'OT' : `OT${n - 3}`;
    const url = `${P}/shots`;

    const scorerGoalCounts = { ...lastState.scorerGoalCounts };

    // ── Game start ─────────────────────────────────────────
    if (!lastState.started && newEvents.length > 0) {
      const sessionKey = `${key}:push:start:${gameId}`;
      if (!(await kvGet(env, sessionKey))) {
        await kvPut(env, sessionKey, true, 24 * 3600);
        for (const abbr of [homeAbbr, awayAbbr]) {
          await send({
            title: `🏒 ${label} Game Starting!`,
            body:  `${homeAbbr} vs ${awayAbbr} — puck drop!`,
            tag:   `${key}-start-${gameId}`,
            url,
          }, `${label}:${abbr}`, 'gameStart');
        }
      }
    }

    // ── Period start (P2+) ─────────────────────────────────
    if (periodNum > 1 && periodNum !== lastState.period) {
      const sessionKey = `${key}:push:period:${gameId}:${periodNum}`;
      if (!(await kvGet(env, sessionKey))) {
        await kvPut(env, sessionKey, true, 24 * 3600);
        const curHome = game.home_score ?? lastState.homeScore;
        const curAway = game.away_score ?? lastState.awayScore;
        for (const [abbr, myScore, oppScore, oppAbbr] of [
          [homeAbbr, curHome, curAway, awayAbbr],
          [awayAbbr, curAway, curHome, homeAbbr],
        ]) {
          await send({
            title: `🔔 ${periodLabel(periodNum)} Starting`,
            body:  `${abbr} ${myScore}–${oppScore} ${oppAbbr}`,
            tag:   `${key}-period-${gameId}-${periodNum}-${abbr}`,
            url,
          }, `${label}:${abbr}`, 'periodStart');
        }
      }
    }

    // ── Process new events ─────────────────────────────────
    for (let i = lastState.eventCount; i < events.length; i++) {
      const ev   = events[i];
      const type = ev.event;
      const d    = ev.details || {};
      const time = d.time || null;

      if (type === 'goal') {
        const teamId   = parseInt(d.team?.id, 10) || null;
        const isHome   = teamId === homeId;
        const abbr     = isHome ? homeAbbr : awayAbbr;
        const oppAbbr  = isHome ? awayAbbr : homeAbbr;
        const scorer   = d.scoredBy ? `${d.scoredBy.firstName} ${d.scoredBy.lastName}`.trim() : abbr;
        const scorerId = String(d.scoredBy?.id || '');
        const assists  = (d.assists || []).map(a => `${a.firstName} ${a.lastName}`.trim());
        const isPP     = d.properties?.isPowerPlay === '1';
        const isSH     = d.properties?.isShortHanded === '1';
        const isEN     = d.properties?.isEmptyNet === '1';

        const goalKey = `${key}:push:goal:${d.game_goal_id || `${gameId}-${teamId}-${time}`}`;
        if (await kvGet(env, goalKey)) continue;
        await kvPut(env, goalKey, true, 24 * 3600);

        if (scorerId) scorerGoalCounts[scorerId] = (scorerGoalCounts[scorerId] || 0) + 1;

        const modifier = isPP ? ' (PP)' : isSH ? ' (SH)' : isEN ? ' (EN)' : '';
        const curHome  = isHome ? (lastState.homeScore + 1) : lastState.homeScore;
        const curAway  = isHome ? lastState.awayScore : (lastState.awayScore + 1);

        await send({
          title: `🚨 GOAL! ${abbr} ${isHome ? curHome : curAway}–${isHome ? curAway : curHome} ${oppAbbr}`,
          body:  `${scorer} scores!${modifier}${assists.length ? ` Assists: ${assists.slice(0,2).join(', ')}` : ''}`,
          tag:   `${key}-goal-${goalKey}`,
          url,
        }, `${label}:${abbr}`, 'goal');

        await send({
          title: `${abbr} scores. ${oppAbbr} ${isHome ? curAway : curHome}–${isHome ? curHome : curAway} ${abbr}`,
          body:  `${scorer} scores for ${abbr}${modifier}`,
          tag:   `${key}-opp-goal-${goalKey}`,
          url,
        }, `${label}:${oppAbbr}`, 'oppGoal');

        if (scorerId && scorerGoalCounts[scorerId] === 3) {
          await send({
            title: `🎩 HAT TRICK! ${scorer}`,
            body:  `${scorer} scores their 3rd goal of the game for ${abbr}!`,
            tag:   `${key}-hattrick-${gameId}-${scorerId}`,
            url,
          }, `${label}:${abbr}`, 'hatTrick');
        }
      }

      if (type === 'penalty' && d.isPowerPlay) {
        const penId = `${key}:push:pen:${d.game_penalty_id || `${gameId}-${time}`}`;
        if (await kvGet(env, penId)) continue;
        await kvPut(env, penId, true, 24 * 3600);

        const penTeamId = parseInt(d.againstTeam?.id, 10) || null;
        const ppTeamId  = penTeamId === homeId ? awayId : homeId;
        const ppAbbr    = teamCodes[ppTeamId]  || String(ppTeamId);
        const penAbbr   = teamCodes[penTeamId] || String(penTeamId);
        const mins      = parseFloat(d.minutes || '2') || 2;
        const desc      = (d.description || 'Penalty')
          .replace(/^(?:Ob|Maj|Min|Mis|Gm)-/i, '').replace(/-/g, ' ').trim();

        await send({
          title: `⚡ ${ppAbbr} Power Play!`,
          body:  `${penAbbr} — ${mins} min ${desc}`,
          tag:   `${key}-pp-${penId}`,
          url,
        }, `${label}:${ppAbbr}`, 'penalty');
      }

      // Only an extra-attacker pull, not a delayed-penalty trip to the
      // bench (hockeytechGame.js).
      if (type === 'goalie_change' && isExtraAttackerPull(events, i)) {
        const pulledTeamId  = parseInt(d.team_id, 10) || null;
        const benefitTeamId = pulledTeamId === homeId ? awayId : homeId;
        const benefitAbbr   = teamCodes[benefitTeamId] || String(benefitTeamId);
        const pulledAbbr    = teamCodes[pulledTeamId]  || String(pulledTeamId);
        const pullKey = `${key}:push:pull:${gameId}-${time}`;
        if (!(await kvGet(env, pullKey))) {
          await kvPut(env, pullKey, true, 24 * 3600);
          await send({
            title: `🥅 ${pulledAbbr} pulled their goalie!`,
            body:  `6-on-5 — empty net opportunity for ${benefitAbbr}!`,
            tag:   `${key}-pull-${pullKey}`,
            url,
          }, `${label}:${benefitAbbr}`, 'goaliePulled');
        }
      }
    }

    // ── Game over ──────────────────────────────────────────
    // Any goals since the last tick were processed above, so the final
    // score here matches the goal pushes already sent.
    if (deriveGameStatus(game) === 'final') {
      const finalKey = `${key}:push:final:${gameId}`;
      if (!(await kvGet(env, finalKey))) {
        await kvPut(env, finalKey, true, 48 * 3600);
        const hs = game.home_score ?? 0;
        const as = game.away_score ?? 0;
        // A game the pipeline already marked final skipped the scorebar
        // overlay, so ask it now for OT/SO -- once, for this push.
        const endedIn = 'ended_in' in game
          ? game.ended_in
          : (await live(env, [game], { withEndedIn: true }))[0].ended_in;
        const fin = finalLabel(endedIn);
        const ot  = endedInSuffix(endedIn);

        await send(hs > as ? {
          title: `🏆 ${homeAbbr} Win! ${homeAbbr} ${hs}–${as} ${awayAbbr}${ot}`,
          body:  'Final score — great win!',
          tag:   `${key}-win-${gameId}-home`,
          url,
        } : {
          title: `${fin}: ${homeAbbr} ${hs}–${as} ${awayAbbr}`,
          body:  'Final score.',
          tag:   `${key}-final-${gameId}-home`,
          url,
        }, `${label}:${homeAbbr}`, hs > as ? 'win' : 'loss');

        await send(as > hs ? {
          title: `🏆 ${awayAbbr} Win! ${awayAbbr} ${as}–${hs} ${homeAbbr}${ot}`,
          body:  'Final score — great win!',
          tag:   `${key}-win-${gameId}-away`,
          url,
        } : {
          title: `${fin}: ${awayAbbr} ${as}–${hs} ${homeAbbr}`,
          body:  'Final score.',
          tag:   `${key}-final-${gameId}-away`,
          url,
        }, `${label}:${awayAbbr}`, as > hs ? 'win' : 'loss');
      }
    }

    await kvPut(env, stateKey, {
      homeScore:        game.home_score ?? lastState.homeScore,
      awayScore:        game.away_score ?? lastState.awayScore,
      eventCount:       events.length,
      started:          true,
      period:           periodNum,
      scorerGoalCounts,
    }, 24 * 3600);
  }

  // Sends to subscribers whose team topic ('AHL:TOR') matches and who
  // haven't turned this event type off, then prunes expired subscriptions.
  // subId() covers both Web Push (endpoint-keyed) and native iOS
  // (token-keyed) subscribers -- see nhl.js's broadcast().
  // Send to subscribers following teamKey ('AHL:TOR') with eventType on;
  // `pair` is the game's two team keys (see shared.js's pushTargets()).
  function broadcast(env, payload, teamKey, eventType, pair) {
    return broadcastToTeam(env, payload, teamKey, eventType, { pair, tag: `${label} push`, send: sendPush });
  }

  // /today's seasons: `season` plus every regular/playoff/preseason season
  // that starts after it (from the league's season list). Just `season`
  // when the list is unavailable.
  async function todaySeasonIds(env, season) {
    const ids = new Set([Number(season)]);
    try {
      const all = (await cfg.getAllSeasons(env)) || [];
      const cur = all.find(s => Number(s.seasonId) === Number(season));
      for (const s of all) {
        if (!['regular', 'playoffs', 'preseason'].includes(s.seasonType)) continue;
        const later = cur?.startDate && s.startDate ? s.startDate > cur.startDate : Number(s.seasonId) > Number(season);
        if (later) ids.add(Number(s.seasonId));
      }
    } catch { /* season list unavailable: `season` alone */ }
    return [...ids].filter(Number.isFinite).sort((a, b) => a - b);
  }

  // Games from today through the next 6 days straight from HockeyTech's
  // scorebar (feed=modulekit&view=scorebar), as game_log-shaped rows in
  // date order -- for days game_log doesn't have yet. [] when the feed is
  // unreachable or has none.
  async function upcomingFromScorebar(env, todayStr) {
    const kvKey = `${key}:scorebar:upcoming:${todayStr}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return cached;
    try {
      const res = await htFetch(
        `${cfg.ht.base}?feed=modulekit&view=scorebar&numberofdaysback=0&numberofdaysahead=6&limit=200` +
        `&league_id=${cfg.ht.leagueId}&key=${cfg.ht.key}&client_code=${key}&site_id=${cfg.ht.siteId}&lang=en`
      );
      if (!res.ok) return [];
      const games = (await res.json())?.SiteKit?.Scorebar;
      if (!Array.isArray(games)) return [];
      const rows = games
        .filter(g => g.Date >= todayStr && parseInt(g.ID, 10) && parseInt(g.HomeID, 10) && parseInt(g.VisitorID, 10))
        .map(g => {
          const code = parseInt(g.GameStatus, 10);
          return {
            game_id:          parseInt(g.ID, 10),
            game_date:        g.Date,
            home_team_id:     parseInt(g.HomeID, 10),
            away_team_id:     parseInt(g.VisitorID, 10),
            home_score:       parseInt(g.HomeGoals, 10) || 0,
            away_score:       parseInt(g.VisitorGoals, 10) || 0,
            game_status_code: Number.isFinite(code) ? code : null,
            game_state:       g.GameStatusString || '',
            ended_in:         code === 4 ? endedInFromStatus(g.GameStatusStringLong) : null,
          };
        })
        .sort((a, b) => a.game_date.localeCompare(b.game_date) || a.game_id - b.game_id);
      await kvPut(env, kvKey, rows, 60);
      return rows;
    } catch {
      return [];
    }
  }

  // ── HTTP routes ────────────────────────────────────────────────────
  async function handle(request, env, ctx, url) {
    // GET /{league}/standings?season=90
    // L10/streak enrichment from the game log. {league}_team_seasons.wins is
    // already the season total (regulation + OT/SO), so no PWHL-style
    // regulation_wins + non_reg_wins addition. l10L counts regulation losses
    // and l10OTL OT/SO losses (same field names as /pwhl/standings);
    // streakType is 'W', 'L' or 'OT' -- an OT/SO loss starts or extends an
    // 'OT' streak, never a regulation-loss one, matching the NHL's streak
    // codes.
    if (url.pathname === `${P}/standings`) {
      const season = await seasonParam(url, env);
      return cachedJson(env, `${key}:standings:${season}`, 3600, async () => {
        const seasonType = await resolveSeasonType(env, season);
        const [rows, games] = await Promise.all([
          sbRows(`${table('team_seasons')}?season_id=eq.${season}&season_type=eq.${seasonType}&order=points.desc&limit=32`),
          sbRowsOr(
            `${table('game_log')}?season_id=eq.${season}&game_state=eq.Final&order=game_id.desc&limit=1500&select=game_id,home_team_id,away_team_id,home_score,away_score,ended_in`,
            []
          ),
        ]);
        if (rows instanceof Response) return rows;

        const teamStats = {};
        for (const g of games) {
          for (const [tid, myScore, oppScore] of [
            [g.home_team_id, g.home_score, g.away_score],
            [g.away_team_id, g.away_score, g.home_score],
          ]) {
            if (!tid) continue;
            if (!teamStats[tid]) teamStats[tid] = { games: [] };
            teamStats[tid].games.push(gameResult(myScore, oppScore, g.ended_in));
          }
        }
        const enriched = rows.map(r => {
          const ts = teamStats[r.team_id];
          if (!ts) return r;
          const last10 = ts.games.slice(0, 10);
          const l10W = last10.filter(x => x === 'W').length;
          const l10L = last10.filter(x => x === 'L').length;
          const l10OTL = last10.filter(x => x === 'OT').length;
          let streak = 0, streakType = '';
          for (const res of ts.games) {
            if (!streakType) { streakType = res; streak = 1; }
            else if (res === streakType) streak++;
            else break;
          }
          return { ...r, l10W, l10L, l10OTL, streakType, streakCount: streak };
        });
        return enriched;
      });
    }

    // GET /{league}/schedule?teamId=444&season=90
    if (url.pathname === `${P}/schedule`) {
      const season = await seasonParam(url, env);
      const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
      if (!teamId) return badRequest('teamId param required');
      // The 30-min cache holds game_log as written; live status is laid
      // over it on every read, so a game finishing shows within a minute.
      const kvKey = `${key}:schedule:${teamId}:${season}`;
      let rows = await kvGet(env, kvKey);
      if (!rows) {
        rows = await sbRows(
          `${table('game_log')}?season_id=eq.${season}&or=(home_team_id.eq.${teamId},away_team_id.eq.${teamId})&order=game_date.asc&limit=150`
        );
        if (rows instanceof Response) return rows;
        await kvPut(env, kvKey, rows, 1800);
      }
      return json(await live(env, rows));
    }

    // GET /{league}/roster?teamId=444
    // Bare player list for name resolution (shot map tooltips, etc.).
    if (url.pathname === `${P}/roster`) {
      const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
      if (!teamId) return badRequest('teamId param required');
      // 24hr — roster rarely changes
      return cachedJson(env, `${key}:roster:${teamId}`, 24 * 3600, () => sbRows(
        `${table('players')}?team_id=eq.${teamId}&select=player_id,first_name,last_name,position,jersey_number&limit=60`
      ));
    }

    // GET /{league}/players?teamId=444&season=90
    // Skater + goalie season stats for one team, plus a jersey-sorted roster
    // list for the Roster tab. Same shape as /pwhl/players.
    //
    // Every skater and goalie who played for the team that season: no row
    // cap (an AHL club dresses 45+ skaters and up to 6 goalies a season
    // with call-ups and PTOs; this used to stop at 40 and 5 without saying
    // so). Names/bio come from {league}_players by id for exactly those
    // players -- a league-wide read stops at Supabase's 1,000-row page,
    // which left about a third of a team's rows unnamed.
    if (url.pathname === `${P}/players`) {
      const season = await seasonParam(url, env);
      const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
      if (!teamId) return badRequest('teamId param required');
      return cachedJson(env, `${key}:players:${teamId}:${season}`, 3600, async () => {
        const seasonType = await resolveSeasonType(env, season);
        const bio = 'player_id,first_name,last_name,position,jersey_number,birth_date,birth_place,shoots,height_inches,weight_lbs';
        const reads = await Promise.all([
          sbRows(`${table('player_seasons')}?team_id=eq.${teamId}&season_id=eq.${season}&season_type=eq.${seasonType}&order=points.desc`),
          sbRows(`${table('goalie_seasons')}?team_id=eq.${teamId}&season_id=eq.${season}&season_type=eq.${seasonType}&order=gp.desc`),
          sbRows(`${table('players')}?team_id=eq.${teamId}&select=${bio}&limit=80`),
        ]);
        if (reads.some(r => r instanceof Response)) return sbError();
        const [skaters, goalies, rosterRaw] = reads;

        const statIds = [...new Set([...skaters, ...goalies].map(r => r.player_id))].filter(id => id != null);
        const allPlayers = statIds.length
          ? await sbRowsOr(`${table('players')}?player_id=in.(${statIds.join(',')})&select=${bio}`, rosterRaw)
          : rosterRaw;

        const nameMap = {};
        for (const p of allPlayers) {
          nameMap[p.player_id] = {
            player_name: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
            first_name: p.first_name || null,
            last_name: p.last_name || null,
            position: p.position || null,
            jersey_number: p.jersey_number || null,
            birth_date: p.birth_date || null,
            birth_place: p.birth_place || null,
            shoots: p.shoots || null,
            height_inches: p.height_inches || null,
            weight_lbs: p.weight_lbs || null,
            headshot: headshot(p.player_id),
          };
        }
        const skatersWithNames = skaters.map(s => ({ ...s, ...nameMap[s.player_id] }));
        const goaliesWithNames = goalies.map(g => ({ ...g, ...nameMap[g.player_id] }));
        const rosterFull = rosterRaw
          .map(p => ({ ...p, headshot: headshot(p.player_id) }))
          .sort((a, b) => {
            if (a.jersey_number == null && b.jersey_number == null) return 0;
            if (a.jersey_number == null) return 1;
            if (b.jersey_number == null) return -1;
            return a.jersey_number - b.jersey_number;
          });
        const result = { skaters: skatersWithNames, goalies: goaliesWithNames, roster: rosterFull };
        return result;
      });
    }

    // GET /{league}/league-players?season=90
    // All teams' skater + goalie season stats (Leaders tab), one row per
    // player: a traded player's per-team rows (eyewall-pipeline#190) are
    // combined -- counting stats summed, SV%/GAA recomputed, `teams` with
    // each team's part, team_id his current team if he played for it that
    // season, else the one he played most for (hockeytechSeasonRows.js).
    // Every row is read (paged past Supabase's 1,000-row cap) so no part of
    // a season is missed; the response keeps the top 600 skaters by points
    // (the Leaders tab reads the top 10 by points and by goals) and every
    // goalie.
    if (url.pathname === `${P}/league-players`) {
      const season = await seasonParam(url, env);
      return cachedJson(env, `${key}:leagueplayers:${season}`, 3600 * 2, async () => {
        const seasonType = await resolveSeasonType(env, season);
        const reads = await Promise.all([
          sbAllRows(`${table('player_seasons')}?season_id=eq.${season}&season_type=eq.${seasonType}&select=player_id,team_id,goals,assists,points,gp,shots,pp_goals,sh_goals,pim,plus_minus&order=player_id.asc,team_id.asc`),
          sbAllRows(`${table('goalie_seasons')}?season_id=eq.${season}&season_type=eq.${seasonType}&select=player_id,team_id,gp,wins,losses,ot_losses,gaa,sv_pct,shutouts,saves,goals_against,shots_against,toi&order=player_id.asc,team_id.asc`),
        ]);
        if (reads.some(r => r instanceof Response)) return sbError();
        const [skaterRows, goalieRows] = reads;

        const players = await sbAllRows(`${table('players')}?select=player_id,first_name,last_name,position,team_id&order=player_id.asc`);
        const nameRows = players instanceof Response ? [] : players;
        const nameMap = {};
        const currentTeams = {};
        for (const p of nameRows) {
          nameMap[p.player_id] = {
            player_name: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
            first_name: p.first_name, last_name: p.last_name, position: p.position,
          };
          currentTeams[p.player_id] = p.team_id ?? null;
        }
        const skaters = combineByPlayer(skaterRows, 'skater', currentTeams)
          .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
          .slice(0, 600);
        const goalies = combineByPlayer(goalieRows, 'goalie', currentTeams)
          .sort((a, b) => (b.sv_pct ?? -1) - (a.sv_pct ?? -1));
        const enrichSkaters = skaters.map(s => ({ ...s, ...nameMap[s.player_id] }));
        const enrichGoalies = goalies.map(g => ({ ...g, ...nameMap[g.player_id] }));
        const result = { skaters: enrichSkaters, goalies: enrichGoalies };
        return result;
      });
    }

    // GET /{league}/shots?teamId=444&season=90
    // Pages through Supabase in batches of 1000 to get past its row cap.
    // Only 'shot' and 'goal' event types exist in this data.
    if (url.pathname === `${P}/shots`) {
      const season = await seasonParam(url, env);
      const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
      if (!teamId) return badRequest('teamId param required');
      // Empty means the season's first games aren't ingested yet (they
      // land with the next nightly run): check again soon, not in an hour.
      return cachedJson(env, `${key}:shots:${teamId}:${season}`, (rows) => (rows.length ? 3600 : 300), async () => {
        const PAGE = 1000;
        const allRows = [];
        let offset = 0;
        while (true) {
          const rows = await sbRows(
            `${table('shot_events')}?team_id=eq.${teamId}&season_id=eq.${season}&order=game_id.asc`,
            { Range: `${offset}-${offset + PAGE - 1}`, 'Range-Unit': 'items', Prefer: 'count=none' }
          );
          if (rows instanceof Response) return rows;
          allRows.push(...rows);
          if (rows.length < PAGE) break;
          offset += PAGE;
        }
        console.log(`${label} shots: teamId=${teamId} season=${season} total=${allRows.length}`);
        return allRows;
      });
    }

    // GET /{league}/game-shots?gameId=1029084
    // Both teams' shots and goals in one game, for the shot map's single-
    // game view (/shots holds one team's shots only). A game's rows land
    // with the nightly run after it ends, so an empty answer is re-checked
    // after 5 minutes, not held an hour.
    if (url.pathname === `${P}/game-shots`) {
      const gameId = parseInt(url.searchParams.get('gameId') || '0', 10);
      if (!gameId) return badRequest('gameId param required');
      return cachedJson(env, `${key}:game-shots:${gameId}`, (rows) => (rows.length ? 3600 : 300), () => sbRows(
        `${table('shot_events')}?game_id=eq.${gameId}&order=period_id.asc,time_seconds.asc&limit=1000`
      ));
    }

    // GET /{league}/team-season-summary?teamId=444&season=90
    // Season-aggregate SOG for the Shot Map's "All N" summary card, plus
    // PP%/PK% from {league}_team_seasons. Deliberately no hits/blocked/
    // faceoff/penalties sections (see the module docstring) -- the
    // frontend doesn't render those cards for these leagues.
    if (url.pathname === `${P}/team-season-summary`) {
      const season = await seasonParam(url, env);
      const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
      if (!teamId) return badRequest('teamId param required');
      // A game's shots land with the next nightly run, hours after the
      // final horn: until then this is all zeros, so don't hold it an hour.
      const summaryTtl = (d) => (d.sog.car + d.sog.opp > 0 ? 3600 : 300);
      return cachedJson(env, `${key}:team-season-summary:${teamId}:${season}`, summaryTtl, async () => {
        const gameRows = await sbRows(
          `${table('game_log')}?season_id=eq.${season}&game_state=eq.Final&or=(home_team_id.eq.${teamId},away_team_id.eq.${teamId})&select=game_id`
        );
        if (gameRows instanceof Response) return gameRows;
        const gameIds = gameRows.map(g => g.game_id);

        const seasonType = await resolveSeasonType(env, season);
        const [tsRow] = await sbRowsOr(
          `${table('team_seasons')}?team_id=eq.${teamId}&season_id=eq.${season}&season_type=eq.${seasonType}&select=pp_pct,pk_pct`,
          []
        );

        // The nightly run writes a team_seasons row before opening night,
        // with pp_pct/pk_pct at 0 -- a 0.0% nobody earned. No finished
        // game, no percentage.
        if (!gameIds.length) return { teamId, season, gamesPlayed: 0, sog: { car: 0, opp: 0 }, ppPct: null, pkPct: null };

        let sogCar = 0, sogOpp = 0;
        const PAGE = 1000;
        let offset = 0;
        try {
          while (true) {
            const rows = await sbRows(
              `${table('shot_events')}?game_id=in.(${gameIds.join(',')})&select=team_id,event_type`,
              { Range: `${offset}-${offset + PAGE - 1}`, 'Range-Unit': 'items', Prefer: 'count=none' }
            );
            if (rows instanceof Response) return rows;
            for (const row of rows) {
              if (row.event_type !== 'shot' && row.event_type !== 'goal') continue;
              if (row.team_id === teamId) sogCar++; else sogOpp++;
            }
            if (rows.length < PAGE) break;
            offset += PAGE;
          }
        } catch (e) {
          return errorJson(502, { error: e.message });
        }

        const data = { teamId, season, gamesPlayed: gameIds.length, sog: { car: sogCar, opp: sogOpp }, ppPct: tsRow?.pp_pct ?? null, pkPct: tsRow?.pk_pct ?? null };
        console.log(`${label} team-season-summary: teamId=${teamId} season=${season} games=${gameIds.length}`);
        return data;
      });
    }

    // GET /{league}/player/landing?id=6681&season=90
    // Identity + one season's stat line for the player popup. Supabase-only,
    // same shape as /pwhl/player/landing.
    if (url.pathname === `${P}/player/landing`) {
      const playerId = url.searchParams.get('id');
      const seasonQ = url.searchParams.get('season');
      if (!playerId) return badRequest('id required');

      return cachedJson(env, `${key}:player:landing:${playerId}:${seasonQ || 'latest'}`, 3600, async () => {
        const playerRows = await sbRows(`${table('players')}?player_id=eq.${playerId}&select=*`);
        if (playerRows instanceof Response) return playerRows;
        if (!playerRows.length) return errorJson(404, { error: 'Player not found' });

        const player = playerRows[0];
        const statsTable = player.position === 'G' ? table('goalie_seasons') : table('player_seasons');
        // A season_id belongs to exactly one season type (90 = 2025-26 regular,
        // 92 = its playoffs), so ?season= alone picks the row -- also filtering
        // to regular returned no stats for a playoff season. With no ?season=,
        // fall back to the most recent regular season.
        //
        // A traded player has one row per team for a season once the
        // pipeline stores it that way (eyewall-pipeline#190), or one
        // league-wide row before: either way his rows for the season are
        // combined -- counting stats summed, SV%/GAA recomputed, `teams`
        // listing each team's part (hockeytechSeasonRows.js).
        const statsQuery = seasonQ
          ? `player_id=eq.${playerId}&season_id=eq.${seasonQ}&order=team_id.asc&select=*`
          : `player_id=eq.${playerId}&season_type=eq.regular&order=season_id.desc,team_id.asc&limit=20&select=*`;

        const seasonRows = (await sbRowsOr(`${statsTable}?${statsQuery}`, []))
          .filter(r => String(r.player_id) === String(playerId));
        const latest = seasonRows[0]?.season_id;
        const stats = combineSeasonRows(
          seasonRows.filter(r => r.season_id === latest),
          player.position === 'G' ? 'goalie' : 'skater',
          player.team_id ?? null
        ) || {};

        const data = { ...player, ...stats };
        return data;
      });
    }

    // GET /{league}/player/career?id=6681
    // Live proxy for HockeyTech's view=player: careerStats Total rows,
    // draft, bio bullets, photo, last 5 games. Same table shape across the
    // whole vendor, so shared.js's parsers work unmodified. No ?season= --
    // career totals are season-independent. 24hr TTL: they only change when
    // the player plays a new game.
    if (url.pathname === `${P}/player/career`) {
      const playerId = url.searchParams.get('id');
      if (!playerId) return badRequest('id required');

      return cachedJson(env, `${key}:player:career:${playerId}`, 24 * 3600, async () => {
        const htRes = await htFetch(
          `${cfg.ht.base}?feed=statviewfeed&view=player&player_id=${playerId}&site_id=0&key=${cfg.ht.key}&client_code=${key}&lang=en&league_id=&statsType=standard`
        );
        if (!htRes.ok) return errorJson(502, { error: `HockeyTech ${htRes.status}` });

        let raw;
        try {
          const parsed = unwrapJsonp(await htRes.text());
          raw = Array.isArray(parsed) ? parsed[0] : parsed;
        } catch (e) {
          return errorJson(502, { error: 'player career parse failed', detail: e.message });
        }

        const sections = raw?.careerStats?.[0]?.sections || [];
        const draftRows = extractRows(raw?.draftInfo?.[0]?.sections, '');
        const draft = (raw?.info?.display_drafts === true && draftRows.length > 0) ? draftRows[0] : null;

        const gameRows = extractRows(raw?.gameByGame?.[0]?.sections, '');
        const recentGames = gameRows.slice(-5).reverse();

        const data = {
          player_id:     parseInt(playerId, 10),
          regularSeason: extractCareerTotal(sections, 'Regular Season'),
          playoffs:      extractCareerTotal(sections, 'Playoffs'),
          bioPoints:     extractBioPoints(raw?.info?.bio),
          photo:         extractPhoto(raw?.media?.images),
          draft,
          recentGames,
        };

        return data;
      });
    }

    // GET /{league}/player-shots?playerId=6681&season=90
    // Shot-map heat map data for one skater. Skaters only -- see the module
    // docstring for why there's no goalie equivalent.
    if (url.pathname === `${P}/player-shots`) {
      const playerId = parseInt(url.searchParams.get('playerId') || '0', 10);
      const season = await seasonParam(url, env);
      if (!playerId) return badRequest('playerId required');
      return cachedJson(env, `${key}:pshots:${playerId}:${season}`, 3600 * 6, async () => {
        const rows = await sbRows(
          `${table('shot_events')}?shooter_id=eq.${playerId}&season_id=eq.${season}&select=event_type,period_id,time_seconds,x_norm,y_norm&limit=500`
        );
        if (rows instanceof Response) return rows;
        const shots = rows.map(row => {
          let x = parseFloat(row.x_norm), y = parseFloat(row.y_norm);
          if (x < 0) { x = -x; y = -y; }
          return {
            x: Math.min(Math.abs(x), 99),
            y: Math.max(-42, Math.min(42, y)),
            t: row.event_type === 'goal' ? 'g' : 's',
            p: row.period_id,
          };
        }).filter(s => !isNaN(s.x) && !isNaN(s.y));
        const result = { shots, total: shots.length };
        return result;
      });
    }

    // GET /{league}/lastgame?teamId=335&season=90
    // Most recent completed game with the opponent's abbr resolved. No
    // OT/shootout fields (no such columns on the game log).
    if (url.pathname === `${P}/lastgame`) {
      const season = await seasonParam(url, env);
      const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
      if (!teamId) return badRequest('teamId param required');
      return cachedJson(env, `${key}:lastgame:${teamId}:${season}`, 3600, async () => {
        const rows = await sbRows(
          `${table('game_log')}?season_id=eq.${season}&game_state=eq.Final&or=(home_team_id.eq.${teamId},away_team_id.eq.${teamId})&order=game_id.desc&limit=1`
        );
        if (rows instanceof Response) return rows;
        if (!rows.length) return json(null); // not cached
        const g = rows[0];
        const isHome = g.home_team_id === teamId;
        const oppId = isHome ? g.away_team_id : g.home_team_id;
        const teamScore = isHome ? g.home_score : g.away_score;
        const oppScore = isHome ? g.away_score : g.home_score;
        const result = {
          gameId: g.game_id,
          gameDate: g.game_date,
          opponentId: oppId,
          opponentAbbr: teamCodes[oppId] || String(oppId),
          isHome,
          teamScore,
          oppScore,
          won: teamScore > oppScore,
        };
        return result;
      });
    }

    // GET /{league}/summary?gameId=1028992
    // Live proxy for HockeyTech's gameSummary view -- period-by-period
    // scoring, three stars, officials/coaches, venue. Same shape as
    // /pwhl/summary, except the team stats drop hits/faceoffAttempts/
    // faceoffWins/faceoffWinPercentage: they read 0 in every real game, so
    // passing them through would show a fabricated "0 hits" stat line.
    if (url.pathname === `${P}/summary`) {
      const gameId = parseInt(url.searchParams.get('gameId') || '0', 10);
      if (!gameId) return badRequest('gameId required');

      return cachedJson(env, `${key}:gamesummary:${gameId}`, 3600, async () => {
        const htRes = await htFetch(htGameUrl('gameSummary', gameId));
        if (!htRes.ok) return errorJson(502, { error: `HockeyTech ${htRes.status}` });

        let raw;
        try {
          raw = unwrapJsonp(await htRes.text());
        } catch (e) {
          return errorJson(502, { error: 'gameSummary parse failed', detail: e.message });
        }

        const normAbbr = (abbr) => (abbr || '').replace(/^[a-z]+ - /i, '').trim();

        const periods = (raw.periods || []).map(p => ({
          info: {
            id: parseInt(p.info?.id, 10) || 1,
            shortName: p.info?.shortName || '',
            longName: p.info?.longName || '',
          },
          stats: {
            homeGoals: parseInt(p.stats?.homeGoals || 0),
            homeShots: parseInt(p.stats?.homeShots || 0),
            visitingGoals: parseInt(p.stats?.visitingGoals || 0),
            visitingShots: parseInt(p.stats?.visitingShots || 0),
          },
          goals: (p.goals || []).map(g => ({
            game_goal_id: g.game_goal_id || null,
            time: g.time || '0:00',
            team: {
              id: parseInt(g.team?.id, 10) || null,
              abbreviation: normAbbr(g.team?.abbreviation),
            },
            scoredBy: g.scoredBy ? {
              id: parseInt(g.scoredBy.id, 10) || null,
              firstName: g.scoredBy.firstName || '',
              lastName: g.scoredBy.lastName || '',
              playerImageURL: g.scoredBy.playerImageURL || null,
            } : null,
            assists: (g.assists || []).map(a => ({
              id: parseInt(a.id, 10) || null,
              firstName: a.firstName || '',
              lastName: a.lastName || '',
            })),
            properties: {
              isPowerPlay: g.properties?.isPowerPlay || '0',
              isShortHanded: g.properties?.isShortHanded || '0',
              isEmptyNet: g.properties?.isEmptyNet || '0',
              isPenaltyShot: g.properties?.isPenaltyShot || '0',
              isGameWinningGoal: g.properties?.isGameWinningGoal || '0',
            },
          })),
        }));

        const mvps = (raw.mostValuablePlayers || []).map(mvp => ({
          team: {
            id: parseInt(mvp.team?.id, 10) || null,
            abbreviation: normAbbr(mvp.team?.abbreviation),
            name: mvp.team?.name || '',
          },
          player: {
            info: {
              id: parseInt(mvp.player?.info?.id, 10) || null,
              firstName: mvp.player?.info?.firstName || '',
              lastName: mvp.player?.info?.lastName || '',
              jerseyNumber: mvp.player?.info?.jerseyNumber || null,
              position: mvp.player?.info?.position || '',
              playerImageURL: mvp.player?.info?.playerImageURL || null,
            },
            stats: mvp.player?.stats || {},
          },
          isGoalie: !!mvp.isGoalie,
          playerImage: mvp.playerImage || mvp.player?.info?.playerImageURL?.replace('/120x160/', '/240x240/') || null,
          homeTeam: mvp.homeTeam === 1 || mvp.homeTeam === true,
        }));

        const official = (o) => ({
          firstName: o.firstName || '',
          lastName: o.lastName || '',
          jerseyNumber: o.jerseyNumber != null ? parseInt(o.jerseyNumber, 10) : null,
        });
        const headCoach = (coaches) => {
          const c = (coaches || []).find(c => c.role === 'Head Coach');
          return c ? { firstName: c.firstName || '', lastName: c.lastName || '' } : null;
        };

        const stripFakeStats = (stats) => {
          if (!stats) return {};
          const rest = { ...stats };
          delete rest.hits;
          delete rest.faceoffAttempts;
          delete rest.faceoffWins;
          delete rest.faceoffWinPercentage;
          return rest;
        };

        const payload = {
          periods,
          mvps,
          venue: raw.details?.venue || null,
          officials: {
            referees: (raw.referees || []).map(official),
            linesmen: (raw.linesmen || []).map(official),
          },
          coaches: {
            home: headCoach(raw.homeTeam?.coaches),
            away: headCoach(raw.visitingTeam?.coaches),
          },
          homeTeamStats: stripFakeStats(raw.homeTeam?.stats),
          visitingTeamStats: stripFakeStats(raw.visitingTeam?.stats),
        };
        return payload;
      });
    }

    // GET /{league}/preview?gameId=1028992
    // Live proxy for HockeyTech's gameCenterPreview view (season series,
    // H2H, streaks, leaders, special teams for an upcoming game), returned
    // as-is -- the frontend reads its own fields. 30min TTL: pre-game data
    // shifts daily.
    if (url.pathname === `${P}/preview`) {
      const gameId = parseInt(url.searchParams.get('gameId') || '0', 10);
      if (!gameId) return badRequest('gameId required');
      return cachedJson(env, `${key}:gcpreview:${gameId}`, 1800, async () => {
        const htRes = await htFetch(htGameUrl('gameCenterPreview', gameId));
        if (!htRes.ok) return errorJson(502, { error: `HockeyTech ${htRes.status}` });
        let raw;
        try {
          raw = unwrapJsonp(await htRes.text());
        } catch (e) {
          return errorJson(502, { error: 'gameCenterPreview parse failed', detail: e.message });
        }
        return raw;
      });
    }

    // GET /{league}/game-box?gameId=1028992
    // Per-game player box score from {league}_skater_game_box/
    // {league}_goalie_game_box (eyewall-pipeline's {league}_game_boxscore.py).
    // No hits/faceoff/blocked-shots/skater-TOI columns -- always 0 in the feed.
    // player_name comes from the game's own gameSummary lineup first, then
    // {league}_players by id; null when neither knows the player.
    if (url.pathname === `${P}/game-box`) {
      const gameId = parseInt(url.searchParams.get('gameId') || '0', 10);
      if (!gameId) return badRequest('gameId required');
      // 5 min while a row is unnamed (gameSummary unreachable), so it fills in soon.
      const ttl = (box) => ([...box.skaters, ...box.goalies].every(r => r.player_name) ? 3600 : 300);
      return cachedJson(env, `${key}:gamebox:${gameId}`, ttl, async () => {
        const [skaters, goalies, gameRows, summary] = await Promise.all([
          sbRows(`${table('skater_game_box')}?game_id=eq.${gameId}&order=points.desc`),
          sbRows(`${table('goalie_game_box')}?game_id=eq.${gameId}`),
          sbRowsOr(`${table('game_log')}?game_id=eq.${gameId}&select=home_team_id,away_team_id`, []),
          fetchGameSummary(htGameUrl('gameSummary', gameId), cfg.ht.headers),
        ]);
        if (skaters instanceof Response || goalies instanceof Response) return sbError();
        const gameTeamIds = gameRows[0] ? [gameRows[0].home_team_id, gameRows[0].away_team_id] : [];

        const nameMap = {};
        for (const [id, p] of Object.entries(gameSummaryPlayers(summary))) nameMap[id] = p.name;
        const playerIds = [...new Set([...skaters, ...goalies].map(r => r.player_id))]
          .filter(id => id != null && !nameMap[id]);
        if (playerIds.length) {
          const nameRows = await sbRowsOr(
            `${table('players')}?player_id=in.(${playerIds.join(',')})&select=player_id,first_name,last_name`,
            []
          );
          for (const p of nameRows) {
            const name = `${p.first_name || ''} ${p.last_name || ''}`.trim();
            if (name) nameMap[p.player_id] = name;
          }
        }

        const withName = (r) => ({ ...r, player_name: nameMap[r.player_id] || null });
        const result = {
          gameId,
          homeTeamId: gameTeamIds[0] ?? null,
          awayTeamId: gameTeamIds[1] ?? null,
          skaters: skaters.map(withName),
          goalies: goalies.map(withName),
        };
        return result;
      });
    }

    // GET /{league}/player-game-log?playerId=6681&season=90
    // One player's box-score row for every game of a season, oldest first
    // (skaters[]/goalies[] -- whichever table has the player's rows). Same
    // shape as /pwhl/player-game-log; feeds the player popup's Compare-tab
    // trend chart.
    if (url.pathname === `${P}/player-game-log`) {
      const playerId = parseInt(url.searchParams.get('playerId') || '0', 10);
      const season = await seasonParam(url, env);
      if (!playerId) return badRequest('playerId required');
      return cachedJson(env, `${key}:pgamelog:${playerId}:${season}`, 3600, async () => {
        const [skaters, goalies] = await Promise.all([
          sbRows(`${table('skater_game_box')}?player_id=eq.${playerId}&season_id=eq.${season}&order=game_id.asc`),
          sbRows(`${table('goalie_game_box')}?player_id=eq.${playerId}&season_id=eq.${season}&order=game_id.asc`),
        ]);
        if (skaters instanceof Response || goalies instanceof Response) return sbError();
        return { skaters, goalies };
      });
    }

    // GET /{league}/prediction?gameId=1028992
    // Elo win probability + AI narrative from record, GF/GA, PP/PK, streaks
    // and head-to-head (hockeytechPrediction.js); streaks count every
    // non-win as a loss, same as /standings.
    if (url.pathname === `${P}/prediction`) {
      const limited = await checkAiRateLimit(env, request, `${key}-prediction`);
      if (limited) return limited;

      const gameId = parseInt(url.searchParams.get('gameId') || '0', 10);
      if (!gameId) return badRequest('gameId required');
      const forceRegen = url.searchParams.get('force') === '1';

      // French gets its own key (':fr'); English keeps the original one.
      // ':elo' so predictions cached under the old point-split win % aren't
      // served for the rest of their TTL after this deploys.
      const locale = requestLocale(url);
      const kvKey = `${key}:prediction:elo:${gameId}${localeKeySuffix(locale)}`;
      if (!forceRegen) {
        const cached = await kvGet(env, kvKey);
        if (cached) return json(cached);
      }

      const gameRows = await sbRows(`${table('game_log')}?game_id=eq.${gameId}&select=game_id,season_id,home_team_id,away_team_id`);
      if (gameRows instanceof Response) return gameRows;
      const [game] = gameRows;
      if (!game || !game.home_team_id || !game.away_team_id) {
        return errorJson(404, { error: `Game not found in ${key}_game_log` });
      }

      // Stats, prompt, Elo and AI call: hockeytechPrediction.js, shared with
      // /pwhl/prediction. A missing stat is "not available" (never 0),
      // early-season stats are blended with last regular season's, and at
      // 0 GP for both teams the prompt is built from last regular season.
      const { result, error } = await buildHockeyTechPrediction(env, predictionCfg, game, gameId, locale);
      if (error) return error;

      await kvPut(env, kvKey, result, 1800);
      return json(result);
    }

    // GET /{league}/team-seasons/compare?teamId=335&seasons=90,92
    // One team across multiple seasons. Seasons the team has no row for are
    // simply absent -- the frontend knows which seasons it asked for.
    if (url.pathname === `${P}/team-seasons/compare`) {
      const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
      const seasons = (url.searchParams.get('seasons') || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!teamId || seasons.length === 0) {
        return badRequest('teamId and seasons (comma-separated) are required');
      }
      const kvKey = `${key}:team-seasons:compare:${teamId}:${seasons.slice().sort().join(',')}`;
      return cachedJson(env, kvKey, 3600, () => sbRows(
        `${table('team_seasons')}?team_id=eq.${teamId}&season_id=in.(${seasons.join(',')})` +
        `&select=season_id,season_type,gp,wins,losses,ot_losses,shootout_losses,points,goals_for,goals_against,pp_pct,pk_pct`
      ));
    }

    // GET /{league}/team-seasons/compare-teams?teamIds=335,323&season=90
    // Two teams, same season.
    if (url.pathname === `${P}/team-seasons/compare-teams`) {
      const teamIds = (url.searchParams.get('teamIds') || '').split(',').map(s => s.trim()).filter(Boolean).map(s => parseInt(s, 10));
      const season = url.searchParams.get('season');
      if (teamIds.length !== 2 || teamIds.some(id => !id) || !season) {
        return badRequest('teamIds (exactly two, comma-separated) and season are required');
      }

      const kvKey = `${key}:team-seasons:compare-teams:${teamIds.slice().sort((a, b) => a - b).join(',')}:${season}`;
      return cachedJson(env, kvKey, 3600, () => sbRows(
        `${table('team_seasons')}?team_id=in.(${teamIds.join(',')})&season_id=eq.${season}` +
        `&select=team_id,season_id,season_type,gp,wins,losses,ot_losses,shootout_losses,points,goals_for,goals_against,pp_pct,pk_pct`
      ));
    }

    // GET /{league}/team-seasons/head-to-head?teamIds=335,323
    // All-time head-to-head between two teams across every season on record.
    // buildHeadToHeadPayload (shared.js) is sport-agnostic.
    if (url.pathname === `${P}/team-seasons/head-to-head`) {
      const teamIds = (url.searchParams.get('teamIds') || '').split(',').map(s => s.trim()).filter(Boolean).map(s => parseInt(s, 10));
      if (teamIds.length !== 2 || teamIds.some(id => !id)) {
        return badRequest('teamIds (exactly two, comma-separated) are required');
      }
      const [teamA, teamB] = teamIds;

      const kvKey = `${key}:team-seasons:head-to-head:${teamIds.slice().sort((a, b) => a - b).join(',')}`;
      return cachedJson(env, kvKey, 3600, async () => {
        const rows = await sbRows(
          `${table('game_log')}?game_state=eq.Final` +
          `&or=(and(home_team_id.eq.${teamA},away_team_id.eq.${teamB}),and(home_team_id.eq.${teamB},away_team_id.eq.${teamA}))` +
          `&select=game_id,season_id,game_date,home_team_id,away_team_id,home_score,away_score` +
          `&order=season_id.asc,game_id.asc`
        );
        if (rows instanceof Response) return rows;

        const payload = buildHeadToHeadPayload(teamA, teamB, rows.map(g => {
          const aIsHome = g.home_team_id === teamA;
          const teamAScore = aIsHome ? g.home_score : g.away_score;
          const teamBScore = aIsHome ? g.away_score : g.home_score;
          return {
            gameId: g.game_id, season: g.season_id, gameDate: g.game_date,
            teamAWon: teamAScore > teamBScore,
            teamAScore, teamBScore, homeTeam: aIsHome ? teamA : teamB,
          };
        }));

        return payload;
      });
    }

    // POST /{league}/team-seasons/head-to-head/narrative
    // AI narrative on top of the head-to-head stats above. The client posts
    // the payload it already fetched plus display names -- the Worker has
    // no team-name map (the frontend's {league}Config.js does).
    if (url.pathname === `${P}/team-seasons/head-to-head/narrative` && request.method === 'POST') {
      const limited = await checkAiRateLimit(env, request, `${key}-h2h-narrative`);
      if (limited) return limited;

      let body;
      try { body = await request.json(); } catch {
        return badRequest('Invalid JSON');
      }
      const {
        teamA, teamB, teamADisplay, teamBDisplay,
        totalMeetings, allTimeRecord, recentWindow, currentStreak, isThinSample,
      } = body || {};
      if (!teamA || !teamB || !totalMeetings || !allTimeRecord || !recentWindow) {
        return json({ narrative: null });
      }

      const kvKey = `${key}:h2h-narrative:${[teamA, teamB].slice().sort((a, b) => a - b).join(',')}`;
      return cachedJson(env, kvKey, 24 * 3600, async () => {
        const aDisplay = teamADisplay || String(teamA);
        const bDisplay = teamBDisplay || String(teamB);
        const streakLine = currentStreak
          ? `Current streak: ${currentStreak.holder === 'A' ? aDisplay : bDisplay} has won ${currentStreak.count} straight.`
          : 'No active streak.';
        const thinSampleNote = isThinSample
          ? `\nIMPORTANT: Only ${totalMeetings} meeting${totalMeetings === 1 ? '' : 's'} exist between these teams. Do not describe this as a "trend," "rivalry," or "dominance" -- that's too small a sample to support it. It's fine to note the limited history plainly.`
          : '';

        const prompt = `You are Sticks, EyeWall's hockey analyst. Write a punchy 2-3 sentence head-to-head summary for ${aDisplay} vs ${bDisplay}.

All-time record (since 2025-26): ${aDisplay} ${allTimeRecord.teamAWins}-${allTimeRecord.teamBWins} ${bDisplay}, across ${totalMeetings} meeting${totalMeetings === 1 ? '' : 's'}.
Last ${recentWindow.size}: ${aDisplay} ${recentWindow.teamAWins}-${recentWindow.teamBWins} ${bDisplay}.
${streakLine}
${thinSampleNote}
Only reference the two teams named above and the numbers given -- no player names, no invented stats or games. Plain text only, no markdown, no bullet points.`;

        try {
          const aiResponse = await generateText(env, {
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 100,
          });
          const narrative = (aiResponse.response || '').trim();
          if (!narrative) return json({ narrative: null });

          return { narrative };
        } catch (e) {
          console.error(`[${label}] head-to-head narrative AI error:`, e);
          return errorJson(502, { error: 'AI generation failed' });
        }
      });
    }

    // GET /{league}/news
    if (url.pathname === `${P}/news` && request.method === 'GET') {
      const cached = await kvGet(env, `${key}:news`);
      if (cached) return json(cached);
      ctx.waitUntil(fetchNews(env).catch(e => console.warn(`${label} news bg fetch:`, e.message)));
      return json([]);
    }

    // POST /{league}/news/bust — invalidate the news cache so the next GET refetches
    if (url.pathname === `${P}/news/bust` && request.method === 'POST') {
      const secret = url.searchParams.get('secret') || request.headers.get('x-ingest-secret');
      if (secret !== env.POLL_SECRET) return unauthorized();
      await env.CACHE.delete(`${key}:news`);
      console.log(`${label} news cache busted`);
      return json({ ok: true, busted: [`${key}:news`] });
    }

    // POST /{league}/news/ingest — articles from GitHub Actions
    // (eyewall-pipeline's nightly {league}_news.py).
    if (url.pathname === `${P}/news/ingest` && request.method === 'POST') {
      const secret = url.searchParams.get('secret') || request.headers.get('x-ingest-secret');
      if (secret !== env.POLL_SECRET) return unauthorized();
      let articles;
      try {
        articles = await request.json();
        if (!Array.isArray(articles)) throw new Error('Expected array');
      } catch (e) {
        return new Response(`Bad request: ${e.message}`, { status: 400 });
      }
      const existing = (await kvGet(env, `${key}:news`)) || [];
      const merged = [
        ...articles,
        ...existing.filter(a => !articles.find(n => n.id === a.id || normalizeLink(n.url) === normalizeLink(a.url))),
      ].sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
        .slice(0, 60);
      await kvPut(env, `${key}:news`, merged, 25 * 3600);
      console.log(`${label} news ingest: ${articles.length} new → ${merged.length} total`);
      await recordHealth(env, `${key}:pipeline-ingest`, true, { itemCount: articles.length });
      return json({ ok: true, received: articles.length, total: merged.length });
    }

    // GET /{league}/today?season=90
    // Today's games (Eastern time) with status pre/live/final.
    //
    // Reads ?season= and every season that starts after it (2026-10): the
    // current season only moves on once the next one's start date passes
    // (seasons.js), so the off-season and the days around an opener used
    // to show nothing even with the next season's games scheduled (ECHL's
    // 2026-27 opener is 10-17, two days after its 10-15 start date).
    // game_log may not carry a just-published season yet (ECHL's 2026-27
    // preseason and regular season weren't in it on 10-05), so when it has
    // no game today the HockeyTech scorebar's next week is read too, and
    // its first game day wins if it comes sooner (upcomingFromScorebar()).
    if (url.pathname === `${P}/today`) {
      const season = await seasonParam(url, env);
      return cachedJson(env, `${key}:today:${season}`, 60, async () => {
        const nowET    = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const todayStr = nowET.toISOString().slice(0, 10);
        const seasonIds = await todaySeasonIds(env, season);

        // Today's games, or the next day that has some. One query either
        // way: ask for everything from today onward in date order and keep
        // whichever date comes back first. Out of season this is what stops
        // the scoreboard from being a permanently empty "no games today".
        const rows = await sbRows(
          `${table('game_log')}?game_date=gte.${todayStr}&season_id=in.(${seasonIds.join(',')})` +
          `&select=game_id,home_team_id,away_team_id,home_score,away_score,game_state,game_status_code,game_date` +
          `&order=game_date.asc&limit=40`
        );
        if (rows instanceof Response) return rows;

        let gameDate = rows[0]?.game_date || null;
        let dayRows;
        if (gameDate !== todayStr) {
          const upcoming = await upcomingFromScorebar(env, todayStr);
          const sbDate = upcoming[0]?.game_date || null;
          if (sbDate && (!gameDate || sbDate < gameDate)) {
            gameDate = sbDate;
            dayRows = upcoming.filter(g => g.game_date === sbDate);
          }
        }
        dayRows = dayRows || await live(env, rows.filter(g => g.game_date === gameDate), { withEndedIn: true });
        const games = dayRows.map(g => {
          const status = deriveGameStatus(g);
          return {
            gameId:       g.game_id,
            gameDate:     g.game_date,
            homeTeamId:   g.home_team_id,
            awayTeamId:   g.away_team_id,
            homeTeamCode: teamCodes[g.home_team_id] || String(g.home_team_id),
            awayTeamCode: teamCodes[g.away_team_id] || String(g.away_team_id),
            homeScore:    g.home_score,
            awayScore:    g.away_score,
            status,
            // HockeyTech's own status text: a start time before puck drop
            // ("7:00 pm EST"), its live wording once under way. This feed
            // has no period/clock columns, unlike NHL's.
            statusDetail: g.game_state || null,
            // 'OT' | 'SO' once final past regulation (the scoreboard's
            // FINAL/OT), from the scorebar or game_log's ended_in.
            endedIn:      status === 'final' ? (g.ended_in ?? null) : null,
          };
        });

        return games;
      });
    }

    // GET /{league}/live/:gameId
    // Normalized live PBP from HockeyTech. Event set: goal, shot,
    // penaltyshot, penalty, goalie_change, shootout. No hit/faceoff/
    // blocked_shot -- those don't exist in this feed. Goal events already
    // carry assists/properties/on-ice players, so unlike PWHL's route
    // there's no gameSummary merge. KV TTL: 60s live, 1hr final -- 60 is
    // Cloudflare KV's minimum expiration_ttl.
    //
    // Shootout attempts are 'shootout' events whose details carry
    // shooterTeam (camelCase) and no period or time (AHL 1029078, IA@TEX
    // 2026-10-02), so they get period 7 ('SO'). They aren't goal events,
    // so counting goals gives a tie for every shootout game: once the game
    // is final the score is the game row's (game_log / scorebar), which
    // includes the shootout winner's goal.
    if (url.pathname.startsWith(`${P}/live/`)) {
      const gameId = parseInt(url.pathname.split(`${P}/live/`)[1], 10);
      if (!gameId) return badRequest('gameId required');

      const ttl = (p) => (p.gameStatus === 'final' ? 3600 : 60);
      return cachedJson(env, `${key}:live:${gameId}`, ttl, async () => {
        const pbpRes = await htFetch(htGameUrl('gameCenterPlayByPlay', gameId));
        if (!pbpRes.ok) return errorJson(502, { error: `HockeyTech PBP ${pbpRes.status}` });

        let rawEvents;
        try {
          rawEvents = unwrapJsonp(await pbpRes.text());
        } catch (e) {
          return errorJson(502, { error: 'PBP parse failed', detail: e.message });
        }

        const normPeriod = (raw) => {
          const periodMap = { 'OT1': 4, 'OT2': 5, 'OT3': 6, 'SO': 7 };
          const s = String(raw ?? '1');
          return periodMap[s] ?? (parseInt(s, 10) || 1);
        };
        const normAbbr = (abbr) => (abbr || '').replace(/^[a-z]+ - /i, '').trim();
        const timeToSeconds = (t) => {
          const parts = (t || '0:00').split(':');
          return parseInt(parts[0], 10) * 60 + parseInt(parts[parts.length - 1], 10);
        };
        const normPlayer = (p) => p ? {
          id:           parseInt(p.id, 10) || null,
          firstName:    p.firstName || '',
          lastName:     p.lastName  || '',
          jerseyNumber: p.jerseyNumber || null,
        } : null;

        const events = rawEvents.map(ev => {
          if (!ev || typeof ev !== 'object') return null;
          const type = ev.event;
          const d    = ev.details || {};
          const period      = normPeriod(d.period?.id);
          const time        = d.time || '0:00';
          const timeSeconds = timeToSeconds(time);

          const base = { eventType: type, period, time, timeSeconds };

          if (type === 'goal') {
            return {
              ...base,
              teamId:        parseInt(d.team?.id, 10) || null,
              teamAbbrev:    normAbbr(d.team?.abbreviation),
              scoredBy:      normPlayer(d.scoredBy),
              assists:       (d.assists || []).map(normPlayer),
              isPowerPlay:   d.properties?.isPowerPlay      === '1',
              isShortHanded: d.properties?.isShortHanded    === '1',
              isEmptyNet:    d.properties?.isEmptyNet       === '1',
              isPenaltyShot: d.properties?.isPenaltyShot    === '1',
              isGameWinner:  d.properties?.isGameWinningGoal === '1',
              plusPlayers:   (d.plus_players  || []).map(normPlayer),
              minusPlayers:  (d.minus_players || []).map(normPlayer),
              x: d.xLocation ?? null,
              y: d.yLocation ?? null,
            };
          }

          if (type === 'shot') {
            return {
              ...base,
              teamId:      parseInt(d.shooterTeamId, 10) || null,
              shooter:     normPlayer(d.shooter),
              goalie:      normPlayer(d.goalie),
              shotType:    d.shotType    || null,
              shotQuality: d.shotQuality || null,
              isGoal:      !!d.isGoal,
              x: d.xLocation ?? null,
              y: d.yLocation ?? null,
            };
          }

          // No coordinates: breakaway-style attempts aren't location-tracked.
          // The feed's team key is shooterTeam; shooter_team is kept as a
          // fallback for any older payload that used it.
          if (type === 'penaltyshot' || type === 'shootout') {
            return {
              ...base,
              ...(type === 'shootout' ? { period: normPeriod('SO') } : {}),
              teamId:  parseInt((d.shooterTeam ?? d.shooter_team)?.id, 10) || null,
              shooter: normPlayer(d.shooter),
              goalie:  normPlayer(d.goalie),
              isGoal:  !!d.isGoal,
            };
          }

          if (type === 'penalty') {
            return {
              ...base,
              teamId:      parseInt(d.againstTeam?.id, 10) || null,
              teamAbbrev:  normAbbr(d.againstTeam?.abbreviation),
              takenBy:     normPlayer(d.takenBy),
              servedBy:    normPlayer(d.servedBy),
              minutes:     parseFloat(d.minutes || '2') || 2,
              description: d.description || '',
              isPowerPlay: !!d.isPowerPlay,
              isBench:     !!d.isBench,
            };
          }

          if (type === 'goalie_change') {
            return {
              ...base,
              teamId:    parseInt(d.team_id, 10) || null,
              goalieIn:  normPlayer(d.goalieComingIn),
              goalieOut: normPlayer(d.goalieGoingOut),
            };
          }

          return null; // unknown/unconfirmed event type — skip
        }).filter(Boolean);

        const gameRows = await sbRowsOr(
          `${table('game_log')}?game_id=eq.${gameId}&select=game_id,home_team_id,away_team_id,home_score,away_score,game_state,game_status_code&limit=1`,
          []
        ).catch(() => []);
        const gameRow = gameRows[0] ? (await live(env, gameRows))[0] : null;

        let homeScore = 0, awayScore = 0, gameStatus = 'pre';
        if (gameRow) {
          for (const g of events.filter(e => e.eventType === 'goal')) {
            if (g.teamId === gameRow.home_team_id) homeScore++;
            else awayScore++;
          }
          gameStatus = deriveGameStatus(gameRow);
          // A final's official score counts the shootout winner's goal,
          // which no goal event carries.
          if (gameStatus === 'final' && Number.isFinite(gameRow.home_score) && Number.isFinite(gameRow.away_score)) {
            homeScore = gameRow.home_score;
            awayScore = gameRow.away_score;
          }
        }

        const payload = {
          gameId,
          homeTeamId: gameRow?.home_team_id ?? null,
          awayTeamId: gameRow?.away_team_id ?? null,
          homeScore,
          awayScore,
          gameStatus,
          events,
        };
        return payload;
      });
    }

    return errorJson(404, { error: 'Not found' });
  }

  return { handle, poll, fetchNews };
}
