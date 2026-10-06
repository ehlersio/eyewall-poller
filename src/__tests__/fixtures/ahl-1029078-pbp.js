// src/__tests__/fixtures/ahl-1029078-pbp.js
// Real data: AHL game 1029078 (IA @ TEX, 2026-10-02, TEX won 4-3 in a
// shootout), the goal and shootout events of HockeyTech's
// gameCenterPlayByPlay in feed order (shots, penalties and goalie changes
// dropped; details trimmed). Shootout events carry shooterTeam and no
// period/time; Mike Sgarbossa's attempt for TEX (380) is the only goal.

export const events = [
  {"event": "goal", "details": {"period": {"id": "1"}, "time": "4:04", "team": {"id": 380, "abbreviation": "TEX"}, "game_goal_id": "153526", "scoredBy": {"id": 10989, "firstName": "Jack", "lastName": "Anderson", "jerseyNumber": 18}, "properties": {"isPowerPlay": "0", "isShortHanded": "0", "isEmptyNet": "0", "isGameWinningGoal": "0"}}},
  {"event": "goal", "details": {"period": {"id": "1"}, "time": "8:48", "team": {"id": 380, "abbreviation": "TEX"}, "game_goal_id": "153527", "scoredBy": {"id": 10147, "firstName": "Kyle", "lastName": "Looft", "jerseyNumber": 37}, "properties": {"isPowerPlay": "0", "isShortHanded": "0", "isEmptyNet": "0", "isGameWinningGoal": "0"}}},
  {"event": "goal", "details": {"period": {"id": "1"}, "time": "13:59", "team": {"id": 389, "abbreviation": "IA"}, "game_goal_id": "153532", "scoredBy": {"id": 11085, "firstName": "Rieger", "lastName": "Lorenz", "jerseyNumber": 77}, "properties": {"isPowerPlay": "0", "isShortHanded": "0", "isEmptyNet": "0", "isGameWinningGoal": "0"}}},
  {"event": "goal", "details": {"period": {"id": "2"}, "time": "4:28", "team": {"id": 389, "abbreviation": "IA"}, "game_goal_id": "153537", "scoredBy": {"id": 10313, "firstName": "Hunter", "lastName": "Haight", "jerseyNumber": 37}, "properties": {"isPowerPlay": "1", "isShortHanded": "0", "isEmptyNet": "0", "isGameWinningGoal": "0"}}},
  {"event": "goal", "details": {"period": {"id": "3"}, "time": "8:40", "team": {"id": 389, "abbreviation": "IA"}, "game_goal_id": "153551", "scoredBy": {"id": 11085, "firstName": "Rieger", "lastName": "Lorenz", "jerseyNumber": 77}, "properties": {"isPowerPlay": "0", "isShortHanded": "0", "isEmptyNet": "0", "isGameWinningGoal": "0"}}},
  {"event": "goal", "details": {"period": {"id": "3"}, "time": "19:38", "team": {"id": 380, "abbreviation": "TEX"}, "game_goal_id": "153556", "scoredBy": {"id": 10999, "firstName": "Dylan", "lastName": "Hryckowian", "jerseyNumber": 14}, "properties": {"isPowerPlay": "0", "isShortHanded": "0", "isEmptyNet": "0", "isGameWinningGoal": "0"}}},
  {"event": "shootout", "details": {"shooter": {"id": 6426, "firstName": "Justin", "lastName": "Kirkland", "jerseyNumber": 23}, "goalie": {"id": 6535, "firstName": "Brandon", "lastName": "Halverson", "jerseyNumber": 31}, "isGoal": false, "shooterTeam": {"id": 389, "abbreviation": "IA"}}},
  {"event": "shootout", "details": {"shooter": {"id": 10648, "firstName": "Emil", "lastName": "Hemming", "jerseyNumber": 39}, "goalie": {"id": 10305, "firstName": "William", "lastName": "Rousseau", "jerseyNumber": 35}, "isGoal": false, "shooterTeam": {"id": 380, "abbreviation": "TEX"}}},
  {"event": "shootout", "details": {"shooter": {"id": 9859, "firstName": "Caedan", "lastName": "Bankier", "jerseyNumber": 19}, "goalie": {"id": 6535, "firstName": "Brandon", "lastName": "Halverson", "jerseyNumber": 31}, "isGoal": false, "shooterTeam": {"id": 389, "abbreviation": "IA"}}},
  {"event": "shootout", "details": {"shooter": {"id": 4589, "firstName": "Mike", "lastName": "Sgarbossa", "jerseyNumber": 17}, "goalie": {"id": 10305, "firstName": "William", "lastName": "Rousseau", "jerseyNumber": 35}, "isGoal": true, "shooterTeam": {"id": 380, "abbreviation": "TEX"}}},
  {"event": "shootout", "details": {"shooter": {"id": 10313, "firstName": "Hunter", "lastName": "Haight", "jerseyNumber": 37}, "goalie": {"id": 6535, "firstName": "Brandon", "lastName": "Halverson", "jerseyNumber": 31}, "isGoal": false, "shooterTeam": {"id": 389, "abbreviation": "IA"}}},
]
