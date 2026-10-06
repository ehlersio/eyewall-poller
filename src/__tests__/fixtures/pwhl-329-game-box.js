// src/__tests__/fixtures/pwhl-329-game-box.js
// Real data: PWHL game 329 (BOS 1 vs NY 4, 2026-04-25). gameSummary is
// lineupOnly -- homeTeam/visitingTeam skaters[]/goalies[] info (id, name,
// jersey) from HockeyTech's view=gameSummary, the rest of the payload
// dropped. skaterRows/goalieRows are every pwhl_skater_game_box/
// pwhl_goalie_game_box row for the game (updated_at dropped). currentRoster
// is pwhl_players for team_id in (1,4) as of 2026-10-05: 14 of the 42 box
// rows aren't on it (e.g. Jessie Eldridge, id 36, now MTL; Hadley Hartmetz,
// id 182), which is why the box score used to show them as "#18" / "#6".

export const gameSummary = {
  "homeTeam": {
    "info": {
      "id": 1,
      "abbreviation": "BOS"
    },
    "skaters": [
      {
        "info": {
          "id": 12,
          "firstName": "Megan",
          "lastName": "Keller",
          "jerseyNumber": 5
        }
      },
      {
        "info": {
          "id": 182,
          "firstName": "Hadley",
          "lastName": "Hartmetz",
          "jerseyNumber": 6
        }
      },
      {
        "info": {
          "id": 246,
          "firstName": "Haley",
          "lastName": "Winn",
          "jerseyNumber": 8
        }
      },
      {
        "info": {
          "id": 18,
          "firstName": "Sophie",
          "lastName": "Shirley",
          "jerseyNumber": 9
        }
      },
      {
        "info": {
          "id": 15,
          "firstName": "Alina",
          "lastName": "Müller",
          "jerseyNumber": 11
        }
      },
      {
        "info": {
          "id": 97,
          "firstName": "Liz",
          "lastName": "Schepers",
          "jerseyNumber": 13
        }
      },
      {
        "info": {
          "id": 255,
          "firstName": "Riley",
          "lastName": "Brengman",
          "jerseyNumber": 16
        }
      },
      {
        "info": {
          "id": 36,
          "firstName": "Jessie",
          "lastName": "Eldridge",
          "jerseyNumber": 18
        }
      },
      {
        "info": {
          "id": 259,
          "firstName": "Abby",
          "lastName": "Newhook",
          "jerseyNumber": 19
        }
      },
      {
        "info": {
          "id": 1,
          "firstName": "Hannah",
          "lastName": "Brandt",
          "jerseyNumber": 20
        }
      },
      {
        "info": {
          "id": 243,
          "firstName": "Ella",
          "lastName": "Huber",
          "jerseyNumber": 26
        }
      },
      {
        "info": {
          "id": 183,
          "firstName": "Shay",
          "lastName": "Maloney",
          "jerseyNumber": 27
        }
      },
      {
        "info": {
          "id": 8,
          "firstName": "Loren",
          "lastName": "Gabel",
          "jerseyNumber": 36
        }
      },
      {
        "info": {
          "id": 149,
          "firstName": "Jill",
          "lastName": "Saulnier",
          "jerseyNumber": 44
        }
      },
      {
        "info": {
          "id": 16,
          "firstName": "Jamie Lee",
          "lastName": "Rattray",
          "jerseyNumber": 47
        }
      },
      {
        "info": {
          "id": 232,
          "firstName": "Rylind",
          "lastName": "MacKinnon",
          "jerseyNumber": 53
        }
      },
      {
        "info": {
          "id": 185,
          "firstName": "Daniela",
          "lastName": "Pejšová",
          "jerseyNumber": 55
        }
      },
      {
        "info": {
          "id": 78,
          "firstName": "Susanna",
          "lastName": "Tapani",
          "jerseyNumber": 77
        }
      },
      {
        "info": {
          "id": 214,
          "firstName": "Noemi",
          "lastName": "Neubauerová",
          "jerseyNumber": 81
        }
      }
    ],
    "goalies": [
      {
        "info": {
          "id": 6,
          "firstName": "Aerin",
          "lastName": "Frankel",
          "jerseyNumber": 31
        },
        "stats": {
          "saves": 30,
          "shotsAgainst": 30,
          "goalsAgainst": 0,
          "timeOnIce": "60:00"
        }
      },
      {
        "info": {
          "id": 41,
          "firstName": "Abbey",
          "lastName": "Levy",
          "jerseyNumber": 39
        },
        "stats": {
          "saves": 0,
          "shotsAgainst": 0,
          "goalsAgainst": 0,
          "timeOnIce": null
        }
      }
    ]
  },
  "visitingTeam": {
    "info": {
      "id": 4,
      "abbreviation": "NY"
    },
    "skaters": [
      {
        "info": {
          "id": 206,
          "firstName": "Elle",
          "lastName": "Hartje",
          "jerseyNumber": 4
        }
      },
      {
        "info": {
          "id": 229,
          "firstName": "Maja",
          "lastName": "Nylén Persson",
          "jerseyNumber": 8
        }
      },
      {
        "info": {
          "id": 205,
          "firstName": "Sarah",
          "lastName": "Fillier",
          "jerseyNumber": 10
        }
      },
      {
        "info": {
          "id": 283,
          "firstName": "Nicole",
          "lastName": "Vallario",
          "jerseyNumber": 11
        }
      },
      {
        "info": {
          "id": 87,
          "firstName": "Jaime",
          "lastName": "Bourbonnais",
          "jerseyNumber": 14
        }
      },
      {
        "info": {
          "id": 207,
          "firstName": "Lauren",
          "lastName": "Bernard",
          "jerseyNumber": 16
        }
      },
      {
        "info": {
          "id": 285,
          "firstName": "Maddi",
          "lastName": "Wheeler",
          "jerseyNumber": 18
        }
      },
      {
        "info": {
          "id": 40,
          "firstName": "Paetyn",
          "lastName": "Levis",
          "jerseyNumber": 19
        }
      },
      {
        "info": {
          "id": 230,
          "firstName": "Allyson",
          "lastName": "Simpson",
          "jerseyNumber": 20
        }
      },
      {
        "info": {
          "id": 277,
          "firstName": "Anna",
          "lastName": "Bargman",
          "jerseyNumber": 22
        }
      },
      {
        "info": {
          "id": 249,
          "firstName": "Anne",
          "lastName": "Cherkowski",
          "jerseyNumber": 24
        }
      },
      {
        "info": {
          "id": 280,
          "firstName": "Casey",
          "lastName": "O'Brien",
          "jerseyNumber": 26
        }
      },
      {
        "info": {
          "id": 47,
          "firstName": "Micah",
          "lastName": "Zandee-Hart",
          "jerseyNumber": 28
        }
      },
      {
        "info": {
          "id": 204,
          "firstName": "Emmy",
          "lastName": "Fecteau",
          "jerseyNumber": 29
        }
      },
      {
        "info": {
          "id": 116,
          "firstName": "Clair",
          "lastName": "DeGeorge",
          "jerseyNumber": 41
        }
      },
      {
        "info": {
          "id": 30,
          "firstName": "Kristin",
          "lastName": "O'Neill",
          "jerseyNumber": 43
        }
      },
      {
        "info": {
          "id": 104,
          "firstName": "Denisa",
          "lastName": "Křížová",
          "jerseyNumber": 44
        }
      },
      {
        "info": {
          "id": 279,
          "firstName": "Kira",
          "lastName": "Juodikis",
          "jerseyNumber": 55
        }
      },
      {
        "info": {
          "id": 45,
          "firstName": "Kayla",
          "lastName": "Vespa",
          "jerseyNumber": 81
        }
      }
    ],
    "goalies": [
      {
        "info": {
          "id": 282,
          "firstName": "Callie",
          "lastName": "Shanahan",
          "jerseyNumber": 37
        },
        "stats": {
          "saves": 20,
          "shotsAgainst": 23,
          "goalsAgainst": 3,
          "timeOnIce": "59:48"
        }
      },
      {
        "info": {
          "id": 228,
          "firstName": "Kayle",
          "lastName": "Osborne",
          "jerseyNumber": 82
        },
        "stats": {
          "saves": 0,
          "shotsAgainst": 0,
          "goalsAgainst": 0,
          "timeOnIce": null
        }
      }
    ]
  }
}

