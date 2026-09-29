/**
 * hockeytechPrediction.js — EyeWall Analytics Worker
 *
 * The body of /pwhl/prediction (pwhl.js) and /ahl/prediction +
 * /echl/prediction (hockeytech.js): Elo win probability plus an AI
 * narrative built from {league}_team_seasons. The three routes were
 * near-copies, and all three fed the AI made-up numbers the same way NHL's
 * /prediction/analyze did before 2026-09-29: `(pp_pct ?? 0) * 100` and
 * `goals_for / (gp || 1)` turned a team at 0 GP, or a missing stat, into
 * "PP%: 0.0% · PK%: 0.0%" and "GF/GA 0.00", which the AI then wrote up as
 * a real weakness. This follows the NHL fix (nhl.js, PRs #153/#154):
 *
 *   - A missing stat reads "not available" and the AI is told not to cite
 *     it. PP%/PK% also count as missing when the row has no power plays /
 *     times shorthanded: the pipeline writes pp_pct = pk_pct = 0.0 for
 *     those (seen on 0-GP pwhl_team_seasons rows), which isn't a real 0%.
 *   - Early in a season each stat is blended with the same team's
 *     last-regular-season number by games played (shared.js's blendStat(),
 *     EARLY_SEASON_K); from k games on, this season's number stands alone.
 *     During the playoffs, "last season" is the regular season just played.
 *   - When neither team has played yet (or the game is a preseason game),
 *     the prompt is a preseason-style one built from last regular season's
 *     numbers -- this season has nothing to add.
 *   - Expected score is null when either team's goal rates are unavailable.
 *   - The league-average line is the mean of real team values, labeled
 *     with its season and team count, only when at least 3/4 of the league
 *     has the stat.
 *
 * Response shape is unchanged: expHome/expAway may now be null.
 */

import { sbRows, sbRowsOr, errorJson, SB_URL, generateText, localizePrompt, EARLY_SEASON_K, blendStat, describeStat, fmtPct, fmtRate, asPct, leagueSpecialTeams, leagueAverageLine, expectedScore } from './shared.js';

