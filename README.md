# EyeWall Poller — Cloudflare Worker

Cloudflare Worker backend for [EyeWall Analytics](https://eyewallanalytics.com). Handles NHL polling, PWHL data serving, push notifications, and AI-generated content.

## Architecture

```
src/
├── worker.js    # Thin router + scheduled entry point
├── nhl.js       # NHL poll loop, push notifications, all /nhl/* endpoints
├── pwhl.js      # All /pwhl/* endpoints
├── seasons.js   # Live NHL/PWHL season resolution (added 2026-07), cached in KV
└── shared.js    # KV helpers, response utilities, shared constants
```

Wrangler bundles all modules on deploy. The scheduled trigger (`* * * * *`) runs `poll()`, `pollPWHL()`, `refreshPPUnits()`, and `refreshSeasonsCache()` every 60 seconds during the season to keep NHL/PWHL data and the resolved season fresh in KV.

Bindings: `CACHE` (KV), `AI_ROUTE_LIMITER` (Rate Limit — guards the 4 unauthenticated AI-calling routes from public-cost abuse). AI generation (all narrative/scouting endpoints) went through a `[ai]` Workers AI binding until 2026-08; it's now a plain `fetch()` to OpenRouter (`OPENROUTER_API_KEY` secret) instead — see [Model provider](#model-provider-openrouter) below.

## Live Season Resolution

Added 2026-07, replacing what used to be a yearly manual flip of `NHL_SEASON`/`PWHL_CURRENT_SEASON` across this repo, the frontend, and the pipeline. `seasons.js` is the single source of truth for "what season is it right now" — everything else (this repo's own `nhl.js`/`pwhl.js`, the frontend's `teamConfig.js`/`pwhlConfig.js`, the pipeline's `season_lookup.py`) reads from it rather than resolving independently.

**`resolveNHLSeason(env)`** — calls `api-web.nhle.com/v1/standings/now`, rejects the candidate if `gamesPlayed` is 0 (the real Sept/Oct pre-season-gap case), falls back to a hardcoded seed otherwise.

**`resolvePWHLSeason(env)`** — calls HockeyTech's `bootstrap` view (`feed=statviewfeed&view=bootstrap`, **not** `feed=modulekit` — the latter returns a 200 OK with no real payload and silently masqueraded as working for a while before being caught), rejects `current_season_id` if it's `hide_in_standings: true`, and — important — prefers the most recent **regular** season over the most recent season of any type. This isn't optional: almost every `/pwhl/*` endpoint filters `season_type=eq.regular` downstream in Supabase, so resolving to a playoffs-type season_id broke every PWHL view in production for a stretch (caught via Cypress, not by this logic itself) before this preference was added.

Both are cached in KV (`config:season:nhl`, `config:season:pwhl`, 6hr TTL) and exposed at `GET /config/seasons`. The `scheduled()` handler calls both on every tick, but since they check the cache first, this is a cheap no-op except right after the TTL lapses — it does **not** hit the NHL/HockeyTech APIs every 60 seconds.

**Manual override**, for if live resolution ever misjudges the real season boundary (this has happened once already, and the true Sept/Oct transition boundary has never been directly observed):
```powershell
wrangler kv key put --binding=CACHE "config:season:nhl:override" '"20262027"' --remote
wrangler kv key put --binding=CACHE "config:season:pwhl:override" '{"seasonId":9,"seasonType":"regular","startYear":2026}' --remote
```
**Note the `--remote` flag** — `wrangler kv key delete`/`put`/`get` without it operates on the local/preview namespace, not the one this Worker actually reads in production. This cost real debugging time once already; don't repeat it.
Delete the override key(s) once live resolution is confirmed correct again — they take priority over everything else, including the cache.

**Known gap:** `nhl.js`'s 32 `TEAM_CONFIGS` entries and `pwhl.js`'s per-endpoint season handling were updated to read from `seasons.js` — but this was a deliberate, careful pass through every call site (not a blind find-and-replace), since `getTeamConfig()` had to become async and every caller needed updating. If a new endpoint or team-config consumer gets added later, make sure it reads the live value rather than reintroducing a hardcoded season.

**Also found and fixed in `nhl.js` while doing this pass:** a *second*, separate hardcoded `MP_SEASON` constant driving the MoneyPuck CSV fetch URL — the same decoupled-season bug shape as the one already known about in the pipeline's `moneypuck.py`, just duplicated a second time on the Worker side. Both are now derived from the live-resolved season instead of two independent hardcoded copies.

## French/English localization

Track B Phase B2 (2026-08) — serving layer for `eyewall-pipeline`'s locale-aware AI narrative content (Phase B0 schema, Phase B1 generation, both already shipped). `game_summaries`, `player_scouting`, and `player_narratives` (Supabase) each carry a `locale` column (`en`/`fr`) as of Phase B0, widening their upsert conflict keys — a row can now exist in both languages for the same game/player/season.

Four routes accept a `?locale=en`/`?locale=fr` query param, defaulting to `en` for any missing or unrecognized value (same defensive posture as this file's existing `team`/`season` param handling) — **`/game-summary`, `/player-scouting`, `/player-results-vs-process`** (`nhl.js`) and **`/trivia/today`** (`worker.js`). Each filters its Supabase query on `locale=eq.<value>` and appends `:<locale>` to its KV cache key, so English and French responses cache independently rather than one clobbering the other.

**Known gap:** `trivia_questions`'s `hard` tier is hand-curated with no admin UI (see `trivia_questions.py`'s docstring in `eyewall-pipeline`) and every existing hard row defaults to `locale='en'` — there is no French hard-tier content yet. A `locale=fr` request's hard tier will legitimately come back empty (same "not published yet" empty state this route already falls back to for other gaps) until French hard rows are added by hand.

The frontend (`eyewall-analytics`) is not yet wired to pass this param — that's the remaining piece of Track B Phase B2.

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

## Testing

Added 2026-07 — this repo had no test infrastructure before then. Session 47 added an HTTP-route-level test harness and covered a first slice of routes; Session 48 filled in the rest of the previously-untested HTTP surface (110 tests total as of Session 48).

```powershell
npm install -D vitest
npm run test    # or: npx vitest run
```

`vitest.config.js` runs under plain Node (`environment: 'node'`), not `@cloudflare/vitest-pool-workers` — deliberately. Route handlers only touch Workers-specific APIs via `env.CACHE`/`env.AI_ROUTE_LIMITER`, both of which mock cleanly without a real Workers runtime (see `src/__tests__/route-harness.js`). AI generation is a plain `fetch()` call (OpenRouter, since 2026-08) rather than a Workers binding, so it's mocked the same way as every other external call — `mockFetchWithAI()`/`aiCalls()`/`aiPrompt()` in the same harness file.

Test files:
- `src/__tests__/seasons.test.js` — `seasons.js`'s own resolution logic. Covers: the manual override, KV cache hits, the "reject a zero-games-played candidate" fallback, the "reject a hidden `current_season_id`" fallback, and — the two tests that actually matter most — a regression test asserting `feed=statviewfeed` (not `feed=modulekit`) gets called, and a fixture built from the real 2026-07-05 production bootstrap payload confirming resolution picks season 8 (regular) over season 9 (playoffs) even though 9 is more recent by date. Both of those fixtures exist because they're exactly the two real bugs that shipped to production before being caught.
- `src/__tests__/worker-routes.test.js` — the dispatcher (`/config/seasons`, `/config/seasons/pwhl-types`, `/pwhl/*` vs. everything-else routing).
- `src/__tests__/nhl-routes.test.js` — `handleNHL`'s routes: a representative slice of read-proxy routes, all `POLL_SECRET`-gated mutating/ingest routes (asserting actual KV mutations/merge logic, not just status codes), and the AI-calling routes (`/prediction/analyze`, `/summary/narrative`, `/team-seasons/head-to-head/narrative`). `/atom/ingest` is covered for both real Atom and plain-RSS-format sources (Session: news ingestion investigation — the route used to assume every source was true Atom, silently parsing 0 items out of any RSS-format feed).
- `src/__tests__/pwhl-routes.test.js` — `handlePWHL`'s equivalent: `/pwhl/standings`'s enrichment logic, the `POLL_SECRET`-gated cache-bust/ingest routes, the AI-calling routes (`/pwhl/scout`, `/pwhl/summary/narrative`, `/pwhl/prediction`, `/pwhl/team-seasons/head-to-head/narrative`), and `/pwhl/preview`'s gameCenterPreview normalization.

The remaining ~35 plain read-proxy routes (parse params → cache check → `sbRows()`/fetch → cache write → JSON) all follow the same shape already covered here and are mechanical to extend if ever needed.

## Deploy

```powershell
npm run deploy
```

Or push to `main` — GitHub Actions auto-deploys on every push.

## Secrets

Set via `wrangler secret put <NAME>`. Never commit values.

| Secret | Description |
|--------|-------------|
| `OPENROUTER_API_KEY` | AI generation for every narrative/scouting/prediction route (`shared.js`'s `generateText()`) — see [Model provider](#model-provider-openrouter) below |
| `POLL_SECRET` | Protects `POST /poll` manual trigger |
| `VAPID_PRIVATE_KEY` | Web Push VAPID private key |
| `VAPID_PUBLIC_KEY` | Web Push VAPID public key |
| `VAPID_SUBJECT` | Web Push contact (`mailto:...`) |
| `NHL_SEASON` | **No longer read anywhere in this repo as of 2026-07.** Season resolution is entirely handled by `seasons.js`, whose own fallback is a hardcoded constant, not this secret. Kept here only because `eyewall-pipeline`'s `db.py` still reads a secret of the same name as *its* fallback — that's a separate repo/secret, not this one. Safe to leave this one stale or eventually remove it. |
| `ODDS_API_KEY` | The Odds API key for game odds |
| `X_ACCESS_SECRET` | X (Twitter) OAuth access secret |
| `X_CONSUMER_SECRET` | X (Twitter) OAuth consumer secret |

**Bindings (wrangler.toml):**

| Binding | Type | Description |
|---------|------|-------------|
| `CACHE` | KV Namespace | All KV read/write operations |
| `AI_ROUTE_LIMITER` | Rate Limit | Per-IP, per-route limit (10 req/60s) on the AI-calling routes with no secret check — `/prediction/analyze`, `/summary/narrative`, `/pwhl/summary/narrative`, `/pwhl/scout`, `/pwhl/prediction`, `/team-seasons/head-to-head/narrative`, `/pwhl/team-seasons/head-to-head/narrative`. Provisioned automatically from `wrangler.toml` at deploy time, no dashboard setup needed. Unrelated to which AI provider those routes call — unaffected by the OpenRouter migration below. |

### Model provider: OpenRouter

AI generation (`/summary/narrative`, `/pwhl/summary/narrative`, `/pwhl/scout`, `/prediction/analyze`, `/draft/analyze`, `/pwhl/prediction`, `/team-seasons/head-to-head/narrative`, `/pwhl/team-seasons/head-to-head/narrative`, plus the internal `generateGameSummary()`/`buildPreseasonFallback()` helpers — 11 call sites total) went through a Cloudflare Workers AI `[ai]` binding (`env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8-fast', ...)`) until 2026-08. All 11 now call `shared.js`'s `generateText(env, {messages, max_tokens})`, a plain `fetch()` to OpenRouter's `google/gemma-4-26b-a4b-it` — the `[ai]` binding was removed from `wrangler.toml` since nothing reads `env.AI` anymore.

Same model swap and reasoning as `eyewall-pipeline`'s `ai_client.py` (see that repo's README for the full writeup: real accuracy problems found in the old model via side-by-side testing, and why OpenRouter rather than Cloudflare's own hosting of the same new model — its default "thinking" mode burns the whole completion budget and returns empty content, with no working way found to disable it via Cloudflare's endpoint; OpenRouter's own `reasoning: {enabled: false}` works correctly against the same model).

`generateText()` deliberately mirrors `env.AI.run()`'s exact call/return shape (`{messages, max_tokens}` in, `{response: string}` out) so every call site only needed a one-line swap, not a rewrite of prompt-building or response-handling code.

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
| `pwhl:news` | 25hr populated / 5min empty | PWHL news feed. Written by both `/pwhl/news/ingest` (nightly pipeline) and `fetchPWHLNews()` (on-demand cold-cache path) — both now use the same TTL (fixed 2026-08-14, was a 30min/5min mismatch that let the nightly job's fuller article set get silently replaced by the on-demand path's narrower 3-source result once a day). |
| `pwhl:today:{season}` | 60s | Today's PWHL games + status |
| `pwhl:live:{gameId}` | 30s live / 1hr final | PWHL live PBP |
| `pwhl:summary:{gameId}` | 1hr | PWHL game summary (goals, MVPs, team stats) |
| `pwhl:narrative:{period}:{gameId}:{carAbbr}` | 24hr | AI period/game narrative per team perspective |
| `pwhl:pshots:{playerId}:{season}` | 6hr | PWHL player shot heat map data |
| `pwhl:player:landing:{playerId}:{season|'latest'}` | 1hr | Single PWHL player's identity + one season's stat line |
| `config:season:nhl` | 6hr | Live-resolved current NHL season (see [Live Season Resolution](#live-season-resolution)) |
| `config:season:pwhl` | 6hr | Live-resolved current PWHL season `{seasonId, seasonType, startYear}` |
| `config:season:nhl:override` | none (manual) | Forces a specific NHL season, bypassing live resolution entirely |
| `config:season:pwhl:override` | none (manual) | Forces a specific PWHL season, bypassing live resolution entirely |
| `players-search-index` | 6hr | Flat NHL+PWHL player list for the global player-search autocomplete |
| `trivia:{date}:{sport}:{team\|'ALL'}` | 24hr once populated, 60s if empty/partial | Daily trivia — all three tiers (easy/medium/hard) for one sport+team, one day (Phase 2, Session 92). Short TTL guard mirrors `/draft/picks`' pattern so a pre-publish snapshot from before the nightly job finishes doesn't get pinned for a full day. |
| `milestones:{sport}:{team}:{limit}:{season}` | 1hr | `/milestones`' own list cache, one entry per distinct query shape. Includes the live-resolved season (added 2026-08) so a cached entry never survives a season flip. |
| `milestones:latest:{sport}:{season}` | 1hr | Cheapest "is there anything new" check for the frontend's Milestones read-state badge (Phase 2, Session 92) — `{latestId, gameDate}` only, not the full feed. Season-scoped (added 2026-08) in lockstep with `/milestones` itself. |

## Config Endpoints

| Method | Path | Description |
|--------|------|--------------|
| `GET` | `/config/seasons` | Live-resolved current NHL + PWHL season (see [Live Season Resolution](#live-season-resolution)). Consumed by the frontend at app boot and by the pipeline's `season_lookup.py`. |
| `GET` | `/config/seasons/comparison` | Every season with `team_seasons`/`pwhl_team_seasons` rows, per league, with a team count and a `comparable` flag (strictly more than half of the league's current active team count has a row). Backs the season-over-season comparison feature (Session 64) — distinct from `/config/seasons`, which only ever answers "what's current." 1hr KV cache (`config:seasons:comparison`). |
| `GET` | `/players-search-index` | Flat `{id, name, team, position, sport}` list of every NHL + PWHL player, for the frontend's player-search autocomplete. NHL team is resolved from each player's most-recently-updated current-season `player_seasons` row — unchanged by the Combined Prediction Calibration work's `players.team` addition (2026-07); that column exists now, but this route's own derivation wasn't revisited here, out of scope for that change. If the live season has zero `player_seasons` rows at all yet (season flipped ahead of real games, e.g. once the new schedule is released — see [Live Season Resolution](#live-season-resolution)), NHL entries fall back to one season back and add `teamStale: true` + `teamSeason: "<season>"`; a player with no row in either season gets `team: null` with no `teamStale` field. |
| `GET` | `/trivia/today?sport=&team=&locale=` | All three trivia tiers (easy/medium/hard) for one sport in a single response, `team` optional (adds that team's medium-tier question; omit for easy/hard only) — Daily Trivia (Phase 2, Session 92). Easy/medium require an exact `question_date` match (nightly-populated by the pipeline's `trivia_questions.py`; no match means "not published yet," shown as the empty state). Hard is hand-curated with no admin UI, added in batches rather than nightly — its query falls back to the most recent row on or before today (`question_date=lte.&order=question_date.desc`) instead of an exact match, so it only goes empty if zero hard rows exist yet for that sport, not on every day between curation batches. Correct answer/explanation are included in the response (not split into a post-answer reveal step) — accepted for a low-stakes trivia feature. `locale` (`en`/`fr`, defaults to `en`) filters all three tiers — see [French/English localization](#frenchenglish-localization) below. |
| `GET` | `/news/latest?sport=&team=` | Cheap "is there anything new" check for the frontend's News read-state badge (Phase 2, Session 92) — reuses the exact `news:{ABBR}`/`pwhl:news` KV entries `/news`/`/pwhl/news` already populate (pure KV read when warm) rather than a second parallel fetch; triggers the same background warm on a cold cache and returns `{latestId: null}` for that request. `team` required for `sport=nhl` (news is per-team), omitted for `sport=pwhl` (one global feed). |
| `GET` | `/milestones?team=&sport=&limit=` | Recent milestones (hat tricks, shutouts, SH goals, season/career thresholds) — hard-coded to NHL unless `sport=pwhl`, optional single-team filter, `limit` default 50 / max 100. Populated nightly by the pipeline's `milestones.py` (NHL) / `pwhl_milestones.py` (PWHL) into one shared `milestones` table (`is_pwhl` column). Scoped to the live-resolved current season (added 2026-08, see [Live Season Resolution](#live-season-resolution)) — before this, an unfiltered "most recent N" query had no way to age out an old row once the table stopped getting new ones (e.g. NHL offseason), so a leftover milestone from the prior season could sit as the only NHL row indefinitely. |
| `GET` | `/milestones/latest?sport=` | Same badge purpose as `/news/latest`, for Milestones — its own minimal `limit=1` query since no reusable unfiltered KV entry exists for that table (the real `/milestones` route's key always includes `team`+`limit`+`season`). `gameDate` is date-granularity, not a timestamp — `milestones` has no insertion-time column, accepted as good enough for a boolean seen/unseen badge. Season-scoped in lockstep with `/milestones` — otherwise this could flag "unseen" for an id that no longer appears in the (now season-scoped) list at all. |

## NHL Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/cache/:key` | Read any KV key (primary NHL data path) |
| `GET` | `/news?team=` | Team news feed |
| `GET` | `/schedule?team=` | Team schedule |
| `GET` | `/nhl/odds` | Moneyline odds for upcoming games, from the persisted `nhl_odds` table (Odds Persistence Writer, 2026-07) — replaces the frontend's old direct-to-Odds-API call. Already flattened/matched by team abbr server-side; 5min edge cache. |
| `GET` | `/health` | Worker health check |
| `POST` | `/poll?secret=` | Manual poll trigger |
| `POST` | `/push/subscribe` | Register push subscription |
| `POST` | `/push/unsubscribe` | Remove push subscription |
| `POST` | `/atom/ingest` | Ingest team-blog RSS/Atom articles from GH Actions (auto-detects real Atom vs. plain RSS 2.0 per source) |
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
| `GET` | `/team-seasons/compare?team=&seasons=` | Box-score fields only (wins/losses/OTL/points/goals-for-against/PP%/PK%) for one team across a comma-separated season list. Backs the season-over-season team comparison feature (Session 64). Missing seasons for that team are simply absent from the response — no placeholder rows. |
| `GET` | `/team-seasons/compare-teams?teams=,&season=` | Box-score fields only, for exactly two teams at one shared season. Backs Team vs Team comparison Mode 1 (Session 86) — the two-team analog of `/team-seasons/compare`'s two-season shape. A team missing a row for that season (e.g. didn't exist yet) is simply absent from the response. |
| `GET` | `/team-seasons/head-to-head?teams=,` | All-time head-to-head between two teams across every season on record — Team vs Team Mode 2 (Session 88). Filters `game_log` for one team's own rows against the named opponent (no season/game_type filter — includes playoff meetings), then computes `allTimeRecord`/`recentWindow`/`currentStreak`/`isThinSample` server-side via `buildHeadToHeadPayload` (shared.js), so there's one definition of the derived insights instead of duplicating the math per league. |
| `POST` | `/team-seasons/head-to-head/narrative` | AI narrative layer on top of the head-to-head stats above (Session 90). Client posts the payload it already fetched from `/team-seasons/head-to-head` plus display names — this route doesn't refetch/recompute anything. Cached in KV per team pair. Returns `{ narrative: null }` without calling the model for zero-meeting pairs; flags a thin-sample guardrail in the prompt when `isThinSample` is true so the model doesn't overstate a 2-4 game sample as a trend. |

## PWHL Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/pwhl/standings?season=` | League standings + L10/streak |
| `GET` | `/pwhl/players?teamId=&season=` | Roster, skater + goalie stats |
| `GET` | `/pwhl/shots?teamId=&season=` | Shot events for team heat map |
| `GET` | `/pwhl/team-season-summary?teamId=&season=` | Season-aggregate SOG/blocks/hits/penalties/faceoffs (car vs. opp) + PP%/PK% for the Shot Map's "All N" summary cards (Session 80). Counts only, aggregated server-side against `pwhl_shot_events`/`pwhl_pbp_events` for the team's own completed games — not raw rows like `/pwhl/shots` |
| `GET` | `/pwhl/schedule?teamId=&season=` | Team schedule |
| `GET` | `/pwhl/roster?teamId=` | Bare roster (name + jersey) |
| `GET` | `/pwhl/game-box?gameId=` | Per-player box score (skaters + goalies) for a completed game — box-score popup (Session 50) |
| `GET` | `/pwhl/player-game-log?playerId=&seasonId=` | One player's game-by-game box score rows for a season — player Compare tab trend charts (Session 70) |
| `GET` | `/pwhl/lastgame?teamId=&season=` | Most recent completed game |
| `GET` | `/pwhl/pbp?gameId=` | Completed game PBP + shot events |
| `GET` | `/pwhl/salaries?teamId=&season=` | Salary data |
| `GET` | `/pwhl/league-players?season=` | All teams' skaters + goalies |
| `GET` | `/pwhl/player/landing?id=&season=` | Single player's identity + one season's stat line, merged (pwhl_players + pwhl_player_seasons/pwhl_goalie_seasons). Powers `PWHLPlayerPopup`'s self-fetch-by-id. `season` pins the stat line to that `season_id`; omitted, falls back to the most recent regular-season row. |
| `GET` | `/pwhl/player/career?id=` | Career Regular Season / Playoffs totals, live proxy of HockeyTech's `view=player` server-computed `careerStats` Total rows (no Supabase, no aggregation on this side). `playoffs` is `null` if the player hasn't made the playoffs yet. |
| `GET` | `/pwhl/player-shots?playerId=&season=` | Player shot heat map data |
| `GET` | `/pwhl/goalie-shots?goalieId=&season=` | Shots faced by a specific goalie, for the goalie heat map (Session 100) — mirrors `/pwhl/player-shots`'s query/normalisation shape against `pwhl_shot_events.goalie_id`, excludes `blocked_shot` (never reaches the goalie) |
| `GET` | `/pwhl/today?season=` | Today's games with live status |
| `GET` | `/pwhl/live/:gameId` | Live PBP + normalized events |
| `GET` | `/pwhl/news` | PWHL news feed |
| `POST` | `/pwhl/news/ingest` | Ingest articles from GH Actions |
| `POST` | `/pwhl/news/bust` | Invalidate news KV cache |
| `POST` | `/pwhl/scout` | AI scouting report for a player |
| `POST` | `/pwhl/cache/bust?secret=&teamId=&season=` | Invalidate one team's KV caches (players/shots/schedule/lastgame) for a given season |
| `GET` | `/pwhl/summary?gameId=` | Game summary (goals, MVPs, team stats) from HockeyTech |
| `POST` | `/pwhl/summary/narrative?gameId=&period=&carAbbr=` | AI period/game narrative (cached per team perspective) |
| `GET` | `/pwhl/preview?gameId=` | Pre-game preview for an upcoming game — season series, head-to-head, streaks, team-scoped leading scorers, special teams (Session 51, live HockeyTech `gameCenterPreview` passthrough) |
| `GET` | `/pwhl/prediction?gameId=&force=` | Win probability + AI narrative for an upcoming game (Session 51) — PWHL analog of `/prediction/analyze`'s fallback-tier heuristic, not its DB-first Tier-1 system. `corsiForPct` prefers 5v5-filtered shot-attempt share, falling back to all-situations if the 5v5 column isn't populated yet (Session 53, same preference order as `/prediction/analyze`) — check `corsiCaveat` for which one a given response used |
| `GET` | `/pwhl/team-seasons/compare?teamId=&seasons=` | Box-score fields only (gp/wins/losses/OTL/points/goals-for-against/PP%/PK%) for one team across a comma-separated `season_id` list. PWHL analog of `/team-seasons/compare` (Session 64). Missing seasons for that team are simply absent from the response — no placeholder rows. |
| `GET` | `/pwhl/team-seasons/compare-teams?teamIds=,&season=` | Box-score fields only, for exactly two `team_id`s at one shared `season_id`. PWHL analog of `/team-seasons/compare-teams` (Session 86). A team missing a row for that season (e.g. a 2026-27 expansion team with no prior season) is simply absent from the response. |
| `GET` | `/pwhl/team-seasons/head-to-head?teamIds=,` | All-time head-to-head between two teams across every season on record — PWHL analog of `/team-seasons/head-to-head` (Session 88). `pwhl_game_log` is one row per game with both teams in columns, so this uses an OR-of-AND home/away filter (no `season_id` filter) instead of NHL's simple two-sided filter, then shares the same `buildHeadToHeadPayload` derived-insight computation. |
| `POST` | `/pwhl/team-seasons/head-to-head/narrative` | AI narrative layer on top of the head-to-head stats above (Session 90) — PWHL analog of `/team-seasons/head-to-head/narrative`. This Worker has no PWHL team-name map of its own, so display names come from the client (same reason `/pwhl/summary/narrative` above takes `carName`/`oppName` instead of resolving them server-side). |

## October Season Prep

**Most of this is now automatic (2026-07)** — see [Live Season Resolution](#live-season-resolution). What's left:

- ~~`NHL_SEASON` secret → new season string~~ — no longer read anywhere in this repo
- ~~`PWHL_CURRENT_SEASON` in `pwhl.js`~~ — removed entirely; resolved live via `seasons.js`
- ~~Add PWHL expansion team IDs~~ — done 2026-07 (`PWHL_TEAM_CODES` in `pwhl.js` includes DET=10, HAM=11, LV=12, SJS=13)
- Narrative KV keys include `carAbbr` — stale keys from prior season expire naturally (24hr TTL) — still true, no change needed
- **If a future expansion wave adds a new team_id again:** add it to `pwhl.js`'s `PWHL_TEAM_CODES` map. Also worth checking the pipeline's `pwhl_stats.py`/`pwhl_salaries.py` for their own separate team-ID maps — those don't share this file's map and need the same addition independently (found the hard way in 2026-07: three separate places across two repos enumerate PWHL team IDs).
- **If live season resolution ever misjudges the real season boundary:** use the KV override documented above rather than an emergency redeploy. The real Sept/Oct transition has never been directly observed by this logic yet — worth paying attention the first time it happens live.

## Related Repos

- [eyewall-analytics-app](https://github.com/ehlersio/eyewallanalytics) — React/Vite frontend (Cloudflare Pages)
- [eyewall-pipeline](https://github.com/ehlersio/eyewall-pipeline) — Python data pipeline (GitHub Actions)

---

## Disclaimer

EyeWall Analytics is an independent, fan-built analytics project and is not
affiliated with, endorsed by, or sponsored by the National Hockey League
(NHL), the Professional Women's Hockey League (PWHL), or any of their
member teams. All team names, logos, and related marks are the property of
their respective owners and are used here for informational and editorial
purposes only.
