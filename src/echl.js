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
import { resolveECHLSeason, getAllECHLSeasonTypes, getAllECHLSeasons, ECHL_HT_BASE, ECHL_HT_KEY, ECHL_HT_HDR } from './seasons.js';

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
  // Historical, not current teams -- 2025-26 (seasons 73/76) teams that
  // aren't in 2026-27. Needed so historical-season routes label them, same
  // as AHL_TEAM_CODES' 317: 'BRI'. See eyewall-pipeline's
  // hockeytech_leagues.py ECHL team_id_map for the same entries.
  98: 'IA',  // Iowa Heartlanders
  23: 'UTA', // Utah Grizzlies
};
// ECHL team ID -> full name, for the AI narratives' prose: the server's
// own names, so a client-supplied one never reaches a prompt (security
// audit 2026-10-13 #5). Copied from eyewall-analytics' echlConfig.js displayName
// -- KEEP IN SYNC with it (and with ECHL_TEAM_CODES).
export const ECHL_TEAM_NAMES = {
  74: 'Adirondack Thunder', 108: 'Greensboro Gargoyles', 82: 'Maine Mariners',
  76: 'Norfolk Admirals', 17: 'Reading Royals', 113: 'Trenton Ironhawks',
  99: 'Trois-Rivières Lions', 77: 'Worcester Railers', 10: 'Atlanta Gladiators',
  8: 'Florida Everblades', 52: 'Greenville Swamp Rabbits', 79: 'Jacksonville Icemen',
  61: 'Orlando Solar Bears', 102: 'Savannah Ghost Pirates', 18: 'South Carolina Stingrays',
  107: 'Bloomington Bison', 5: 'Cincinnati Cyclones', 60: 'Fort Wayne Komets', 65: 'Indy Fuel',
  50: 'Kalamazoo Wings', 21: 'Toledo Walleye', 25: 'Wheeling Nailers', 66: 'Allen Americans',
  11: 'Idaho Steelheads', 68: 'Kansas City Mavericks', 114: 'New Mexico Goatheads',
  70: 'Rapid City Rush', 106: 'Tahoe Knight Monsters', 71: 'Tulsa Oilers', 72: 'Wichita Thunder',
  98: 'Iowa Heartlanders', 23: 'Utah Grizzlies',
};
// Ids in ECHL_TEAM_CODES that aren't current teams -- labels only, left out
// of worker.js's activeTeamCount.
export const ECHL_HISTORICAL_TEAM_IDS = [98, 23];

const echl = createHockeyTechLeague({
  key:          'echl',
  label:        'ECHL',
  teamCodes:    ECHL_TEAM_CODES,
  teamNames:    ECHL_TEAM_NAMES,
  newsSources:  ECHL_NEWS_SOURCES,
  headshotSize: '120x160',
  // Read at call time, not here -- see ahl.js.
  resolveSeason:     (env) => resolveECHLSeason(env),
  getAllSeasonTypes: (env) => getAllECHLSeasonTypes(env),
  getAllSeasons:     (env) => getAllECHLSeasons(env),
  leagueAvgFloor:    21, // 3/4 of 28 teams; a season with more rows raises it
  ht: {
    get base()    { return ECHL_HT_BASE; },
    get key()     { return ECHL_HT_KEY; },
    get headers() { return ECHL_HT_HDR; },
    siteId:   '0',
    leagueId: '1',
  },
});

export const handleECHL    = echl.handle;
export const pollECHL      = echl.poll;
export const fetchECHLNews = echl.fetchNews;
