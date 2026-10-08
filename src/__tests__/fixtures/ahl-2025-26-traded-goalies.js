// src/__tests__/fixtures/ahl-2025-26-traded-goalies.js
// Real data: the two goalies traded within the AHL's 2025-26 regular
// season (season 90), as ahl_goalie_seasons stores them (one row per team,
// eyewall-pipeline#190) and ahl_players names them -- fetched from Supabase
// 2026-10-08. `toi` is whole minutes here (HockeyTech view=players'
// minutes_played), which /ahl/league-players couldn't parse, so both came
// back with gaa null. Each team's minutes/GA/GAA match HockeyTech's
// view=player for the same season (checked 2026-10-08).
//   Laurent Brossoit (4961, now SD 404): RFD (372) 6 GP, SJ (405) 22 GP.
//   Hunter Shepard (8647, now LAV 415): BEL (413) 15 GP, LAV (415) 4 GP.

export const goalieSeasons = [
  { player_id: 4961, team_id: 372, season_id: 90, season_type: 'regular', gp: 6, wins: 3, losses: 3, ot_losses: 0, gaa: 3.38, sv_pct: 0.901, shutouts: 0, saves: 182, goals_against: 20, shots_against: 202, toi: '355' },
  { player_id: 4961, team_id: 405, season_id: 90, season_type: 'regular', gp: 22, wins: 12, losses: 8, ot_losses: 1, gaa: 2.97, sv_pct: 0.901, shutouts: 0, saves: 582, goals_against: 64, shots_against: 646, toi: '1294' },
  { player_id: 8647, team_id: 413, season_id: 90, season_type: 'regular', gp: 15, wins: 6, losses: 7, ot_losses: 2, gaa: 3.65, sv_pct: 0.885, shutouts: 0, saves: 416, goals_against: 54, shots_against: 470, toi: '887' },
  { player_id: 8647, team_id: 415, season_id: 90, season_type: 'regular', gp: 4, wins: 1, losses: 2, ot_losses: 0, gaa: 2.4, sv_pct: 0.899, shutouts: 0, saves: 71, goals_against: 8, shots_against: 79, toi: '200' },
]

export const players = [
  { player_id: 4961, first_name: 'Laurent', last_name: 'Brossoit', position: 'G', team_id: 404 },
  { player_id: 8647, first_name: 'Hunter', last_name: 'Shepard', position: 'G', team_id: 415 },
]
