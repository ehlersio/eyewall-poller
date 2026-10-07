/**
 * hockeytechGameDetail.js — EyeWall Analytics Worker
 *
 * Per-game detail the pipeline writes for every HockeyTech league (PWHL,
 * AHL, ECHL) that the game-box and schedule routes serve (contract C6,
 * audit 2026-10-06 Phase 3):
 *   - {league}_goal_on_ice: one row per skater on the ice for a goal
 *     (game_goal_id, scoring_team_id, player_id, on_ice_for, strength
 *     flags), from the PBP goal events' plus_players/minus_players.
 *   - {league}_penalty_shots: one row per penalty shot (team_id,
 *     player_id = shooter, goalie_id, period_id, time_seconds, is_goal).
 *   - {league}_game_win_probs: the Elo home-win probability for a game
 *     (eyewall-pipeline's hockeytech_elo.py), written before it's played.
 * Each read tolerates its table not existing yet (sbRowsIfTable()): the
 * AHL/ECHL goal_on_ice tables arrive with an owner-run migration.
 */

import { SB_URL, sbRowsIfTable } from './shared.js';
import { hockeytechPeriodNumber } from './hockeytechGame.js';

// 'M:SS' for seconds into a period, or null.
export function periodClock(seconds) {
  const n = Number(seconds);
  if (seconds == null || !Number.isFinite(n) || n < 0) return null;
  return `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
}

const truthy = v => v === true || v === 1 || v === '1' || v === 'true';

// One strength code per goal: a penalty-shot goal first, then the
// man-advantage state, then an empty net; 'EV' otherwise. `flags` are
// goal_on_ice's is_* columns or gameSummary's properties (isPowerPlay ...).
export function goalStrength(flags = {}) {
  if (truthy(flags.is_penalty_shot ?? flags.isPenaltyShot)) return 'PS';
  if (truthy(flags.is_power_play ?? flags.isPowerPlay)) return 'PP';
  if (truthy(flags.is_short_handed ?? flags.isShortHanded)) return 'SH';
  if (truthy(flags.is_empty_net ?? flags.isEmptyNet)) return 'EN';
  return 'EV';
}

const personName = p => `${p?.firstName || ''} ${p?.lastName || ''}`.trim() || null;

// gameSummary's goals in game order (periods[].goals[]).
function summaryGoals(summary) {
  const out = [];
  for (const period of summary?.periods || []) {
    for (const g of period?.goals || []) {
      const id = parseInt(g?.game_goal_id, 10);
      if (!id) continue;
      out.push({
        id,
        period: hockeytechPeriodNumber(g.period?.id ?? period.info?.id),
        time: g.time || null,
        team_id: parseInt(g.team?.id, 10) || null,
        scorer_id: parseInt(g.scoredBy?.id, 10) || null,
        scorer_name: personName(g.scoredBy),
        assist_ids: (g.assists || []).map(a => parseInt(a?.id, 10)).filter(Boolean),
        properties: g.properties || {},
      });
    }
  }
  return out;
}

// The game-box `goals` array: [{ period, time, team_id, scorer_id,
// scorer_name, assist_ids, plus_player_ids, minus_player_ids, strength }].
// Empty when goal_on_ice has no rows for the game (not processed yet).
// Otherwise every goal in the game's gameSummary, in order, with its
// on-ice skaters from goal_on_ice (none for a goal it has no rows for,
// e.g. a penalty-shot goal); without a summary (HockeyTech unreachable)
// each goal_on_ice goal, with period/time/scorer unknown (null).
export function buildGoals(onIceRows, summary) {
  if (!onIceRows?.length) return [];
  const byGoal = new Map();
  for (const r of onIceRows) {
    const id = Number(r.game_goal_id);
    if (!id) continue;
    if (!byGoal.has(id)) byGoal.set(id, { team_id: r.scoring_team_id ?? null, flags: r, plus: [], minus: [] });
    const g = byGoal.get(id);
    if (r.player_id == null) continue;
    (r.on_ice_for ? g.plus : g.minus).push(Number(r.player_id));
  }
  const sorted = ids => [...new Set(ids)].sort((a, b) => a - b);

  const goals = summaryGoals(summary).map(g => {
    const onIce = byGoal.get(g.id);
    byGoal.delete(g.id);
    return {
      period: g.period,
      time: g.time,
      team_id: g.team_id ?? onIce?.team_id ?? null,
      scorer_id: g.scorer_id,
      scorer_name: g.scorer_name,
      assist_ids: g.assist_ids,
      plus_player_ids: sorted(onIce?.plus || []),
      minus_player_ids: sorted(onIce?.minus || []),
      strength: goalStrength(onIce ? onIce.flags : g.properties),
    };
  });
  for (const [, onIce] of [...byGoal].sort((a, b) => a[0] - b[0])) {
    goals.push({
      period: null,
      time: null,
      team_id: onIce.team_id,
      scorer_id: null,
      scorer_name: null,
      assist_ids: [],
      plus_player_ids: sorted(onIce.plus),
      minus_player_ids: sorted(onIce.minus),
      strength: goalStrength(onIce.flags),
    });
  }
  return goals;
}

// The game-box `penaltyShots` array: [{ period, time, team_id, shooter_id,
// shooter_name, goalie_id, result }], in game order. The feed records only
// whether a penalty shot scored (isGoal), not whether the goalie stopped
// it or it went wide, so a shot that didn't score is 'miss' ("no goal"),
// never 'save'.
export function buildPenaltyShots(rows, names = {}) {
  return [...(rows || [])]
    .sort((a, b) => (a.period_id ?? 0) - (b.period_id ?? 0) || (a.time_seconds ?? 0) - (b.time_seconds ?? 0))
    .map(r => ({
      period: r.period_id ?? null,
      time: periodClock(r.time_seconds),
      team_id: r.team_id ?? null,
      shooter_id: r.player_id ?? null,
      shooter_name: names[r.player_id] || null,
      goalie_id: r.goalie_id ?? null,
      result: r.is_goal ? 'goal' : 'miss',
    }));
}

// Both tables' rows for one game: { onIce, shots }, each [] when the
// table is missing, has no rows, or the read fails -- they're extra
// detail on a box score, never a reason to fail it.
export async function fetchGameDetailRows(league, gameId) {
  const read = async (name, order) => {
    try {
      const rows = await sbRowsIfTable(`${SB_URL}/rest/v1/${league}_${name}?game_id=eq.${gameId}&order=${order}&select=*`);
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  };
  const [onIce, shots] = await Promise.all([
    read('goal_on_ice', 'game_goal_id.asc,player_id.asc'),
    read('penalty_shots', 'period_id.asc,time_seconds.asc'),
  ]);
  return { onIce, shots };
}

// { [gameId]: home_win_prob } for one team's games in a season, from
// {league}_game_win_probs; {} when there are none or the read fails.
export async function fetchWinProbs(league, season, teamId) {
  try {
    const rows = await sbRowsIfTable(
      `${SB_URL}/rest/v1/${league}_game_win_probs?season_id=eq.${season}` +
      `&or=(home_team_id.eq.${teamId},away_team_id.eq.${teamId})&select=game_id,home_win_prob&order=game_id.asc&limit=200`
    );
    if (!Array.isArray(rows)) return {};
    return Object.fromEntries(rows
      .filter(r => r.home_win_prob != null && Number.isFinite(Number(r.home_win_prob)))
      .map(r => [r.game_id, Number(r.home_win_prob)]));
  } catch {
    return {};
  }
}

// Schedule rows with `winProb: { home, away, source: 'elo' }` on each game
// that has a probability; other rows unchanged.
export function withWinProbs(rows, probs) {
  return rows.map(r => {
    const home = probs[r.game_id];
    if (home == null) return r;
    return { ...r, winProb: { home, away: Math.round((1 - home) * 10000) / 10000, source: 'elo' } };
  });
}
