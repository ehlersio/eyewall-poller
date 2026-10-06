// src/__tests__/fixtures/pwhl-241-pbp.js
// Real data: PWHL game 241 (MIN 5 @ TOR 1, 2025-12-30), the goal, penalty
// and goalie_change events of HockeyTech's gameCenterPlayByPlay in feed
// order (shots/faceoffs/hits dropped, details trimmed to the fields the
// Worker reads). MIN (2) went to the bench at P1 8:45, tied 1-1, for a
// delayed penalty called at 9:23; TOR (6) pulled for an extra attacker at
// P3 14:15, down 4-1. The P2 20:00 goalie_change is the period-end entry.

export const events = [
  {"event": "goalie_change", "details": {"period": {"id": "1"}, "time": "0:00", "team_id": "6", "goalieComingIn": {"id": 85, "firstName": "Elaine", "lastName": "Chuli", "jerseyNumber": 29}, "goalieGoingOut": null}},
  {"event": "goalie_change", "details": {"period": {"id": "1"}, "time": "0:00", "team_id": "2", "goalieComingIn": {"id": 22, "firstName": "Nicole", "lastName": "Hensley", "jerseyNumber": 29}, "goalieGoingOut": null}},
  {"event": "penalty", "details": {"period": {"id": "1"}, "time": "2:45", "againstTeam": {"id": 6, "abbreviation": "TOR"}, "isPowerPlay": true, "description": "Ob-Tripping", "minutes": "2.00"}},
  {"event": "goal", "details": {"period": {"id": "1"}, "time": "4:55", "team": {"id": 6, "abbreviation": "TOR"}, "game_goal_id": "1198", "scoredBy": {"id": 63, "firstName": "Daryl", "lastName": "Watts", "jerseyNumber": 9}}},
  {"event": "goal", "details": {"period": {"id": "1"}, "time": "6:30", "team": {"id": 2, "abbreviation": "MIN"}, "game_goal_id": "1199", "scoredBy": {"id": 191, "firstName": "Katy", "lastName": "Knoll", "jerseyNumber": 6}}},
  {"event": "goalie_change", "details": {"period": {"id": "1"}, "time": "8:45", "team_id": "2", "goalieComingIn": null, "goalieGoingOut": {"id": 22, "firstName": "Nicole", "lastName": "Hensley", "jerseyNumber": 29}}},
  {"event": "penalty", "details": {"period": {"id": "1"}, "time": "9:23", "againstTeam": {"id": 6, "abbreviation": "TOR"}, "isPowerPlay": true, "description": "Holding", "minutes": "2.00"}},
  {"event": "goalie_change", "details": {"period": {"id": "1"}, "time": "9:23", "team_id": "2", "goalieComingIn": {"id": 22, "firstName": "Nicole", "lastName": "Hensley", "jerseyNumber": 29}, "goalieGoingOut": null}},
  {"event": "goal", "details": {"period": {"id": "1"}, "time": "12:59", "team": {"id": 2, "abbreviation": "MIN"}, "game_goal_id": "1200", "scoredBy": {"id": 189, "firstName": "Britta", "lastName": "Curl-Salemme", "jerseyNumber": 77}}},
  {"event": "penalty", "details": {"period": {"id": "1"}, "time": "14:44", "againstTeam": {"id": 2, "abbreviation": "MIN"}, "isPowerPlay": true, "description": "Boarding", "minutes": "2.00"}},
  {"event": "penalty", "details": {"period": {"id": "2"}, "time": "10:23", "againstTeam": {"id": 6, "abbreviation": "TOR"}, "isPowerPlay": true, "description": "Hooking", "minutes": "2.00"}},
  {"event": "goal", "details": {"period": {"id": "2"}, "time": "11:58", "team": {"id": 2, "abbreviation": "MIN"}, "game_goal_id": "1201", "scoredBy": {"id": 25, "firstName": "Grace", "lastName": "Zumwinkle", "jerseyNumber": 13}}},
  {"event": "goal", "details": {"period": {"id": "2"}, "time": "19:54", "team": {"id": 2, "abbreviation": "MIN"}, "game_goal_id": "1202", "scoredBy": {"id": 20, "firstName": "Kendall", "lastName": "Coyne Schofield", "jerseyNumber": 26}}},
  {"event": "goalie_change", "details": {"period": {"id": "2"}, "time": "20:00", "team_id": "6", "goalieComingIn": null, "goalieGoingOut": {"id": 85, "firstName": "Elaine", "lastName": "Chuli", "jerseyNumber": 29}}},
  {"event": "goalie_change", "details": {"period": {"id": "3"}, "time": "0:00", "team_id": "6", "goalieComingIn": {"id": 211, "firstName": "Raygan", "lastName": "Kirk", "jerseyNumber": 1}, "goalieGoingOut": null}},
  {"event": "goalie_change", "details": {"period": {"id": "3"}, "time": "14:15", "team_id": "6", "goalieComingIn": null, "goalieGoingOut": {"id": 211, "firstName": "Raygan", "lastName": "Kirk", "jerseyNumber": 1}}},
  {"event": "goal", "details": {"period": {"id": "3"}, "time": "16:43", "team": {"id": 2, "abbreviation": "MIN"}, "game_goal_id": "1203", "scoredBy": {"id": 20, "firstName": "Kendall", "lastName": "Coyne Schofield", "jerseyNumber": 26}}},
  {"event": "goalie_change", "details": {"period": {"id": "3"}, "time": "16:43", "team_id": "6", "goalieComingIn": {"id": 211, "firstName": "Raygan", "lastName": "Kirk", "jerseyNumber": 1}, "goalieGoingOut": null}},
]
