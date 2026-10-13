/**
 * ahl.js — EyeWall Analytics Worker
 *
 * AHL config for the shared HockeyTech-league implementation in
 * hockeytech.js, which serves every /ahl/* route, the live-game push poll
 * and the news fetch. Only what's genuinely AHL-specific lives here.
 */

import { createHockeyTechLeague } from './hockeytech.js';
import { resolveAHLSeason, getAllAHLSeasonTypes, getAllAHLSeasons, AHL_HT_BASE, AHL_HT_KEY, AHL_HT_HDR } from './seasons.js';

// All three sources are AHL-only feeds (confirmed live 2026-08-29), so none
// need keyword filtering.
const AHL_NEWS_SOURCES = [
  {
    // TheAHL.com's own WordPress feed -- the official league site, so the
    // highest-signal source.
    id:     'official-ahl',
    name:   'TheAHL.com',
    color:  '#FFFFFF',
    bg:     '#003876',
    url:    'https://theahl.com/feed',
    type:   'rss',
    filter: null,
  },
  {
    // Hockey Writers' dedicated AHL category feed (not its general site feed).
    id:     'hockeywriters-ahl',
    name:   'The Hockey Writers',
    color:  '#FFFFFF',
    bg:     '#1a1a1a',
    url:    'https://thehockeywriters.com/category/ahl/feed/',
    type:   'rss',
    filter: null,
  },
  {
    // OurSportsCentral's AHL press-release feed (league id 17 on that site).
    id:     'osc-ahl',
    name:   'OurSports Central',
    color:  '#FFFFFF',
    bg:     '#8b0000',
    url:    'https://www.oursportscentral.com/feeds/l17.xml',
    type:   'rss',
    filter: null,
  },
];

// AHL team ID -> abbreviation. Current as of season 94 (2026-27), confirmed
// live via feed=modulekit&view=teamsbyseason 2026-08-29. A hardcoded
// snapshot, same convention as PWHL_TEAM_CODES -- there's no ahl_teams
// table; team display metadata is a frontend concern.
export const AHL_TEAM_CODES = {
  307: 'HFD', 309: 'PRO', 313: 'LV', 316: 'WBS', 319: 'HER', 321: 'MB',
  323: 'ROC', 324: 'SYR', 327: 'MIL', 328: 'GR', 330: 'CHI', 335: 'TOR',
  372: 'RFD', 373: 'CLE', 380: 'TEX', 384: 'CLT', 389: 'IA', 390: 'UTC',
  402: 'BAK', 403: 'ONT', 404: 'SD', 405: 'SJ', 411: 'SPR', 412: 'TUC',
  413: 'BEL', 415: 'LAV', 419: 'COL', 437: 'HSK', 440: 'ABB', 444: 'CGY',
  445: 'CV', 457: 'HAM',
  // Historical franchise rename, not a current team -- Bridgeport
  // Islanders relocated to become the Hamilton Hammers (457) for 2026-27.
  // Needed for historical-season queries (e.g. season 90) which still use
  // "BRI" throughout. See eyewall-pipeline's ahl_stats.py TEAM_ID_MAP for
  // the same entry.
  317: 'BRI',
};
// AHL team ID -> full name, for the AI narratives' prose: the server's
// own names, so a client-supplied one never reaches a prompt (security
// audit 2026-10-13 #5). Copied from eyewall-analytics' ahlConfig.js displayName
// -- KEEP IN SYNC with it (and with AHL_TEAM_CODES).
export const AHL_TEAM_NAMES = {
  307: 'Hartford Wolf Pack', 309: 'Providence Bruins', 313: 'Lehigh Valley Phantoms',
  316: 'Wilkes-Barre/Scranton Penguins', 319: 'Hershey Bears', 384: 'Charlotte Checkers',
  411: 'Springfield Thunderbirds', 323: 'Rochester Americans', 324: 'Syracuse Crunch',
  335: 'Toronto Marlies', 373: 'Cleveland Monsters', 390: 'Utica Comets',
  413: 'Belleville Senators', 415: 'Laval Rocket', 457: 'Hamilton Hammers', 321: 'Manitoba Moose',
  327: 'Milwaukee Admirals', 328: 'Grand Rapids Griffins', 330: 'Chicago Wolves',
  372: 'Rockford IceHogs', 380: 'Texas Stars', 389: 'Iowa Wild', 402: 'Bakersfield Condors',
  403: 'Ontario Reign', 404: 'San Diego Gulls', 405: 'San Jose Barracuda',
  412: 'Tucson Roadrunners', 419: 'Colorado Eagles', 437: 'Henderson Silver Knights',
  440: 'Abbotsford Canucks', 444: 'Calgary Wranglers', 445: 'Coachella Valley Firebirds',
  317: 'Bridgeport Islanders',
};
// Ids in AHL_TEAM_CODES that aren't current teams -- labels only, left out
// of worker.js's activeTeamCount.
export const AHL_HISTORICAL_TEAM_IDS = [317];

const ahl = createHockeyTechLeague({
  key:          'ahl',
  label:        'AHL',
  teamCodes:    AHL_TEAM_CODES,
  teamNames:    AHL_TEAM_NAMES,
  newsSources:  AHL_NEWS_SOURCES,
  headshotSize: '240x240',
  // seasons.js values are read at call time, not here -- touching one at
  // import time would break every test file that mocks seasons.js without
  // the AHL exports.
  resolveSeason:     (env) => resolveAHLSeason(env),
  getAllSeasonTypes: (env) => getAllAHLSeasonTypes(env),
  getAllSeasons:     (env) => getAllAHLSeasons(env),
  leagueAvgFloor:    24, // 3/4 of 32 teams (same bar as the NHL)
  ht: {
    get base()    { return AHL_HT_BASE; },
    get key()     { return AHL_HT_KEY; },
    get headers() { return AHL_HT_HDR; },
    siteId:   '3',
    leagueId: '4',
  },
});

export const handleAHL    = ahl.handle;
export const pollAHL      = ahl.poll;
export const fetchAHLNews = ahl.fetchNews;
