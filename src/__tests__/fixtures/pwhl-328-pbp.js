// src/__tests__/fixtures/pwhl-328-pbp.js
// Real data: PWHL game 328 (TOR @ OTT, 2026-04-25). pbpRows are the
// penalty and goalie_change rows of pwhl_pbp_events for the game (id/
// created_at dropped). gameSummary is the lineup from HockeyTech's
// view=gameSummary (see pwhl-329-game-box.js). currentRoster is pwhl_players
// for team_id in (5,6) as of 2026-10-05: the P2 penalties' Taylor House
// (217) and Alexa Vasko (101) aren't on it, so /pwhl/pbp used to return
// them unnamed and the app showed "Unknown".

export const game = { home_team_id: 5, away_team_id: 6 }

export const gameSummary = {
  "homeTeam": {
    "info": {
      "id": 5,
      "abbreviation": "OTT"
    },
    "skaters": [
      {
        "info": {
          "id": 71,
          "firstName": "Jocelyne",
          "lastName": "Larocque",
          "jerseyNumber": 3
        }
      },
      {
        "info": {
          "id": 242,
          "firstName": "Rory",
          "lastName": "Guilday",
          "jerseyNumber": 5
        }
      },
      {
        "info": {
          "id": 219,
          "firstName": "Stephanie",
          "lastName": "Markowski",
          "jerseyNumber": 6
        }
      },
      {
        "info": {
          "id": 289,
          "firstName": "Kathryn",
          "lastName": "Reilly",
          "jerseyNumber": 8
        }
      },
      {
        "info": {
          "id": 101,
          "firstName": "Alexa",
          "lastName": "Vasko",
          "jerseyNumber": 10
        }
      },
      {
        "info": {
          "id": 38,
          "firstName": "Brooke",
          "lastName": "Hobson",
          "jerseyNumber": 11
        }
      },
      {
        "info": {
          "id": 88,
          "firstName": "Kateřina",
          "lastName": "Mrázová",
          "jerseyNumber": 16
        }
      },
      {
        "info": {
          "id": 57,
          "firstName": "Gabbie",
          "lastName": "Hughes",
          "jerseyNumber": 17
        }
      },
      {
        "info": {
          "id": 58,
          "firstName": "Brianne",
          "lastName": "Jenner",
          "jerseyNumber": 19
        }
      },
      {
        "info": {
          "id": 217,
          "firstName": "Taylor",
          "lastName": "House",
          "jerseyNumber": 22
        }
      },
      {
        "info": {
          "id": 241,
          "firstName": "Sarah",
          "lastName": "Wozniewicz",
          "jerseyNumber": 23
        }
      },
      {
        "info": {
          "id": 118,
          "firstName": "Emma",
          "lastName": "Greco",
          "jerseyNumber": 25
        }
      },
      {
        "info": {
          "id": 53,
          "firstName": "Emily",
          "lastName": "Clark",
          "jerseyNumber": 26
        }
      },
      {
        "info": {
          "id": 192,
          "firstName": "Brooke",
          "lastName": "McQuigge",
          "jerseyNumber": 27
        }
      },
      {
        "info": {
          "id": 286,
          "firstName": "Peyton",
          "lastName": "Hemp",
          "jerseyNumber": 29
        }
      },
      {
        "info": {
          "id": 72,
          "firstName": "Rebecca",
          "lastName": "Leslie",
          "jerseyNumber": 37
        }
      },
      {
        "info": {
          "id": 240,
          "firstName": "Fanuza",
          "lastName": "Kadirova",
          "jerseyNumber": 71
        }
      },
      {
        "info": {
          "id": 115,
          "firstName": "Michela",
          "lastName": "Cava",
          "jerseyNumber": 86
        }
      },
      {
        "info": {
          "id": 223,
          "firstName": "Ronja",
          "lastName": "Savolainen",
          "jerseyNumber": 88
        }
      }
    ],
    "goalies": [
      {
        "info": {
          "id": 238,
          "firstName": "Sanni",
          "lastName": "Ahola",
          "jerseyNumber": 1
        },
        "stats": {
          "saves": 0,
          "shotsAgainst": 0,
          "goalsAgainst": 0,
          "timeOnIce": null
        }
      },
      {
        "info": {
          "id": 222,
          "firstName": "Gwyneth",
          "lastName": "Philips",
          "jerseyNumber": 33
        },
        "stats": {
          "saves": 41,
          "shotsAgainst": 41,
          "goalsAgainst": 0,
          "timeOnIce": "60:00"
        }
      }
    ]
  },
  "visitingTeam": {
    "info": {
      "id": 6,
      "abbreviation": "TOR"
    },
    "skaters": [
      {
        "info": {
          "id": 68,
          "firstName": "Kali",
          "lastName": "Flanagan",
          "jerseyNumber": 6
        }
      },
      {
        "info": {
          "id": 63,
          "firstName": "Daryl",
          "lastName": "Watts",
          "jerseyNumber": 9
        }
      },
      {
        "info": {
          "id": 311,
          "firstName": "Hanna",
          "lastName": "Baskin",
          "jerseyNumber": 10
        }
      },
      {
        "info": {
          "id": 317,
          "firstName": "Kiara",
          "lastName": "Zanon",
          "jerseyNumber": 11
        }
      },
      {
        "info": {
          "id": 67,
          "firstName": "Renata",
          "lastName": "Fast",
          "jerseyNumber": 14
        }
      },
      {
        "info": {
          "id": 56,
          "firstName": "Savannah",
          "lastName": "Harmon",
          "jerseyNumber": 15
        }
      },
      {
        "info": {
          "id": 44,
          "firstName": "Ella",
          "lastName": "Shelton",
          "jerseyNumber": 17
        }
      },
      {
        "info": {
          "id": 65,
          "firstName": "Jesse",
          "lastName": "Compher",
          "jerseyNumber": 18
        }
      },
      {
        "info": {
          "id": 313,
          "firstName": "Sara",
          "lastName": "Hjalmarsson",
          "jerseyNumber": 19
        }
      },
      {
        "info": {
          "id": 244,
          "firstName": "Emma",
          "lastName": "Gentry",
          "jerseyNumber": 20
        }
      },
      {
        "info": {
          "id": 54,
          "firstName": "Kristin",
          "lastName": "Della Rovere",
          "jerseyNumber": 21
        }
      },
      {
        "info": {
          "id": 66,
          "firstName": "Maggie",
          "lastName": "Connors",
          "jerseyNumber": 22
        }
      },
      {
        "info": {
          "id": 100,
          "firstName": "Natalie",
          "lastName": "Spooner",
          "jerseyNumber": 24
        }
      },
      {
        "info": {
          "id": 316,
          "firstName": "Clara",
          "lastName": "Van Wieren",
          "jerseyNumber": 25
        }
      },
      {
        "info": {
          "id": 73,
          "firstName": "Emma",
          "lastName": "Maltais",
          "jerseyNumber": 27
        }
      },
      {
        "info": {
          "id": 76,
          "firstName": "Blayre",
          "lastName": "Turnbull",
          "jerseyNumber": 40
        }
      },
      {
        "info": {
          "id": 26,
          "firstName": "Claire",
          "lastName": "Dalton",
          "jerseyNumber": 42
        }
      },
      {
        "info": {
          "id": 86,
          "firstName": "Emma",
          "lastName": "Woods",
          "jerseyNumber": 67
        }
      },
      {
        "info": {
          "id": 200,
          "firstName": "Anna",
          "lastName": "Kjellbin",
          "jerseyNumber": 71
        }
      }
    ],
    "goalies": [
      {
        "info": {
          "id": 211,
          "firstName": "Raygan",
          "lastName": "Kirk",
          "jerseyNumber": 1
        },
        "stats": {
          "saves": 28,
          "shotsAgainst": 30,
          "goalsAgainst": 2,
          "timeOnIce": "55:01"
        }
      },
      {
        "info": {
          "id": 85,
          "firstName": "Elaine",
          "lastName": "Chuli",
          "jerseyNumber": 29
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

export const pbpRows = [
  {"game_id": 328, "season_id": 8, "event_type": "goalie_change", "raw_event_type": null, "period_id": 1, "time_seconds": 0, "team_id": 6, "player_id": null, "player_name": null, "secondary_player_id": null, "secondary_player_name": null, "description": null, "is_power_play": false, "is_bench_penalty": false, "penalty_minutes": null, "x_location": null, "y_location": null, "situation_code": null, "season_type": "regular"},
  {"game_id": 328, "season_id": 8, "event_type": "goalie_change", "raw_event_type": null, "period_id": 1, "time_seconds": 0, "team_id": 5, "player_id": null, "player_name": null, "secondary_player_id": null, "secondary_player_name": null, "description": null, "is_power_play": false, "is_bench_penalty": false, "penalty_minutes": null, "x_location": null, "y_location": null, "situation_code": null, "season_type": "regular"},
  {"game_id": 328, "season_id": 8, "event_type": "penalty", "raw_event_type": null, "period_id": 2, "time_seconds": 321, "team_id": 5, "player_id": 217, "player_name": null, "secondary_player_id": 217, "secondary_player_name": null, "description": "Illegal Body Checking", "is_power_play": true, "is_bench_penalty": false, "penalty_minutes": 2, "x_location": null, "y_location": null, "situation_code": null, "season_type": "regular"},
  {"game_id": 328, "season_id": 8, "event_type": "penalty", "raw_event_type": null, "period_id": 2, "time_seconds": 707, "team_id": 5, "player_id": 101, "player_name": null, "secondary_player_id": 101, "secondary_player_name": null, "description": "Illegal Body Checking", "is_power_play": true, "is_bench_penalty": false, "penalty_minutes": 2, "x_location": null, "y_location": null, "situation_code": null, "season_type": "regular"},
  {"game_id": 328, "season_id": 8, "event_type": "penalty", "raw_event_type": null, "period_id": 3, "time_seconds": 369, "team_id": 5, "player_id": 118, "player_name": null, "secondary_player_id": 118, "secondary_player_name": null, "description": "Hooking", "is_power_play": true, "is_bench_penalty": false, "penalty_minutes": 2, "x_location": null, "y_location": null, "situation_code": null, "season_type": "regular"},
  {"game_id": 328, "season_id": 8, "event_type": "goalie_change", "raw_event_type": null, "period_id": 3, "time_seconds": 857, "team_id": 6, "player_id": null, "player_name": null, "secondary_player_id": null, "secondary_player_name": null, "description": null, "is_power_play": false, "is_bench_penalty": false, "penalty_minutes": null, "x_location": null, "y_location": null, "situation_code": null, "season_type": "regular"},
  {"game_id": 328, "season_id": 8, "event_type": "goalie_change", "raw_event_type": null, "period_id": 3, "time_seconds": 938, "team_id": 6, "player_id": null, "player_name": null, "secondary_player_id": null, "secondary_player_name": null, "description": null, "is_power_play": false, "is_bench_penalty": false, "penalty_minutes": null, "x_location": null, "y_location": null, "situation_code": null, "season_type": "regular"},
  {"game_id": 328, "season_id": 8, "event_type": "goalie_change", "raw_event_type": null, "period_id": 3, "time_seconds": 982, "team_id": 6, "player_id": null, "player_name": null, "secondary_player_id": null, "secondary_player_name": null, "description": null, "is_power_play": false, "is_bench_penalty": false, "penalty_minutes": null, "x_location": null, "y_location": null, "situation_code": null, "season_type": "regular"},
]

export const currentRoster = [
  {"player_id": 222, "first_name": "Gwyneth", "last_name": "Philips", "team_id": 5},
  {"player_id": 44, "first_name": "Ella", "last_name": "Shelton", "team_id": 6},
  {"player_id": 348, "first_name": "Jordan", "last_name": "Ray", "team_id": 5},
  {"player_id": 211, "first_name": "Raygan", "last_name": "Kirk", "team_id": 6},
  {"player_id": 325, "first_name": "Grace", "last_name": "Campbell", "team_id": 6},
  {"player_id": 314, "first_name": "Jessie", "last_name": "McPherson", "team_id": 6},
  {"player_id": 337, "first_name": "Vivian", "last_name": "Jungels", "team_id": 5},
  {"player_id": 125, "first_name": "Victoria", "last_name": "Bach", "team_id": 6},
  {"player_id": 127, "first_name": "Jess", "last_name": "Jones", "team_id": 6},
  {"player_id": 133, "first_name": "Lauriane", "last_name": "Rougeau", "team_id": 6},
  {"player_id": 137, "first_name": "Fanni", "last_name": "Garát-Gasparics", "team_id": 5},
  {"player_id": 144, "first_name": "Victoria", "last_name": "Howran", "team_id": 5},
  {"player_id": 76, "first_name": "Blayre", "last_name": "Turnbull", "team_id": 6},
  {"player_id": 56, "first_name": "Savannah", "last_name": "Harmon", "team_id": 6},
  {"player_id": 69, "first_name": "Brittany", "last_name": "Howard", "team_id": 6},
  {"player_id": 143, "first_name": "Taylor", "last_name": "Davison", "team_id": 5},
  {"player_id": 193, "first_name": "Lucy", "last_name": "Morgan", "team_id": 5},
  {"player_id": 72, "first_name": "Rebecca", "last_name": "Leslie", "team_id": 5},
  {"player_id": 345, "first_name": "Jamie", "last_name": "Nelson", "team_id": 6},
  {"player_id": 334, "first_name": "Kirsten", "last_name": "Simms", "team_id": 6},
  {"player_id": 357, "first_name": "Brooke", "last_name": "Disher", "team_id": 6},
  {"player_id": 130, "first_name": "Emma", "last_name": "Keenan", "team_id": 6},
  {"player_id": 139, "first_name": "Liliane", "last_name": "Perreault", "team_id": 5},
  {"player_id": 67, "first_name": "Renata", "last_name": "Fast", "team_id": 6},
  {"player_id": 57, "first_name": "Gabbie", "last_name": "Hughes", "team_id": 5},
  {"player_id": 241, "first_name": "Sarah", "last_name": "Wozniewicz", "team_id": 5},
  {"player_id": 240, "first_name": "Fanuza", "last_name": "Kadirova", "team_id": 5},
  {"player_id": 319, "first_name": "Maggy", "last_name": "Burbidge", "team_id": 5},
  {"player_id": 223, "first_name": "Ronja", "last_name": "Savolainen", "team_id": 5},
  {"player_id": 26, "first_name": "Claire", "last_name": "Dalton", "team_id": 6},
  {"player_id": 16, "first_name": "Jamie Lee", "last_name": "Rattray", "team_id": 6},
  {"player_id": 145, "first_name": "Rachel", "last_name": "McQuigge", "team_id": 5},
  {"player_id": 70, "first_name": "Erica", "last_name": "Howe", "team_id": 6},
  {"player_id": 88, "first_name": "Kateřina", "last_name": "Mrázová", "team_id": 5},
  {"player_id": 199, "first_name": "Dara", "last_name": "Greig", "team_id": 5},
  {"player_id": 115, "first_name": "Michela", "last_name": "Cava", "team_id": 5},
  {"player_id": 71, "first_name": "Jocelyne", "last_name": "Larocque", "team_id": 5},
  {"player_id": 100, "first_name": "Natalie", "last_name": "Spooner", "team_id": 6},
  {"player_id": 316, "first_name": "Clara Van", "last_name": "Wieren", "team_id": 6},
  {"player_id": 215, "first_name": "Jessica", "last_name": "Adolfsson", "team_id": 5},
  {"player_id": 55, "first_name": "Becca", "last_name": "Gilmore", "team_id": 5},
  {"player_id": 213, "first_name": "Anneke", "last_name": "Rankila", "team_id": 6},
  {"player_id": 289, "first_name": "Kathryn", "last_name": "Reilly", "team_id": 5},
  {"player_id": 38, "first_name": "Brooke", "last_name": "Hobson", "team_id": 5},
  {"player_id": 238, "first_name": "Sanni", "last_name": "Ahola", "team_id": 5},
  {"player_id": 290, "first_name": "Kendra", "last_name": "Woodland", "team_id": 5},
  {"player_id": 315, "first_name": "Lauren", "last_name": "Messier", "team_id": 6},
  {"player_id": 68, "first_name": "Kali", "last_name": "Flanagan", "team_id": 6},
  {"player_id": 313, "first_name": "Sara", "last_name": "Hjalmarsson", "team_id": 6},
  {"player_id": 317, "first_name": "Kiara", "last_name": "Zanon", "team_id": 6},
  {"player_id": 136, "first_name": "Rosalie", "last_name": "Demers", "team_id": 5},
  {"player_id": 360, "first_name": "Tereza", "last_name": "Pištěková", "team_id": 5},
  {"player_id": 372, "first_name": "Tory", "last_name": "Mariano", "team_id": 5},
  {"player_id": 369, "first_name": "Jane", "last_name": "Kuehl", "team_id": 6},
  {"player_id": 244, "first_name": "Emma", "last_name": "Gentry", "team_id": 6},
  {"player_id": 86, "first_name": "Emma", "last_name": "Woods", "team_id": 6},
  {"player_id": 74, "first_name": "Allie", "last_name": "Munroe", "team_id": 6},
  {"player_id": 311, "first_name": "Hanna", "last_name": "Baskin", "team_id": 6},
  {"player_id": 395, "first_name": "Taylor", "last_name": "Otremba", "team_id": 5},
  {"player_id": 192, "first_name": "Brooke", "last_name": "McQuigge", "team_id": 5},
  {"player_id": 288, "first_name": "Vita", "last_name": "Poniatovskaia", "team_id": 5},
  {"player_id": 118, "first_name": "Emma", "last_name": "Greco", "team_id": 5},
  {"player_id": 381, "first_name": "Emerson", "last_name": "O'Leary", "team_id": 6},
  {"player_id": 132, "first_name": "Jessica", "last_name": "Kondas", "team_id": 6},
  {"player_id": 393, "first_name": "Alyssa", "last_name": "Regalado", "team_id": 6},
  {"player_id": 237, "first_name": "Jenna", "last_name": "Buglioni", "team_id": 5},
]