export const skaterRows = [
  {"game_id": 329, "player_id": 1, "team_id": 1, "season_id": 8, "season_type": "regular", "position_raw": "C", "position_group": "F", "jersey_number": 20, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": 0, "faceoff_attempts": 8, "faceoff_wins": 4, "shots": 0, "hits": 0, "blocked_shots": 0, "toi_seconds": 682},
  {"game_id": 329, "player_id": 8, "team_id": 1, "season_id": 8, "season_type": "regular", "position_raw": "RW", "position_group": "F", "jersey_number": 36, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": 0, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 0, "hits": 0, "blocked_shots": 0, "toi_seconds": 562},
  {"game_id": 329, "player_id": 12, "team_id": 1, "season_id": 8, "season_type": "regular", "position_raw": "LD", "position_group": "D", "jersey_number": 5, "starting": true, "status": "C", "goals": 0, "assists": 2, "points": 2, "penalty_minutes": 0, "plus_minus": 1, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 1, "hits": 2, "blocked_shots": 0, "toi_seconds": 1385},
  {"game_id": 329, "player_id": 15, "team_id": 1, "season_id": 8, "season_type": "regular", "position_raw": "C", "position_group": "F", "jersey_number": 11, "starting": true, "status": "A", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": 1, "faceoff_attempts": 12, "faceoff_wins": 6, "shots": 2, "hits": 1, "blocked_shots": 0, "toi_seconds": 1241},
  {"game_id": 329, "player_id": 16, "team_id": 1, "season_id": 8, "season_type": "regular", "position_raw": "LW", "position_group": "F", "jersey_number": 47, "starting": false, "status": "A", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": 0, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 5, "hits": 1, "blocked_shots": 0, "toi_seconds": 607},
  {"game_id": 329, "player_id": 18, "team_id": 1, "season_id": 8, "season_type": "regular", "position_raw": "RW", "position_group": "F", "jersey_number": 9, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": 1, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 0, "hits": 1, "blocked_shots": 0, "toi_seconds": 790},
  {"game_id": 329, "player_id": 36, "team_id": 1, "season_id": 8, "season_type": "regular", "position_raw": "LW", "position_group": "F", "jersey_number": 18, "starting": true, "status": "", "goals": 1, "assists": 1, "points": 2, "penalty_minutes": 0, "plus_minus": 1, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 3, "hits": 1, "blocked_shots": 1, "toi_seconds": 1187},
  {"game_id": 329, "player_id": 78, "team_id": 1, "season_id": 8, "season_type": "regular", "position_raw": "C", "position_group": "F", "jersey_number": 77, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": 1, "faceoff_attempts": 14, "faceoff_wins": 8, "shots": 4, "hits": 0, "blocked_shots": 1, "toi_seconds": 926},
  {"game_id": 329, "player_id": 97, "team_id": 1, "season_id": 8, "season_type": "regular", "position_raw": "C", "position_group": "F", "jersey_number": 13, "starting": false, "status": "", "goals": 0, "assists": 2, "points": 2, "penalty_minutes": 0, "plus_minus": 2, "faceoff_attempts": 12, "faceoff_wins": 7, "shots": 1, "hits": 2, "blocked_shots": 0, "toi_seconds": 879},
  {"game_id": 329, "player_id": 149, "team_id": 1, "season_id": 8, "season_type": "regular", "position_raw": "LW", "position_group": "F", "jersey_number": 44, "starting": false, "status": "", "goals": 1, "assists": 0, "points": 1, "penalty_minutes": 2, "plus_minus": 1, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 1, "hits": 1, "blocked_shots": 0, "toi_seconds": 716},
  {"game_id": 329, "player_id": 182, "team_id": 1, "season_id": 8, "season_type": "regular", "position_raw": "RD", "position_group": "D", "jersey_number": 6, "starting": false, "status": "", "goals": 0, "assists": 1, "points": 1, "penalty_minutes": 0, "plus_minus": 1, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 0, "hits": 0, "blocked_shots": 0, "toi_seconds": 920},
  {"game_id": 329, "player_id": 183, "team_id": 1, "season_id": 8, "season_type": "regular", "position_raw": "RW", "position_group": "F", "jersey_number": 27, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": 0, "faceoff_attempts": 4, "faceoff_wins": 1, "shots": 0, "hits": 2, "blocked_shots": 0, "toi_seconds": 746},
  {"game_id": 329, "player_id": 185, "team_id": 1, "season_id": 8, "season_type": "regular", "position_raw": "LD", "position_group": "D", "jersey_number": 55, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": 2, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 0, "hits": 0, "blocked_shots": 0, "toi_seconds": 1075},
  {"game_id": 329, "player_id": 214, "team_id": 1, "season_id": 8, "season_type": "regular", "position_raw": "RD", "position_group": "D", "jersey_number": 81, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 2, "plus_minus": 0, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 0, "hits": 0, "blocked_shots": 0, "toi_seconds": 389},
  {"game_id": 329, "player_id": 232, "team_id": 1, "season_id": 8, "season_type": "regular", "position_raw": "LD", "position_group": "D", "jersey_number": 53, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 2, "plus_minus": 0, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 0, "hits": 3, "blocked_shots": 1, "toi_seconds": 864},
  {"game_id": 329, "player_id": 243, "team_id": 1, "season_id": 8, "season_type": "regular", "position_raw": "LW", "position_group": "F", "jersey_number": 26, "starting": false, "status": "", "goals": 1, "assists": 0, "points": 1, "penalty_minutes": 0, "plus_minus": 1, "faceoff_attempts": 1, "faceoff_wins": 0, "shots": 1, "hits": 1, "blocked_shots": 0, "toi_seconds": 864},
  {"game_id": 329, "player_id": 246, "team_id": 1, "season_id": 8, "season_type": "regular", "position_raw": "RD", "position_group": "D", "jersey_number": 8, "starting": true, "status": "", "goals": 1, "assists": 0, "points": 1, "penalty_minutes": 0, "plus_minus": 1, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 3, "hits": 1, "blocked_shots": 2, "toi_seconds": 1471},
  {"game_id": 329, "player_id": 255, "team_id": 1, "season_id": 8, "season_type": "regular", "position_raw": "RD", "position_group": "D", "jersey_number": 16, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 2, "plus_minus": 0, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 0, "hits": 1, "blocked_shots": 0, "toi_seconds": 852},
  {"game_id": 329, "player_id": 259, "team_id": 1, "season_id": 8, "season_type": "regular", "position_raw": "RW", "position_group": "F", "jersey_number": 19, "starting": true, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": 1, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 3, "hits": 2, "blocked_shots": 1, "toi_seconds": 1069},
  {"game_id": 329, "player_id": 283, "team_id": 4, "season_id": 8, "season_type": "regular", "position_raw": "RD", "position_group": "D", "jersey_number": 11, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": -1, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 1, "hits": 0, "blocked_shots": 0, "toi_seconds": 868},
  {"game_id": 329, "player_id": 204, "team_id": 4, "season_id": 8, "season_type": "regular", "position_raw": "RW", "position_group": "F", "jersey_number": 29, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 2, "plus_minus": -1, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 1, "hits": 2, "blocked_shots": 0, "toi_seconds": 420},
  {"game_id": 329, "player_id": 205, "team_id": 4, "season_id": 8, "season_type": "regular", "position_raw": "RW", "position_group": "F", "jersey_number": 10, "starting": true, "status": "A", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": -1, "faceoff_attempts": 7, "faceoff_wins": 5, "shots": 3, "hits": 0, "blocked_shots": 0, "toi_seconds": 1115},
  {"game_id": 329, "player_id": 206, "team_id": 4, "season_id": 8, "season_type": "regular", "position_raw": "LW", "position_group": "F", "jersey_number": 4, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": 0, "faceoff_attempts": 6, "faceoff_wins": 3, "shots": 0, "hits": 1, "blocked_shots": 2, "toi_seconds": 935},
  {"game_id": 329, "player_id": 207, "team_id": 4, "season_id": 8, "season_type": "regular", "position_raw": "LD", "position_group": "D", "jersey_number": 16, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": -1, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 0, "hits": 1, "blocked_shots": 0, "toi_seconds": 947},
  {"game_id": 329, "player_id": 285, "team_id": 4, "season_id": 8, "season_type": "regular", "position_raw": "LW", "position_group": "F", "jersey_number": 18, "starting": true, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": -1, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 3, "hits": 0, "blocked_shots": 1, "toi_seconds": 976},
  {"game_id": 329, "player_id": 30, "team_id": 4, "season_id": 8, "season_type": "regular", "position_raw": "C", "position_group": "F", "jersey_number": 43, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": 0, "faceoff_attempts": 8, "faceoff_wins": 1, "shots": 1, "hits": 2, "blocked_shots": 0, "toi_seconds": 933},
  {"game_id": 329, "player_id": 229, "team_id": 4, "season_id": 8, "season_type": "regular", "position_raw": "RD", "position_group": "D", "jersey_number": 8, "starting": true, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": -2, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 2, "hits": 0, "blocked_shots": 0, "toi_seconds": 1138},
  {"game_id": 329, "player_id": 40, "team_id": 4, "season_id": 8, "season_type": "regular", "position_raw": "RW", "position_group": "F", "jersey_number": 19, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 2, "plus_minus": -1, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 2, "hits": 1, "blocked_shots": 0, "toi_seconds": 874},
  {"game_id": 329, "player_id": 45, "team_id": 4, "season_id": 8, "season_type": "regular", "position_raw": "C", "position_group": "F", "jersey_number": 81, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": -1, "faceoff_attempts": 12, "faceoff_wins": 7, "shots": 0, "hits": 0, "blocked_shots": 0, "toi_seconds": 557},
  {"game_id": 329, "player_id": 47, "team_id": 4, "season_id": 8, "season_type": "regular", "position_raw": "LD", "position_group": "D", "jersey_number": 28, "starting": true, "status": "C", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": -2, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 2, "hits": 1, "blocked_shots": 1, "toi_seconds": 1239},
  {"game_id": 329, "player_id": 230, "team_id": 4, "season_id": 8, "season_type": "regular", "position_raw": "RD", "position_group": "D", "jersey_number": 20, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": 0, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 4, "hits": 0, "blocked_shots": 1, "toi_seconds": 1351},
  {"game_id": 329, "player_id": 87, "team_id": 4, "season_id": 8, "season_type": "regular", "position_raw": "LD", "position_group": "D", "jersey_number": 14, "starting": false, "status": "A", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": 0, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 1, "hits": 0, "blocked_shots": 1, "toi_seconds": 1429},
  {"game_id": 329, "player_id": 277, "team_id": 4, "season_id": 8, "season_type": "regular", "position_raw": "LW", "position_group": "F", "jersey_number": 22, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": 0, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 0, "hits": 0, "blocked_shots": 0, "toi_seconds": 412},
  {"game_id": 329, "player_id": 104, "team_id": 4, "season_id": 8, "season_type": "regular", "position_raw": "LW", "position_group": "F", "jersey_number": 44, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": -1, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 3, "hits": 0, "blocked_shots": 0, "toi_seconds": 968},
  {"game_id": 329, "player_id": 116, "team_id": 4, "season_id": 8, "season_type": "regular", "position_raw": "C", "position_group": "F", "jersey_number": 41, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": 0, "faceoff_attempts": 4, "faceoff_wins": 1, "shots": 1, "hits": 0, "blocked_shots": 0, "toi_seconds": 822},
  {"game_id": 329, "player_id": 279, "team_id": 4, "season_id": 8, "season_type": "regular", "position_raw": "RW", "position_group": "F", "jersey_number": 55, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": -2, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 0, "hits": 0, "blocked_shots": 0, "toi_seconds": 311},
  {"game_id": 329, "player_id": 280, "team_id": 4, "season_id": 8, "season_type": "regular", "position_raw": "C", "position_group": "F", "jersey_number": 26, "starting": true, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": -2, "faceoff_attempts": 14, "faceoff_wins": 8, "shots": 2, "hits": 1, "blocked_shots": 0, "toi_seconds": 1090},
  {"game_id": 329, "player_id": 249, "team_id": 4, "season_id": 8, "season_type": "regular", "position_raw": "RW", "position_group": "F", "jersey_number": 24, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": 0, "faceoff_attempts": 0, "faceoff_wins": 0, "shots": 4, "hits": 0, "blocked_shots": 0, "toi_seconds": 1000},
]

export const goalieRows = [
  {"game_id": 329, "player_id": 6, "team_id": 1, "season_id": 8, "season_type": "regular", "jersey_number": 31, "starting": true, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": 0, "faceoff_attempts": 0, "faceoff_wins": 0, "toi_seconds": 3600, "shots_against": 30, "goals_against": 0, "saves": 30},
  {"game_id": 329, "player_id": 41, "team_id": 1, "season_id": 8, "season_type": "regular", "jersey_number": 39, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": 0, "faceoff_attempts": 0, "faceoff_wins": 0, "toi_seconds": null, "shots_against": 0, "goals_against": 0, "saves": 0},
  {"game_id": 329, "player_id": 228, "team_id": 4, "season_id": 8, "season_type": "regular", "jersey_number": 82, "starting": false, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": 0, "faceoff_attempts": 0, "faceoff_wins": 0, "toi_seconds": null, "shots_against": 0, "goals_against": 0, "saves": 0},
  {"game_id": 329, "player_id": 282, "team_id": 4, "season_id": 8, "season_type": "regular", "jersey_number": 37, "starting": true, "status": "", "goals": 0, "assists": 0, "points": 0, "penalty_minutes": 0, "plus_minus": 0, "faceoff_attempts": 0, "faceoff_wins": 0, "toi_seconds": 3588, "shots_against": 23, "goals_against": 3, "saves": 20},
]

export const currentRoster = [
  {"player_id": 259, "first_name": "Abby", "last_name": "Newhook", "team_id": 1},
  {"player_id": 183, "first_name": "Shay", "last_name": "Maloney", "team_id": 1},
  {"player_id": 336, "first_name": "Grace", "last_name": "Dwyer", "team_id": 1},
  {"player_id": 246, "first_name": "Haley", "last_name": "Winn", "team_id": 1},
  {"player_id": 352, "first_name": "Leah", "last_name": "Stecker", "team_id": 1},
  {"player_id": 6, "first_name": "Aerin", "last_name": "Frankel", "team_id": 1},
  {"player_id": 205, "first_name": "Sarah", "last_name": "Fillier", "team_id": 4},
  {"player_id": 109, "first_name": "Gigi", "last_name": "Marvin", "team_id": 1},
  {"player_id": 280, "first_name": "Casey", "last_name": "O'Brien", "team_id": 4},
  {"player_id": 146, "first_name": "Alexa", "last_name": "Gruschow", "team_id": 4},
  {"player_id": 153, "first_name": "Carley", "last_name": "Olivier", "team_id": 4},
  {"player_id": 148, "first_name": "Madison", "last_name": "Packer", "team_id": 4},
  {"player_id": 356, "first_name": "Carina", "last_name": "DiAntonio", "team_id": 4},
  {"player_id": 186, "first_name": "Klára", "last_name": "Peslarová", "team_id": 1},
  {"player_id": 333, "first_name": "Emma", "last_name": "Peschel", "team_id": 4},
  {"player_id": 256, "first_name": "Olivia", "last_name": "Mobley", "team_id": 1},
  {"player_id": 229, "first_name": "Maja Nylén", "last_name": "Persson", "team_id": 4},
  {"player_id": 278, "first_name": "Kaley", "last_name": "Doyle", "team_id": 4},
  {"player_id": 344, "first_name": "Elisa", "last_name": "Holopainen", "team_id": 4},
  {"player_id": 33, "first_name": "Chloé", "last_name": "Aurard-Bushee", "team_id": 4},
  {"player_id": 106, "first_name": "McKenna", "last_name": "Brand", "team_id": 1},
  {"player_id": 151, "first_name": "Emily", "last_name": "Curlett", "team_id": 4},
  {"player_id": 112, "first_name": "Lauren", "last_name": "MacInnis", "team_id": 1},
  {"player_id": 7, "first_name": "Kaleigh", "last_name": "Fratkin", "team_id": 1},
  {"player_id": 78, "first_name": "Susanna", "last_name": "Tapani", "team_id": 1},
  {"player_id": 12, "first_name": "Megan", "last_name": "Keller", "team_id": 1},
  {"player_id": 398, "first_name": "Makenna", "last_name": "Webster", "team_id": 4},
  {"player_id": 245, "first_name": "Kristýna", "last_name": "Kaltounková", "team_id": 4},
  {"player_id": 87, "first_name": "Jaime", "last_name": "Bourbonnais", "team_id": 4},
  {"player_id": 85, "first_name": "Elaine", "last_name": "Chuli", "team_id": 4},
  {"player_id": 154, "first_name": "Lindsey", "last_name": "Post", "team_id": 4},
  {"player_id": 19, "first_name": "Emma", "last_name": "Söderberg", "team_id": 1},
  {"player_id": 113, "first_name": "Cami", "last_name": "Kronish", "team_id": 1},
  {"player_id": 18, "first_name": "Sophie", "last_name": "Shirley", "team_id": 1},
  {"player_id": 97, "first_name": "Liz", "last_name": "Schepers", "team_id": 1},
  {"player_id": 40, "first_name": "Paetyn", "last_name": "Levis", "team_id": 4},
  {"player_id": 116, "first_name": "Clair", "last_name": "DeGeorge", "team_id": 4},
  {"player_id": 207, "first_name": "Lauren", "last_name": "Bernard", "team_id": 4},
  {"player_id": 150, "first_name": "Taylor", "last_name": "Baker", "team_id": 4},
  {"player_id": 10, "first_name": "Jess", "last_name": "Healey", "team_id": 1},
  {"player_id": 14, "first_name": "Nicole", "last_name": "Kosta", "team_id": 1},
  {"player_id": 231, "first_name": "Noora", "last_name": "Tulus", "team_id": 4},
  {"player_id": 110, "first_name": "Amanda", "last_name": "Pelkey", "team_id": 1},
  {"player_id": 175, "first_name": "Kelly", "last_name": "Babstock", "team_id": 1},
  {"player_id": 243, "first_name": "Ella", "last_name": "Huber", "team_id": 1},
  {"player_id": 149, "first_name": "Jill", "last_name": "Saulnier", "team_id": 1},
  {"player_id": 262, "first_name": "Amanda", "last_name": "Thiele", "team_id": 1},
  {"player_id": 206, "first_name": "Elle", "last_name": "Hartje", "team_id": 4},
  {"player_id": 277, "first_name": "Anna", "last_name": "Bargman", "team_id": 4},
  {"player_id": 104, "first_name": "Denisa", "last_name": "Křížová", "team_id": 4},
  {"player_id": 47, "first_name": "Micah", "last_name": "Zandee-Hart", "team_id": 4},
  {"player_id": 282, "first_name": "Callie", "last_name": "Shanahan", "team_id": 4},
  {"player_id": 147, "first_name": "Savannah", "last_name": "Norcross", "team_id": 4},
  {"player_id": 111, "first_name": "Taylor", "last_name": "Wenczkowski", "team_id": 1},
  {"player_id": 3, "first_name": "Emma", "last_name": "Buckles", "team_id": 1},
  {"player_id": 107, "first_name": "Sammy", "last_name": "Davis", "team_id": 1},
  {"player_id": 152, "first_name": "Johanna", "last_name": "Fällman", "team_id": 4},
  {"player_id": 131, "first_name": "Olivia", "last_name": "Knowles", "team_id": 4},
  {"player_id": 46, "first_name": "Olivia", "last_name": "Zafuto", "team_id": 1},
  {"player_id": 368, "first_name": "Katelyn", "last_name": "Roberts", "team_id": 4},
  {"player_id": 8, "first_name": "Loren", "last_name": "Gabel", "team_id": 1},
  {"player_id": 283, "first_name": "Nicole", "last_name": "Vallario", "team_id": 4},
  {"player_id": 212, "first_name": "Laura", "last_name": "Kluge", "team_id": 1},
  {"player_id": 371, "first_name": "Jaden", "last_name": "Bogden", "team_id": 1},
  {"player_id": 51, "first_name": "Amanda", "last_name": "Boulier", "team_id": 1},
  {"player_id": 1, "first_name": "Hannah", "last_name": "Brandt", "team_id": 1},
  {"player_id": 394, "first_name": "Maeve", "last_name": "Kelly", "team_id": 1},
  {"player_id": 279, "first_name": "Kira", "last_name": "Juodikis", "team_id": 4},
  {"player_id": 232, "first_name": "Rylind", "last_name": "MacKinnon", "team_id": 1},
  {"player_id": 392, "first_name": "Naomi", "last_name": "Boucher", "team_id": 4},
  {"player_id": 204, "first_name": "Emmy", "last_name": "Fecteau", "team_id": 4},
  {"player_id": 380, "first_name": "Grace", "last_name": "Wolfe", "team_id": 4},
  {"player_id": 383, "first_name": "Jenna", "last_name": "Goodwin", "team_id": 1},
  {"player_id": 217, "first_name": "Taylor", "last_name": "House", "team_id": 1},
  {"player_id": 251, "first_name": "Dayle", "last_name": "Ross", "team_id": 4},
]
