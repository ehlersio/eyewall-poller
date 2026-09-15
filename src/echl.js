/**
 * echl.js — EyeWall Analytics Worker
 *
 * ECHL config for the shared HockeyTech-league implementation in
 * hockeytech.js, which serves every /echl/* route, the live-game push poll
 * and the news fetch. Only what's genuinely ECHL-specific lives here.
 *
 * ECHL's HockeyTech key isn't exposed on echl.com (a Laravel/Livewire
 * rebuild that renders stats server-side) -- if it ever breaks, see
 * seasons.js's ECHL_HT_KEY comment rather than hunting the network tab.
 */

import { createHockeyTechLeague } from './hockeytech.js';
import { resolveECHLSeason, getAllECHLSeasonTypes, ECHL_HT_BASE, ECHL_HT_KEY, ECHL_HT_HDR } from './seasons.js';

// Only 2 sources, not AHL's 3: echl.com has no RSS feed at all (confirmed
// live 2026-08-30, /feed and /rss both 404). Both are ECHL-scoped by
// construction, so neither needs keyword filtering.
const ECHL_NEWS_SOURCES = [
  {
    // Hockey Writers' dedicated ECHL category feed (not its general site feed).
    id:     'hockeywriters-echl',
    name:   'The Hockey Writers',
    color:  '#FFFFFF',
    bg:     '#1a1a1a',
    url:    'https://thehockeywriters.com/category/echl/feed/',
    type:   'rss',
    filter: null,
  },
  {
    // OurSportsCentral's ECHL press-release feed -- league id 18 on that
    // site, NOT 17 like AHL's (its league ids aren't sequential by launch
    // date; found by searching the site live).
    id:     'osc-echl',
    name:   'OurSports Central',
    color:  '#FFFFFF',
    bg:     '#8b0000',
    url:    'https://www.oursportscentral.com/feeds/l18.xml',
    type:   'rss',
    filter: null,
  },
];

// ECHL team ID -> abbreviation. Current as of season 77/78 (2026-27),
// confirmed live via feed=modulekit&view=teamsbyseason 2026-08-30. A
// hardcoded snapshot, same convention as AHL_TEAM_CODES -- there's no
// echl_teams table; team display metadata is a frontend concern.
export const ECHL_TEAM_CODES = {
  74: 'ADK', 66: 'ALN', 10: 'ATL', 107: 'BLM', 5: 'CIN', 8: 'FLA',
  60: 'FW', 108: 'GSO', 52: 'GVL', 11: 'IDH', 65: 'IND', 79: 'JAX',
  50: 'KAL', 68: 'KC', 82: 'MNE', 114: 'NM', 76: 'NOR', 61: 'ORL',
  70: 'RC', 17: 'REA', 102: 'SAV', 18: 'SC', 106: 'TAH', 21: 'TOL',
  113: 'TRE', 99: 'TR', 71: 'TUL', 25: 'WHL', 72: 'WIC', 77: 'WOR',
};

const echl = createHockeyTechLeague({
  key:          'echl',
  label:        'ECHL',
  teamCodes:    ECHL_TEAM_CODES,
  newsSources:  ECHL_NEWS_SOURCES,
  headshotSize: '120x160',
  // Read at call time, not here -- see ahl.js.
  resolveSeason:     (env) => resolveECHLSeason(env),
  getAllSeasonTypes: (env) => getAllECHLSeasonTypes(env),
  ht: {
    get base()    { return ECHL_HT_BASE; },
    get key()     { return ECHL_HT_KEY; },
    get headers() { return ECHL_HT_HDR; },
  },
});

export const handleECHL    = echl.handle;
export const pollECHL      = echl.poll;
export const fetchECHLNews = echl.fetchNews;
