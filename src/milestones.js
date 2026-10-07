/**
 * milestones.js — which rows of the shared `milestones` table belong to a
 * sport, for /milestones (nhl.js) and /milestones/latest (worker.js).
 */

import { resolveNHLSeason, resolvePWHLSeason, resolveAHLSeason, resolveECHLSeason } from './seasons.js';

// The shared `milestones` table tells NHL from PWHL rows by is_pwhl and
// scopes each to the league's live-resolved season (`season`: NHL
// "20262027", PWHL/AHL/ECHL the HockeyTech season_id). AHL/ECHL rows
// (eyewall-pipeline's hockeytech_milestones.py, 2026-10) are told apart by
// a `sport` column ('ahl' | 'echl'); until the table has it the read 400s,
// which the routes answer as "no milestones" (sbRowsIfTable()).
export const MILESTONE_SPORTS = ['nhl', 'pwhl', 'ahl', 'echl'];

export async function milestoneScope(env, sport) {
  if (sport === 'pwhl') {
    const season = (await resolvePWHLSeason(env)).seasonId;
    return { season, filter: `is_pwhl=eq.true&season=eq.${season}` };
  }
  if (sport === 'ahl' || sport === 'echl') {
    const season = (await (sport === 'ahl' ? resolveAHLSeason(env) : resolveECHLSeason(env))).seasonId;
    return { season, filter: `sport=eq.${sport}&season=eq.${season}` };
  }
  const season = await resolveNHLSeason(env);
  return { season, filter: `is_pwhl=eq.false&season=eq.${season}` };
}