// 2025 -> "2025-26". Same startYear-based label the season-comparison
// picker shows for these leagues.
function yearLabel(startYear) {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/**
 * The regular season before `seasonId`, or null if there isn't one (or the
 * season list is unavailable). For a playoff season that's the regular
 * season just played; for a preseason, last year's.
 *
 * `seasons` is getAllPWHLSeasons()/getAllAHLSeasons()/getAllECHLSeasons()'s
 * list: [{ seasonId, seasonType, startYear, startDate? }]. AHL/ECHL rows
 * carry startDate and are ordered by it. PWHL's don't (and its list skips
 * hidden seasons, which the current preseason can be), so PWHL goes by id:
 * HockeyTech numbers PWHL seasons in order (1 regular, 2 preseason,
 * 3 playoffs, ... 10 preseason, 11 regular).
 */
export function priorRegularSeason(seasons, seasonId) {
  if (!Array.isArray(seasons)) return null;
  const id = Number(seasonId);
  const cur = seasons.find(s => Number(s.seasonId) === id);
  const regulars = seasons.filter(s => s.seasonType === 'regular' && Number(s.seasonId) !== id);
  const earlier = cur?.startDate
    ? regulars.filter(s => s.startDate && s.startDate < cur.startDate)
    : regulars.filter(s => Number(s.seasonId) < id);
  if (!earlier.length) return null;
  const prior = earlier.reduce((a, b) => {
    if (a.startDate && b.startDate && a.startDate !== b.startDate) return b.startDate > a.startDate ? b : a;
    return Number(b.seasonId) > Number(a.seasonId) ? b : a;
  });
  return { seasonId: Number(prior.seasonId), label: `${yearLabel(prior.startYear)} regular season` };
}

// pp_pct/pk_pct as percentages, or null when the row has no real value:
// no row, a null column, or zero power plays / times shorthanded (the
// pipeline stores 0.0 there, which isn't a real 0%).
const ppOf = r => (r && r.pp_pct != null && r.pp_opportunities !== 0 ? asPct(r.pp_pct) : null);
const pkOf = r => (r && r.pk_pct != null && r.times_shorthanded !== 0 ? asPct(r.pk_pct) : null);
const perGame = (r, key) => (r && r.gp > 0 && r[key] != null ? r[key] / r.gp : null);

/**
 * One team's prompt stats: each a blendStat() result (or null when
 * neither season has it). `row` is this season's team_seasons row, `last`
 * last regular season's; either may be missing. Weighted by the row's own
 * gp -- a 0-GP row (or none) contributes nothing.
 */
export function teamPredictionStats(row, last, { corsi = false } = {}) {
  const gp = row?.gp || 0;
  const K = EARLY_SEASON_K;
  const stats = {
    gp,
    gf: blendStat(perGame(row, 'goals_for'), gp, perGame(last, 'goals_for'), K.goals),
    ga: blendStat(perGame(row, 'goals_against'), gp, perGame(last, 'goals_against'), K.goals),
    pp: blendStat(ppOf(row), gp, ppOf(last), K.specialTeams),
    pk: blendStat(pkOf(row), gp, pkOf(last), K.specialTeams),
  };
  if (corsi) {
    // pwhl_team_seasons stores corsi_for_pct[_5v5] already as percentages
    // (pwhl_stats.py::run_team_shot_totals[_5v5]) -- no asPct().
    stats.cf5 = blendStat(gp > 0 ? row?.corsi_for_pct_5v5 ?? null : null, gp, last?.gp > 0 ? last.corsi_for_pct_5v5 ?? null : null, K.shots);
    stats.cfAll = blendStat(gp > 0 ? row?.corsi_for_pct ?? null : null, gp, last?.gp > 0 ? last.corsi_for_pct ?? null : null, K.shots);
  }
  return stats;
}

// League-average rows: every team that played, with the same
// "no power plays isn't 0%" rule as ppOf()/pkOf().
function leagueAverage(rows, seasonText, floor) {
  const played = rows.filter(r => r.gp > 0).map(r => ({
    pp_pct: r.pp_opportunities === 0 ? null : r.pp_pct,
    pk_pct: r.times_shorthanded === 0 ? null : r.pk_pct,
  }));
  // At least 3/4 of the league: of that season's rows, and never fewer
  // than 3/4 of the league's smallest recent size (`floor`), so a partial
  // import can't pass for the league.
  const minTeams = Math.max(floor, Math.ceil(0.75 * rows.length));
  return leagueAverageLine(leagueSpecialTeams(played, minTeams), seasonText);
}

// Streak from the season's Final games (newest first). Every non-win
// extends a losing streak; PWHL's OT/SO losses ('O') included.
function streakFor(games, teamId) {
  const results = games
    .filter(g => g.home_team_id === teamId || g.away_team_id === teamId)
    .map(g => {
      const isHomeG = g.home_team_id === teamId;
      const my = isHomeG ? g.home_score : g.away_score;
      const opp = isHomeG ? g.away_score : g.home_score;
      return my > opp ? 'W' : 'L';
    });
  let streak = 0, streakType = '';
  for (const res of results) {
    if (!streakType) { streakType = res; streak = 1; }
    else if (res === streakType) streak++;
    else break;
  }
  return streak ? `${streakType}${streak}` : 'unknown';
}

function h2hRecordFor(games, homeId, awayId) {
  const h2hGames = games.filter(g =>
    (g.home_team_id === homeId && g.away_team_id === awayId) ||
    (g.home_team_id === awayId && g.away_team_id === homeId)
  );
  const homeWins = h2hGames.filter(g => {
    const homeWasHome = g.home_team_id === homeId;
    const myScore = homeWasHome ? g.home_score : g.away_score;
    const oppScore = homeWasHome ? g.away_score : g.home_score;
    return myScore > oppScore;
  }).length;
  return h2hGames.length > 0 ? `${homeWins}-${h2hGames.length - homeWins}` : 'no prior meetings';
}

/**
 * @param {object} env
 * @param {object} cfg
 * @param {string} cfg.key          'pwhl' | 'ahl' | 'echl' -- table prefix
 * @param {string} cfg.label        'PWHL' | 'AHL' | 'ECHL'
 * @param {string} cfg.article      'a' | 'an' ("an AHL hockey analytics assistant")
 * @param {object} cfg.teamCodes    { [teamId]: abbr }
 * @param {Function} cfg.getSeasonTypes (env) => { [seasonId]: seasonType } | null
 * @param {Function} cfg.getSeasons     (env) => [{ seasonId, seasonType, startYear, startDate? }] | null
 * @param {string} cfg.gameLogSelect  select= for the season's Final games
 * @param {string[]} cfg.recordFields  team_seasons columns joined into "W-L-OTL"
 * @param {boolean} cfg.corsi       whether team_seasons has Corsi columns (PWHL)
 * @param {string} cfg.playoffFocus what a playoff prompt says to focus on
 * @param {number} cfg.leagueAvgFloor fewest teams a league average may use
 * @param {number} cfg.eloInitial, cfg.eloHomeAdvantage
 * @param {object} game  { season_id, home_team_id, away_team_id }
 * @returns {Promise<{ result: object } | { error: Response }>}
 */
export async function buildHockeyTechPrediction(env, cfg, game, gameId, locale) {
  const { key, label, teamCodes } = cfg;
  const teamSeasons = `${SB_URL}/rest/v1/${key}_team_seasons`;
  const seasonId = game.season_id;
  const homeId = game.home_team_id;
  const awayId = game.away_team_id;

  const [seasonTypeMap, seasons] = await Promise.all([
    cfg.getSeasonTypes(env),
    Promise.resolve().then(() => cfg.getSeasons(env)).catch(() => null),
  ]);
  const seasonType = seasonTypeMap?.[String(seasonId)] || 'regular';
  const isPlayoff = seasonType === 'playoffs';
  // Only regular-season and playoff stats describe a team; a preseason
  // game's own numbers (and its game log) don't count toward anything.
  const countsForStats = seasonType === 'regular' || isPlayoff;
  const prior = priorRegularSeason(seasons, seasonId);
  const priorLabel = prior?.label ?? 'last season';

  const [curRows, priorRows, games, eloRows] = await Promise.all([
    // Every team's row, not just these two -- the rest feed the league average.
    countsForStats ? sbRows(`${teamSeasons}?season_id=eq.${seasonId}&season_type=eq.${seasonType}`) : [],
    prior ? sbRows(`${teamSeasons}?season_id=eq.${prior.seasonId}&season_type=eq.regular`) : [],
    countsForStats
      ? sbRowsOr(`${SB_URL}/rest/v1/${key}_game_log?season_id=eq.${seasonId}&game_state=eq.Final&order=game_id.desc&limit=500&select=${cfg.gameLogSelect}`, [])
      : [],
    // Optional: without ratings both teams are rated at the mean (see below).
    sbRowsOr(`${SB_URL}/rest/v1/${key}_team_elo_ratings?team_id=in.(${homeId},${awayId})&select=team_id,rating`, []).catch(() => []),
  ]);
  if (curRows instanceof Response) return { error: curRows };
  if (priorRows instanceof Response) return { error: priorRows };

  const homeAbbr = teamCodes[homeId] || `T${homeId}`;
  const awayAbbr = teamCodes[awayId] || `T${awayId}`;
  const home = curRows.find(t => t.team_id === homeId);
  const away = curRows.find(t => t.team_id === awayId);
  const homeLast = priorRows.find(t => t.team_id === homeId);
  const awayLast = priorRows.find(t => t.team_id === awayId);
  const h = teamPredictionStats(home, homeLast, { corsi: cfg.corsi });
  const a = teamPredictionStats(away, awayLast, { corsi: cfg.corsi });

  const hasAnything = s => s.gp > 0 || ['gf', 'ga', 'pp', 'pk'].some(k => s[k]);
  if (!hasAnything(h) && !hasAnything(a)) {
    return { error: errorJson(404, { error: `No ${label} stats available yet for ${homeAbbr} or ${awayAbbr} (this season or ${priorLabel})` }) };
  }

  // Neither team has played (or it's a preseason game): last regular
  // season's numbers are the whole picture.
  const noGamesYet = !countsForStats || (h.gp === 0 && a.gp === 0);

  const homeStreak = countsForStats ? streakFor(games, homeId) : 'N/A (preseason)';
  const awayStreak = countsForStats ? streakFor(games, awayId) : 'N/A (preseason)';
  const h2hRecord = countsForStats ? h2hRecordFor(games, homeId, awayId) : 'no games played yet this season';

  // Shot-attempt share (PWHL only): 5v5 when both teams have it, else
  // all-situations, else nothing.
  let corsiSource = 'unavailable', hCorsi = null, aCorsi = null;
  if (cfg.corsi) {
    if (h.cf5 && a.cf5) { corsiSource = '5v5'; hCorsi = h.cf5; aCorsi = a.cf5; }
    else if (h.cfAll && a.cfAll) { corsiSource = 'all_situations'; hCorsi = h.cfAll; aCorsi = a.cfAll; }
  }
  const notPurelyThisSeason = s => s && (s.cur == null || (s.prior != null && s.gp < s.k));
  let corsiCaveat = corsiSource === '5v5'
    ? '5-on-5 shot-attempt share (goals+shots+blocked), not all-situations.'
    : corsiSource === 'all_situations'
      ? 'All-situations shot-attempt share (goals+shots+blocked), not 5-on-5 filtered.'
      : 'Shot-attempt share unavailable for this team/season yet.';
  if (corsiSource !== 'unavailable') {
    if (noGamesYet) corsiCaveat += ` From the ${priorLabel} -- not this season's form.`;
    else if (notPurelyThisSeason(hCorsi) || notPurelyThisSeason(aCorsi)) corsiCaveat += ` Early-season estimate, blended with the ${priorLabel}.`;
  }
  const corsiLabel = corsiSource === '5v5' ? 'Shot-attempt share (Corsi For%, 5-on-5)' : 'Shot-attempt share (Corsi For%, all situations)';
  const corsiInstruction = !cfg.corsi
    ? `Shot-attempt/possession data is not available for ${label} -- do not reference Corsi, possession, or shot-attempt share.`
    : corsiSource === '5v5'
      ? 'The shot-attempt numbers below are 5-ON-5 filtered — describe it as "5v5 shot-attempt share" or "possession," accurately reflecting that scope.'
      : corsiSource === 'all_situations'
        ? 'The shot-attempt numbers below are ALL-SITUATIONS (not 5-on-5 only) — describe it as "shot-attempt share," not as a 5v5/possession-only stat.'
        : 'Shot-attempt data is unavailable for one or both teams — do not reference Corsi or possession.';

  // Pythagorean expected score from the (blended) goal rates; null when
  // either team's are unavailable.
  const { expCar: expHome, expOpp: expAway } = expectedScore(h.gf?.value, h.ga?.value, a.gf?.value, a.ga?.value, true);

  // League-average PP%/PK%: this regular season's once every team has a
  // special-teams-sized sample, last regular season's until then (and
  // always during the playoffs, where only playoff teams have rows).
  const curSeason = Array.isArray(seasons) ? seasons.find(s => Number(s.seasonId) === Number(seasonId)) : null;
  const currentSettled = seasonType === 'regular' && curRows.length > 0 &&
    curRows.every(r => (r.gp || 0) >= EARLY_SEASON_K.specialTeams);
  const leagueLine = currentSettled
    ? leagueAverage(curRows, curSeason ? `${yearLabel(curSeason.startYear)} regular season` : 'this regular season', cfg.leagueAvgFloor)
    : prior ? leagueAverage(priorRows, priorLabel, cfg.leagueAvgFloor) : null;

  // Win probability — Elo (eyewall-pipeline's hockeytech_elo.py writes
  // {league}_team_elo_ratings), same model as NHL: expected score with the
  // home team's rating + the home advantage. Replaced an additive point
  // split that backtested worse than a coin flip and gave the home team 0%
  // whenever the two teams' stats tied, e.g. every season opener
  // (docs/hockeytech_elo_backtest_results.md in eyewall-pipeline). A team
  // with no row (expansion team, or ratings unreachable) is rated at the
  // mean, so the worst case is a plain home-ice edge (~55%).
  const ratingOf = (teamId) => eloRows.find(r => r.team_id === teamId)?.rating ?? cfg.eloInitial;
  const homeWinPct = Math.round(100 / (1 + 10 ** ((ratingOf(awayId) - ratingOf(homeId) - cfg.eloHomeAdvantage) / 400)));

  const recordText = row => {
    if (!row || cfg.recordFields.some(f => row[f] == null)) return 'not available';
    const pts = row.points != null ? `${row.points} pts, ` : '';
    return `${cfg.recordFields.map(f => row[f]).join('-')} (${pts}${row.gp ?? 0} GP)`;
  };
  const assistant = `You are EyeWall Analytics, ${cfg.article} ${label} hockey analytics assistant.`;
  const expLine = expHome != null ? `Expected score (Pythagorean${noGamesYet ? `, from the ${priorLabel} rates` : ''}): ${homeAbbr} ${expHome} - ${awayAbbr} ${expAway}\n` : '';

  let prompt;
  if (noGamesYet) {
    const orNA = (s, fmt) => (s ? fmt(s.value) : 'not available');
    const lastLine = (abbr, last, s, cf) => {
      if (!last) return `${abbr}, ${priorLabel}: not available`;
      return `${abbr}, ${priorLabel}: ${recordText(last)}, ` +
        `GF/GA per game: ${orNA(s.gf, fmtRate)} / ${orNA(s.ga, fmtRate)}, ` +
        `PP%: ${orNA(s.pp, fmtPct)}, PK%: ${orNA(s.pk, fmtPct)}` +
        (corsiSource !== 'unavailable' ? `, ${corsiLabel}: ${orNA(cf, fmtPct)}` : '');
    };
    const situation = !countsForStats
      ? 'this is a preseason game'
      : isPlayoff
        ? 'neither team has played a playoff game yet'
        : 'neither team has played a game yet this season';
    const context = !countsForStats
      ? 'Preseason game'
      : isPlayoff ? 'PLAYOFFS — no playoff games played yet' : 'Season opener — no games played yet this season';
    prompt = `${assistant} Write a sharp, data-driven ${isPlayoff ? 'playoff' : 'PRESEASON'} analysis — ${situation}. The win probability below is from a live-updated Elo rating (it carries over, so it already reflects each team's recent trajectory); everything else is final numbers from the ${priorLabel}, for context. 2-3 sentences only. Be specific about the numbers and be clear they're from the ${priorLabel}, not current form. Don't cite any stat marked "not available". No filler. No "In this matchup" opener. ${corsiInstruction}

Game: ${homeAbbr} (HOME) vs ${awayAbbr} (AWAY)
Context: ${context}

${lastLine(homeAbbr, homeLast, h, hCorsi)}
${lastLine(awayAbbr, awayLast, a, aCorsi)}${leagueLine ? `\n${leagueLine}` : ''}

${expLine}Model win probability (Elo): ${homeAbbr} ${homeWinPct}%

Write the analysis now. Mention the single most decisive factor from the ${priorLabel}${expHome != null ? ' and a concrete expected-score range' : ''}.`;
  } else {
    const words = isPlayoff ? { current: 'these playoffs', estimate: 'small-sample estimate' } : undefined;
    const statBlock = (abbr, row, s, streak, cf) => [
      `${abbr} stats:`,
      `- Record: ${recordText(row)}`,
      `- ${describeStat('GF per game', s.gf, priorLabel, fmtRate, words)}`,
      `- ${describeStat('GA per game', s.ga, priorLabel, fmtRate, words)}`,
      `- ${describeStat('PP%', s.pp, priorLabel, fmtPct, words)}`,
      `- ${describeStat('PK%', s.pk, priorLabel, fmtPct, words)}`,
      ...(cfg.corsi ? [`- ${corsiSource !== 'unavailable' ? describeStat(corsiLabel, cf, priorLabel, fmtPct, words) : `${corsiLabel}: not available`}`] : []),
      ...(streak !== 'unknown' ? [`- Current streak: ${streak}`] : []),
    ].join('\n');

    const all = [h, a].flatMap(s => ['gf', 'ga', 'pp', 'pk', 'cf5', 'cfAll'].map(k => s[k]));
    const blended = all.some(s => s && s.prior != null && (s.cur == null || s.gp < s.k));
    const smallSample = all.some(s => s && s.prior == null && s.cur != null && s.gp < s.k);
    const current = isPlayoff ? 'these playoffs' : 'this season';
    const notes = [];
    if (blended) {
      notes.push(isPlayoff
        ? `Note: the playoffs are a small sample. A stat marked "small-sample estimate" blends the playoff numbers with the ${priorLabel}, weighted by games played — treat the estimate as the team's level, and don't call anything a strength or weakness from the playoff games alone. A stat marked "none these playoffs yet" is the ${priorLabel} number.`
        : `Note: it's early in the season. A stat marked "early-season estimate" blends this season's small sample with the ${priorLabel}, weighted by games played — treat the estimate as the team's level, and don't call anything a strength or weakness from this season's small sample alone. A stat marked "none this season yet" is the ${priorLabel} number.`);
    }
    if (smallSample) {
      notes.push(`Note: a stat marked "small sample" has only a few games ${current} and no ${priorLabel} number to steady it — don't read much into it.`);
    }

    prompt = `${assistant} Write a sharp, data-driven pre-game analysis. 2-3 sentences only. Be specific about the numbers. No filler. No "In this matchup" opener. ${corsiInstruction}

Game: ${homeAbbr} (HOME) vs ${awayAbbr} (AWAY)
Context: ${isPlayoff ? 'PLAYOFFS' : 'Regular Season'}

${statBlock(homeAbbr, home, h, homeStreak, hCorsi)}

${statBlock(awayAbbr, away, a, awayStreak, aCorsi)}
${leagueLine ? `\n${leagueLine}\n` : ''}
Head-to-head ${current}: ${homeAbbr} ${h2hRecord}
${expLine}Model win probability: ${homeAbbr} ${homeWinPct}%${isPlayoff ? `\n\nNote: This is a playoff game. Ignore regular season points — focus on ${cfg.playoffFocus}.` : ''}
${notes.length ? `\n${notes.join('\n')}\n` : ''}Don't cite any stat marked "not available".

Write the analysis now. Mention the single most decisive factor, one risk or concern${expHome != null ? ', and a concrete expected-score range' : ''}.`;
  }

  let narrative = '';
  try {
    const aiResponse = await generateText(env, {
      messages: [{ role: 'user', content: localizePrompt(prompt, locale) }],
    });
    narrative = aiResponse.response?.trim() || '';
  } catch (e) {
    console.error(`${label} prediction AI error:`, e);
  }
  if (!narrative) return { error: errorJson(502, { error: 'Empty AI response' }) };

  const result = {
    gameId,
    homeTeamId: homeId,
    awayTeamId: awayId,
    homeAbbr,
    awayAbbr,
    isPlayoff,
    homeWinPct,
    awayWinPct: 100 - homeWinPct,
    winModel: 'elo',
    expHome: expHome != null ? parseFloat(expHome) : null,
    expAway: expAway != null ? parseFloat(expAway) : null,
    narrative,
    h2hRecord,
    homeStreak,
    awayStreak,
  };
  if (cfg.corsi) {
    // One decimal, like NHL's corsiForPct (a blend is otherwise 52.73076923...).
    const round1 = s => (s ? Math.round(s.value * 10) / 10 : null);
    result.corsiForPct = { home: round1(hCorsi), away: round1(aCorsi) };
    result.corsiCaveat = corsiCaveat;
  }
  result.generatedAt = new Date().toISOString();
  return { result };
}
