# EyeWall Poller — Cloudflare Worker

Cloudflare Worker backend for [EyeWall Analytics](https://eyewallanalytics.com). Handles NHL polling, PWHL data serving, push notifications, and AI-generated content.

## Architecture

```
src/
├── worker.js    # Thin router + scheduled entry point
├── nhl.js       # NHL poll loop, push notifications, all /nhl/* endpoints
├── pwhl.js      # All /pwhl/* endpoints
└── shared.js    # KV helpers, response utilities, shared constants
```

Wrangler bundles all modules on deploy. The scheduled trigger (`* * * * *`) runs `poll()` every 60 seconds during the season to keep NHL data fresh in KV.

Bindings: `CACHE` (KV), `AI` (Workers AI — required for all narrative/scouting endpoints).

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (installed via `npm install`)
- Cloudflare account with a Worker and KV namespace

## Setup

```powershell
npm install
wrangler login
```

## Local Development

```powershell
npm run dev
```

Runs the Worker locally via `wrangler dev`. Binds to your real KV namespace by default — use a preview namespace for isolation if needed.

## Deploy

```powershell
npm run deploy
```

Or push to `main` — GitHub Actions auto-deploys on every push.

## Secrets

Set via `wrangler secret put <NAME>`. Never commit values.

| Secret | Description |
|--------|-------------|
| `POLL_SECRET` | Protects `POST /poll` manual trigger |
| `VAPID_PRIVATE_KEY` | Web Push VAPID private key |
| `VAPID_PUBLIC_KEY` | Web Push VAPID public key |
| `VAPID_SUBJECT` | Web Push contact (`mailto:...`) |
| `NHL_SEASON` | Current NHL season e.g. `20252026` — flip each October |
| `ODDS_API_KEY` | The Odds API key for game odds |
| `X_ACCESS_SECRET` | X (Twitter) OAuth access secret |
| `X_CONSUMER_SECRET` | X (Twitter) OAuth consumer secret |

**Bindings (wrangler.toml):**

| Binding | Type | Description |
|---------|------|-------------|
| `CACHE` | KV Namespace | All KV read/write operations |
| `AI` | Workers AI | Required for `/summary/narrative`, `/pwhl/summary/narrative`, `/pwhl/scout`, `/prediction/analyze`, `/draft/analyze` |

View current secrets:
```powershell
wrangler secret list
```

## Environment Variables

Non-secret vars live in `wrangler.toml` under `[vars]` or in the Cloudflare dashboard:

| Variable | Description |
|----------|-------------|
| `VAPID_PUBLIC_KEY` | Also set here for scheduled trigger access |

## KV Namespace

Binding: `CACHE` (`08c4ef455c584c83a811a96aa3c620ed`)

Key patterns:

| Key | TTL | Description |
|-----|-----|-------------|
| `schedule:{ABBR}` | 10min | NHL team schedule |
| `live:gameId` | 60s | Current live NHL game ID |
| `pbp:{gameId}` | 60s live / 1hr final | NHL play-by-play |
| `boxscore:{gameId}` | 60s live / 1hr final | NHL boxscore |
| `standings` | 5min | NHL standings |
| `teamstats:{ABBR}` | 10min | NHL team summary stats |
| `news:{ABBR}` | 30min | NHL team news |
| `pp_units:all` | 4hr | PP/PK unit rosters |
| `push:subs` | 1yr | Web push subscriptions |
| `pwhl:standings:{season}` | 1hr | PWHL standings |
| `pwhl:players:{teamId}:{season}` | 1hr | PWHL roster + stats |
| `pwhl:shots:{teamId}:{season}` | 6hr | PWHL shot events |
| `pwhl:schedule:{teamId}:{season}` | 30min | PWHL team schedule |
| `pwhl:news` | 30min | PWHL news feed |
| `pwhl:today:{season}` | 60s | Today's PWHL games + status |
| `pwhl:live:{gameId}` | 30s live / 1hr final | PWHL live PBP |
| `pwhl:summary:{gameId}` | 1hr | PWHL game summary (goals, MVPs, team stats) |
| `pwhl:narrative:{period}:{gameId}:{carAbbr}` | 24hr | AI period/game narrative per team perspective |
| `pwhl:pshots:{playerId}:{season}` | 6hr | PWHL player shot heat map data |

## NHL Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/cache/:key` | Read any KV key (primary NHL data path) |
| `GET` | `/news?team=` | Team news feed |
| `GET` | `/schedule?team=` | Team schedule |
| `GET` | `/health` | Worker health check |
| `POST` | `/poll?secret=` | Manual poll trigger |
| `POST` | `/push/subscribe` | Register push subscription |
| `POST` | `/push/unsubscribe` | Remove push subscription |
| `POST` | `/reddit/ingest` | Ingest Reddit posts from GH Actions |
| `POST` | `/atom/ingest` | Ingest RSS/Atom articles from GH Actions |
| `POST` | `/moneypuck/ingest` | Ingest MoneyPuck data from GH Actions |
| `GET` | `/moneypuck/refresh` | Refresh MoneyPuck for one team |
| `GET` | `/moneypuck/refresh/all` | Refresh MoneyPuck for all teams |
| `GET` | `/pp-units/refresh` | Refresh PP/PK unit data |
| `POST` | `/summary/generate` | Generate AI game summary |
| `POST` | `/summary/narrative?gameId=&period=&carAbbr=` | AI period/game narrative (cached per team perspective) |
| `POST` | `/prediction/analyze` | Generate pre-game prediction |
| `GET` | `/draft/rankings` | Draft rankings from Supabase |
| `GET` | `/draft/picks` | Draft picks from Supabase |
| `GET` | `/draft/order` | Draft pick order |
| `POST` | `/draft/analyze` | AI draft pick analysis |

## PWHL Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/pwhl/standings?season=` | League standings + L10/streak |
| `GET` | `/pwhl/players?teamId=&season=` | Roster, skater + goalie stats |
| `GET` | `/pwhl/shots?teamId=&season=` | Shot events for team heat map |
| `GET` | `/pwhl/schedule?teamId=&season=` | Team schedule |
| `GET` | `/pwhl/roster?teamId=` | Bare roster (name + jersey) |
| `GET` | `/pwhl/lastgame?teamId=&season=` | Most recent completed game |
| `GET` | `/pwhl/pbp?gameId=` | Completed game PBP + shot events |
| `GET` | `/pwhl/salaries?teamId=&season=` | Salary data |
| `GET` | `/pwhl/league-players?season=` | All teams' skaters + goalies |
| `GET` | `/pwhl/player-shots?playerId=&season=` | Player shot heat map data |
| `GET` | `/pwhl/today?season=` | Today's games with live status |
| `GET` | `/pwhl/live/:gameId` | Live PBP + normalized events |
| `GET` | `/pwhl/news` | PWHL news feed |
| `POST` | `/pwhl/news/ingest` | Ingest articles from GH Actions |
| `POST` | `/pwhl/news/bust` | Invalidate news KV cache |
| `POST` | `/pwhl/scout` | AI scouting report for a player |
| `POST` | `/pwhl/cache/bust` | Invalidate team KV caches |
| `GET` | `/pwhl/summary?gameId=` | Game summary (goals, MVPs, team stats) from HockeyTech |
| `POST` | `/pwhl/summary/narrative?gameId=&period=&carAbbr=` | AI period/game narrative (cached per team perspective) |

## October Season Prep

Each October flip these before the new season starts:

- `NHL_SEASON` secret → new season string e.g. `20262027`
- `PWHL_CURRENT_SEASON` in `pwhl.js` → new HockeyTech season ID (verify with HockeyTech)
- Add PWHL expansion team IDs once HockeyTech assigns them (Detroit, Hamilton, Las Vegas, San Jose)
- Narrative KV keys include `carAbbr` — stale keys from prior season expire naturally (24hr TTL)

## Related Repos

- [eyewall-analytics-app](https://github.com/ehlersio/eyewallanalytics) — React/Vite frontend (Cloudflare Pages)
- [eyewall-pipeline](https://github.com/ehlersio/eyewall-pipeline) — Python data pipeline (GitHub Actions)
