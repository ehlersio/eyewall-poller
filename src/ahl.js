/**
 * ahl.js — EyeWall Analytics Worker
 *
 * AHL config for the shared HockeyTech-league implementation in
 * hockeytech.js, which serves every /ahl/* route, the live-game push poll
 * and the news fetch. Only what's genuinely AHL-specific lives here.
 */

import { createHockeyTechLeague } from './hockeytech.js';
import { resolveAHLSeason, getAllAHLSeasonTypes, AHL_HT_BASE, AHL_HT_KEY, AHL_HT_HDR } from './seasons.js';

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

const ahl = createHockeyTechLeague({
  key:          'ahl',
  label:        'AHL',
  teamCodes:    AHL_TEAM_CODES,
  newsSources:  AHL_NEWS_SOURCES,
  headshotSize: '240x240',
  // seasons.js values are read at call time, not here -- touching one at
  // import time would break every test file that mocks seasons.js without
  // the AHL exports.
  resolveSeason:     (env) => resolveAHLSeason(env),
  getAllSeasonTypes: (env) => getAllAHLSeasonTypes(env),
  ht: {
    get base()    { return AHL_HT_BASE; },
    get key()     { return AHL_HT_KEY; },
    get headers() { return AHL_HT_HDR; },
  },
});

export const handleAHL    = ahl.handle;
export const pollAHL      = ahl.poll;
export const fetchAHLNews = ahl.fetchNews;
