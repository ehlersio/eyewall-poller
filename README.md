# EyeWall Poller — Cloudflare Worker

Cloudflare Worker backend for [EyeWall Analytics](https://eyewallanalytics.com). Handles NHL/PWHL/AHL/ECHL polling and data serving, push notifications, and AI-generated content.

## Architecture

```
src/
├── worker.js    # Thin router + scheduled entry point
├── nhl.js       # NHL poll loop, push notifications, all /nhl/* endpoints
├── pwhl.js      # All /pwhl/* endpoints
├── hockeytech.js # Shared AHL/ECHL implementation: poll loop, push notifications, all /ahl/* and /echl/* endpoints (2026-09)
├── ahl.js       # AHL config for hockeytech.js: team codes, news sources, HockeyTech client (added 2026-08)
├── echl.js      # ECHL config for hockeytech.js (added 2026-08)
├── seasons.js   # Live NHL/PWHL/AHL/ECHL season resolution (NHL/PWHL added 2026-07, AHL/ECHL 2026-08), cached in KV
└── shared.js    # KV helpers, response utilities, shared constants
```

Wrangler bundles all modules on deploy. The scheduled trigger (`* * * * *`) runs `poll()`, `pollPWHL()`, `pollAHL()`, `pollECHL()`, `refreshPPUnits()`, and `refreshSeasonsCache()` every 60 seconds during the season to keep NHL/PWHL/AHL/ECHL data and the resolved season fresh in KV.

Bindings: `CACHE` (KV), `AI_ROUTE_LIMITER` (Rate Limit — guards the 4 unauthenticated AI-calling routes from public-cost abuse). AI generation (all narrative/scouting endpoints) went through a `[ai]` Workers AI binding until 2026-08; it's now a plain `fetch()` to OpenRouter (`OPENROUTER_API_KEY` secret) instead — see [Model provider](#model-provider-openrouter) below.

## Live Season Resolution

Added 2026-07, replacing what used to be a yearly manual flip of `NHL_SEASON`/`PWHL_CURRENT_SEASON` across this repo, the frontend, and the pipeline. `seasons.js` is the single source of truth for "what season is it right now" — everything else (this repo's own `nhl.js`/`pwhl.js`, the frontend's `teamConfig.js`/`pwhlConfig.js`, the pipeline's `season_lookup.py`) reads from it rather than resolving independently.

**`resolveNHLSeason(env)`** — calls `api-web.nhle.com/v1/standings/now`, rejects the candidate if `gamesPlayed` is 0, falls back to a hardcoded seed otherwise. **This alone is too late a signal for schedule/roster-facing UI** — `gamesPlayed` only ever flips once real games have actually been played, but the app needs to show the new season's schedule/roster once training camp is genuinely imminent, weeks before that. `nextSeasonHasImminentSchedule(seasonId)` covers that gap: after computing the `gamesPlayed`-based candidate (or the fallback, if rejected), it separately checks whether *the season after that* already has a published schedule with its first game (preseason counts) within `SCHEDULE_LOOKAHEAD_DAYS` (21) — if so, resolution flips forward to it. Verified live 2026-09-11: with no override set, this correctly auto-resolves to `20262027` (CAR's real preseason opener 9 days out) even though `standings/now` still only has real `20252026` data (no `20262027` games played yet) — the actual real-world boundary case this was built for, not a hypothetical.

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

**AHL and ECHL (added 2026-08)** follow the same live-resolution pattern via `resolveAHLSeason(env)`/`resolveECHLSeason(env)` (`seasons.js`), but against a different vendor call shape than PWHL's: `feed=modulekit&view=seasons` (not `statviewfeed&view=bootstrap`), a different HockeyTech client per league (`client_code=ahl`, `key=ccb91f29d6744675`, `site_id=3` vs. `client_code=echl`, `key=2c2b89ea7345cae8`, `site_id=0`, `league_id=1`), and no `hide_in_standings` flag to filter on. Instead, "is this candidate season real" is decided by `career === '1'` (skips All-Star Challenge entries) **and** `start_date` not being in the future (skips an already-announced-but-not-started upcoming season) — mirrors `eyewall-pipeline`'s own `ahl_stats.py`/`echl_stats.py` `resolve_current_season()` logic exactly, including the reasoning behind it: a naive "max season_id with `career=1`" picked a season with zero games in testing (AHL's 2026-27, which starts October) instead of the actually-current one.

**ECHL's HockeyTech key is not recoverable the way AHL's/PWHL's are.** `echl.com` was rebuilt on Laravel/Livewire and renders stats server-side, so the usual "open the network tab" recovery path doesn't work there. The key currently in `seasons.js` (`ECHL_HT_KEY`) was recovered from `sportsdataverse-py`'s league registry (`hockeytech/_leagues.py`) and independently re-verified live against the real feed. If it ever stops working, re-check that registry first — a network-tab hunt on echl.com will fail for the same reason it did during the original investigation.

Cached in KV: `config:season:ahl` / `config:season:echl` (6hr TTL, same `TTL_SECONDS` constant as NHL/PWHL), with fallback seeds `{seasonId: 90, seasonType: 'regular'}` / `{seasonId: 73, seasonType: 'regular'}` for a total cold start. Manual override keys, same escape-hatch pattern as NHL/PWHL above:
```powershell
wrangler kv key put --binding=CACHE "config:season:ahl:override" '{"seasonId":90,"seasonType":"regular"}' --remote
wrangler kv key put --binding=CACHE "config:season:echl:override" '{"seasonId":73,"seasonType":"regular"}' --remote
```

`getAllAHLSeasonTypes()`/`getAllAHLSeasons()` and their ECHL equivalents mirror PWHL's `getAllPWHLSeasonTypes()`/`getAllPWHLSeasons()` — an id → season_type map for arbitrary/historical seasons, and full `{seasonId, seasonType, startYear}` metadata for the season-comparison picker, respectively. **Real bug found and fixed while building ECHL's own Compare-Seasons feature (2026-08-30):** `worker.js`'s `/config/seasons/comparison` never actually built an `ahl` key, despite a frontend comment (`AHLTeamView.jsx`) claiming it had since AHL/PWHL parity Phase 4 — the route only ever built `nhl`/`pwhl` keys, so AHL's own "Compare Seasons" picker had been silently showing its "no seasons available" empty state in production since that phase shipped. Fixed by adding `getAllAHLSeasons()`/`getAllECHLSeasons()` (mirroring the already-correct `getAllPWHLSeasons()`) and building real `ahl`/`echl` entries alongside `nhl`/`pwhl` in that route — fixing AHL's picker live and giving ECHL's brand-new one working season labels from day one, instead of reproducing the same gap a third time. See [Config Endpoints](#config-endpoints) below.

## French/English localization

Track B Phase B2 (2026-08) — serving layer for `eyewall-pipeline`'s locale-aware AI narrative content (Phase B0 schema, Phase B1 generation, both already shipped). `game_summaries`, `player_scouting`, and `player_narratives` (Supabase) each carry a `locale` column (`en`/`fr`) as of Phase B0, widening their upsert conflict keys — a row can now exist in both languages for the same game/player/season.

Four routes accept a `?locale=en`/`?locale=fr` query param, defaulting to `en` for any missing or unrecognized value (same defensive posture as this file's existing `team`/`season` param handling) — **`/game-summary`, `/player-scouting`, `/player-results-vs-process`** (`nhl.js`) and **`/trivia/today`** (`worker.js`). Each filters its Supabase query on `locale=eq.<value>` and appends `:<locale>` to its KV cache key, so English and French responses cache independently rather than one clobbering the other.

**Known gap:** `trivia_questions`'s `hard` tier is hand-curated with no admin UI (see `trivia_questions.py`'s docstring in `eyewall-pipeline`) and every existing hard row defaults to `locale='en'` — there is no French hard-tier content yet. A `locale=fr` request's hard tier will legitimately come back empty (same "not published yet" empty state this route already falls back to for other gaps) until French hard rows are added by hand.

The frontend (`eyewall-analytics`) is not yet wired to pass this param — that's the remaining piece of Track B Phase B2.

## AHL & ECHL

Added 2026-08 as the 3rd and 4th leagues (`ahl.js`/`echl.js`), following NHL/PWHL's exact patterns: same Supabase-REST-direct query shape, same KV caching shape, same push-notification/live-tracking structure. Both leagues sit on the same HockeyTech/LeagueStat vendor as PWHL — same endpoint shapes, just a different client per league (see [Live Season Resolution](#live-season-resolution) above for the exact config values and the ECHL-key-recovery caveat).

**One implementation, two configs (2026-09).** The two leagues were built as ~1,750-line near-copies; they now share `hockeytech.js`'s `createHockeyTechLeague()`, and `ahl.js`/`echl.js` hold only each league's config — team codes, news sources, headshot size, and HockeyTech client. The merge was pinned by `hockeytech-leagues.characterization.test.js` (see [Testing](#testing)): every route's requests, KV writes and responses stayed identical, except that ECHL gained `/echl/player-game-log`.

**Both leagues share a real, permanent data-shape ceiling below PWHL** — confirmed live against production data across multiple real games for each league (not assumed from one sample), documented in `hockeytech.js`'s module docstring:
- **No shift data at all.** HockeyTech's `modulekit/gameshifts` view returns an empty `{home: [], visitor: []}` shape for every AHL/ECHL game tested, confirmed against a PWHL control game that *does* return populated shifts through the identical request shape. Consequence: no TOI, no on-ice Corsi/Fenwick, no shift-based WAR/RAPM — a harder limit than PWHL's own goal-scoped on-ice data, which is at least a coarse fallback.
- **No `hit`/`faceoff`/`blocked_shot` event types in the PBP.** Only `goal`, `shot`, `penalty`, `goalie_change`, `penaltyshot` (plus a still-unconfirmed `shootout` for AHL; confirmed real for ECHL — see `echl_penalty_shots.py`) exist. The box-score schema even carries `hits`/`faceoffAttempts`/`faceoffWins`/`faceoffWinPercentage` fields per player and per team, but they're hardcoded `"0"` in every real game checked for both leagues — confirming it's not charted anywhere, not merely absent from the PBP. `/ahl/summary` and `/echl/summary` strip these fields from HockeyTech's raw response rather than passing along a fabricated "0 hits" line the frontend would have to know not to trust.
- **No Corsi/Fenwick/PDO anywhere in either file, on purpose** — there's no shot-attempts data source beyond shots-on-goal for either league. `/ahl/prediction` and `/echl/prediction` are direct ports of `/pwhl/prediction`'s heuristic with the Corsi term dropped entirely, not zeroed out.
- **`ahl_game_log`/`echl_game_log` have no OT/shootout boolean columns** — every non-win in a streak or L10 calculation counts as a plain loss (`'L'`), never split into a PWHL-style regulation-loss vs. OT-loss (`'O'`). `ahl_team_seasons`/`echl_team_seasons` do carry `ot_losses` and `shootout_losses`, but as two separate columns rather than one non-reg-losses-derived field the way PWHL combines them.
- **`ahl_player_seasons`/`echl_player_seasons` have no `shot_pct`/`gw_goals`/`pp_assists`/`sh_assists` columns** — confirmed absent from both leagues' HockeyTech feeds entirely, not just occasionally null.
- **Both leagues' PBP goal events carry `goalie_id: null`** — a real structural difference from PWHL's feed, which synthesizes its "goal" rows from a richer "shot" event that *does* carry goalie info. There's no `/ahl/goalie-shots` or `/echl/goalie-shots` route (unlike `/pwhl/goalie-shots`) — building one here would silently under-count every goal allowed, so it's an honest "not available" on the frontend instead of a misleading stat.

**AHL was built first, ECHL as a fast-follow**, per the original investigation's recommendation ([eyewall-poller#69](https://github.com/ehlersio/eyewall-poller/pull/69) through [#74](https://github.com/ehlersio/eyewall-poller/pull/74)) — both shipped the same 6-phase progression:
1. **Foundation** — `/ahl/standings`, `/schedule`, `/roster`, `/players`, `/league-players`, `/shots`, `/team-season-summary` (#69). ECHL's own foundation pass ([#75](https://github.com/ehlersio/eyewall-poller/pull/75)) shipped the identical 7 routes.
2. **Player detail** — `/player/landing`, `/player/career`, `/player-shots` (AHL [#70](https://github.com/ehlersio/eyewall-poller/pull/70), ECHL [#76](https://github.com/ehlersio/eyewall-poller/pull/76)).
3. **Game/schedule detail** — `/lastgame`, `/summary`, `/preview`, `/game-box`, `/prediction`, plus AHL's `/player-game-log` (AHL [#71](https://github.com/ehlersio/eyewall-poller/pull/71), ECHL [#77](https://github.com/ehlersio/eyewall-poller/pull/77)). `/player-game-log` shipped for AHL only at first; ECHL got it in 2026-09 when the two leagues merged into `hockeytech.js`. It's the data for the player popup's Compare-tab trend chart (same role as `/pwhl/player-game-log`).
4. **Team comparison / head-to-head** — `/team-seasons/compare`, `/compare-teams`, `/head-to-head`, `/head-to-head/narrative`, plus `/config/seasons/comparison`'s league entry (AHL [#72](https://github.com/ehlersio/eyewall-poller/pull/72), ECHL [#79](https://github.com/ehlersio/eyewall-poller/pull/79) — see [Live Season Resolution](#live-season-resolution) above for the real AHL bug this phase found and fixed).
5. **News feed** — `/news`, `/news/ingest`, `/news/bust`, plus a `sport=ahl`/`sport=echl` entry in `/news/latest` (AHL [#73](https://github.com/ehlersio/eyewall-poller/pull/73), ECHL [#80](https://github.com/ehlersio/eyewall-poller/pull/80)).
6. **Live game tracking** — `/today`, `/live/:gameId`, plus `pollAHL`/`pollAHLGame`/`broadcastAHL` and `pollECHL`/`pollECHLGame`/`broadcastECHL` wired into `worker.js`'s per-minute `scheduled()` (AHL [#74](https://github.com/ehlersio/eyewall-poller/pull/74), ECHL [#81](https://github.com/ehlersio/eyewall-poller/pull/81)). Both leagues' PBP normalizers were confirmed live against a real completed game (AHL game 1028925; ECHL game 24296, 81 events) — this resolved the original investigation's "unverified, assumed PWHL shape" caveat for the `penalty`/`goalie_change` event shapes on both leagues.

**News sources differ in count, not structure.** AHL has 3 (`theahl.com/feed` — the official league site, no PWHL equivalent since pwhl.com has no news RSS at all; `thehockeywriters.com/category/ahl/feed/`; OurSportsCentral's AHL feed, league id 17). ECHL has only 2 — confirmed live that `echl.com` has no discoverable RSS feed at all (`/feed` and `/rss` both 404, the same Laravel/Livewire rebuild that keeps its HockeyTech key off the network tab too) — just `thehockeywriters.com/category/echl/feed/` and OurSportsCentral's ECHL feed, **league id 18, not 17** (searched for it live rather than assumed sequential-by-launch-date IDs on that site). All 5 sources across both leagues are scoped to their own league by construction, so unlike `PWHL_NEWS_SOURCES`, none need keyword filtering.

**Team ID → abbreviation maps** (`AHL_TEAM_CODES` in `ahl.js`, 32 current teams; `ECHL_TEAM_CODES` in `echl.js`, 30 teams) are hardcoded snapshots, same convention as `PWHL_TEAM_CODES` — no `ahl_teams`/`echl_teams` table exists; team display metadata is a frontend concern. `AHL_TEAM_CODES` also carries one historical entry (`317: 'BRI'`) for the Bridgeport Islanders, who relocated to become the Hamilton Hammers (`457`) for 2026-27 — needed so historical-season queries against the old franchise still resolve correctly. **If a future realignment or expansion changes either league's team IDs, add the new id here** — the same "multiple independent per-league team-ID maps across repos" gotcha PWHL's own [October Season Prep](#october-season-prep) note below already documents applies to AHL/ECHL too.

**Real bugs found and fixed along the way** (beyond the AHL comparison-seasons config gap covered under [Live Season Resolution](#live-season-resolution) above):
- **Cloudflare KV's minimum `expiration_ttl` is 60 seconds, not 30.** `/ahl/live/:gameId` and `/echl/live/:gameId` both use a 60s TTL for a non-final game (not PWHL's original 30s) — confirmed live against a real completed game that a 30s value throws `KV PUT failed: 400 Invalid expiration_ttl`. The same bug existed in `/pwhl/live/:gameId` and was fixed there in the same pass, since it had apparently never been exercised against a real non-final game before.
- **`shared.js`'s `safeId(sourceId, link)` truncated its hash to a fixed-length prefix of the article URL**, which collides whenever two articles' URLs share a long common prefix — confirmed live while building AHL's news feed: `theahl.com`'s own RSS feed republishes NHL.com's "32 in 32" prospect series, and every article in that series produced the identical id and collapsed to one row after dedup. Fixed by hashing the *full* link string instead of a truncated prefix. This is shared code (used by every league's news parser, not just AHL's) — production PWHL/NHL news had zero actual duplicate ids at the time of the check, but it was the same latent risk for any future source whose URLs share long prefixes.
- **`shared.js`'s `encryptPushPayload()` (RFC 8291 Web Push) had 3 string literals with a NUL byte where a mandated trailing space belonged** (`'WebPush: info\0'`, `'Content-Encoding: aes128gcm\0'`, `'Content-Encoding: nonce\0'`), broken since 2026-06-22 and found while building ECHL's game/prediction routes ([eyewall-poller#78](https://github.com/ehlersio/eyewall-poller/pull/78), merged). This function backs every push notification across every league — `broadcastAHL`/`broadcastECHL` included — so every push before this fix silently degraded to a generic fallback notification rather than showing real content, because the browser fails to decrypt the payload before the service worker ever sees it. Fixed via a byte-level replace and proven with a from-scratch RFC 8291 round-trip test (encrypt → independently decrypt with the receiver's own private key → confirm the plaintext matches), re-run against the pre-fix code to confirm it throws an auth-tag mismatch.
- **No `/ahl/cache/bust` or `/echl/cache/bust` route exists yet**, unlike PWHL's `POST /pwhl/cache/bust` — a real, still-open gap. A stale AHL/ECHL KV entry currently has to be cleared by hand (`wrangler kv key delete <key> --remote`), which came up for real during a mid-2026-08 AHL data backfill.

**Test coverage.** `src/__tests__/hockeytech-leagues.characterization.test.js` (added 2026-09) covers every AHL and ECHL route, the live-game poll, and the news fetch for both leagues with snapshot ("golden master") tests — see [Testing](#testing) below. `src/__tests__/ahl-routes.test.js` still holds the original hand-written assertions for AHL's 7 foundation routes.

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
- `src/__tests__/pwhl-routes.test.js` — `handlePWHL`'s equivalent: `/pwhl/standings`'s enrichment logic, the `POLL_SECRET`-gated cache-bust/ingest routes, the AI-calling routes (`/pwhl/scout`, `/pwhl/summary/narrative`, `/pwhl/prediction`, `/pwhl/team-seasons/head-to-head/narrative`), `/pwhl/preview`'s gameCenterPreview normalization, `/pwhl/summary`'s gameSummary normalization (venue, officials, Head-Coach-only coach filtering), `/pwhl/player/career`'s profile fields (bio HTML-to-plain-text extraction, `is_primary` photo selection, `display_drafts`-gated draft data, most-recent-first game log), and `/pwhl/transactions`'s normalization (flat list, ignores the `num_results` section).
- `src/__tests__/ahl-routes.test.js` (added 2026-08, AHL Phase 1) — `AHL_TEAM_CODES`'s 32-team-plus-historical-`BRI`-entry shape, and `/ahl/standings` through `/ahl/team-season-summary` (the 7 foundation routes): cache-hit short-circuit, the no-OT-split L10/streak enrichment, graceful degradation when only the game-log fetch fails, and `/ahl/team-season-summary`'s deliberate absence of a hits/faceoff/penalties section. Every AHL and ECHL route is also covered by the characterization suite below.
- `src/__tests__/hockeytech-leagues.characterization.test.js` (added 2026-09, ahead of merging `ahl.js`/`echl.js` into one shared implementation) — runs every AHL and ECHL route, `pollAHL`/`pollECHL`, and `fetchAHLNews`/`fetchECHLNews` against one shared fixture set (keyed by table suffix and HockeyTech view, so the same fixtures drive both leagues) and snapshots what each does: response status/body, every upstream request (URL, `Range`, HockeyTech `Referer`, the AI prompt), and every KV write with its TTL. Also asserts that repeat calls are served from cache, missing params return 400, and a Supabase outage returns 502. The date is faked to an in-season January evening so output is deterministic. **The snapshots are the refactor's safety net:** a snapshot diff means behavior changed — explain it in the PR rather than updating the snapshot blindly. Records one known bug as current behavior: a game that's already final when polled gets no game-over push, because `pollAHL`/`pollECHL` only hand live games to the per-game handler (`pollPWHL` has the same gap).
- `src/__tests__/apns-push.test.js` (added 2026-09, native iOS push) — `subId()`'s token-over-endpoint precedence, `sendPush()`'s platform dispatch, and `sendAPNsPush()` itself: real ES256 JWT signing + the actual APNs request shape (host selection by `APNS_ENV`, `apns-topic`/`apns-push-type` headers, `aps.alert` + merged custom data body), the config-missing guard, 410→`'expired'` mapping, and the KV-cached-JWT reuse path. Uses a disposable P-256 keypair generated fresh per run (Node's `crypto.generateKeyPairSync`) — not a real APNs credential. Real end-to-end delivery is still unverified against Apple's actual push gateway pending `APNS_KEY_ID`/`APNS_TEAM_ID`/`APNS_AUTH_KEY` (see [Secrets](#secrets)) and a physical-device test build.

The remaining ~35 plain read-proxy routes (parse params → cache check → `sbRows()`/fetch → cache write → JSON) all follow the same shape already covered here and are mechanical to extend if ever needed — that count is NHL/PWHL only; AHL/ECHL routes are all covered by the characterization suite above.

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
| `ADMIN_EMAILS` | Comma-separated allowlist for `GET /admin/health` (news-feed source health). Optional — falls back to a single hardcoded default (`matt@ehlers.io`) if unset. See `shared.js`'s `verifyAdminUser()`. |
| `VAPID_PRIVATE_KEY` | Web Push VAPID private key |
| `VAPID_PUBLIC_KEY` | Web Push VAPID public key |
| `VAPID_SUBJECT` | Web Push contact (`mailto:...`) |
| `APNS_KEY_ID` | Native iOS push (added 2026-09, not yet set — see `shared.js`'s `sendAPNsPush()`): the Key ID for the APNs Auth Key (.p8) from Certificates, Identifiers & Profiles → Keys on the Apple Developer portal |
| `APNS_TEAM_ID` | Native iOS push: Apple Developer Team ID (already on file for code signing — `MHTBPZT59D`, see `ios/App/App.xcodeproj/project.pbxproj`'s `DEVELOPMENT_TEAM`) |
| `APNS_AUTH_KEY` | Native iOS push: the .p8 auth key's full PEM text (`-----BEGIN PRIVATE KEY-----...`) |
| `NHL_SEASON` | **No longer read anywhere in this repo as of 2026-07.** Season resolution is entirely handled by `seasons.js`, whose own fallback is a hardcoded constant, not this secret. Kept here only because `eyewall-pipeline`'s `db.py` still reads a secret of the same name as *its* fallback — that's a separate repo/secret, not this one. Safe to leave this one stale or eventually remove it. |
| `X_ACCESS_SECRET` | X (Twitter) OAuth access secret |
| `X_CONSUMER_SECRET` | X (Twitter) OAuth consumer secret |

**Bindings (wrangler.toml):**

| Binding | Type | Description |
|---------|------|-------------|
| `CACHE` | KV Namespace | All KV read/write operations |
| `AI_ROUTE_LIMITER` | Rate Limit | Per-IP, per-route limit (10 req/60s) on the AI-calling routes with no secret check — `/prediction/analyze`, `/summary/narrative`, `/pwhl/summary/narrative`, `/pwhl/scout`, `/pwhl/prediction`, `/team-seasons/head-to-head/narrative`, `/pwhl/team-seasons/head-to-head/narrative`, and (added 2026-08) `/ahl/prediction`, `/ahl/team-seasons/head-to-head/narrative`, `/echl/prediction`, `/echl/team-seasons/head-to-head/narrative`. A single shared binding — `checkAiRateLimit(env, request, routeName)` (`shared.js`) keys each check as `${routeName}:${ip}`, so one binding covers every league's AI routes without a per-league namespace_id. Provisioned automatically from `wrangler.toml` at deploy time, no dashboard setup needed. Unrelated to which AI provider those routes call — unaffected by the OpenRouter migration below. |

### Model provider: OpenRouter

AI generation (`/summary/narrative`, `/pwhl/summary/narrative`, `/pwhl/scout`, `/prediction/analyze`, `/draft/analyze`, `/pwhl/prediction`, `/team-seasons/head-to-head/narrative`, `/pwhl/team-seasons/head-to-head/narrative`, plus the internal `generateGameSummary()`/`buildPreseasonFallback()` helpers — 11 call sites total) went through a Cloudflare Workers AI `[ai]` binding (`env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8-fast', ...)`) until 2026-08. All 11 now call `shared.js`'s `generateText(env, {messages, max_tokens})`, a plain `fetch()` to OpenRouter's `google/gemma-4-26b-a4b-it` — the `[ai]` binding was removed from `wrangler.toml` since nothing reads `env.AI` anymore. `/ahl/prediction`, `/ahl/team-seasons/head-to-head/narrative`, `/echl/prediction`, and `/echl/team-seasons/head-to-head/narrative` (added 2026-08, after the OpenRouter migration) call `generateText()` directly — they never went through the old `[ai]` binding at all.

Same model swap and reasoning as `eyewall-pipeline`'s `ai_client.py` was *originally* — see that repo's README for the full writeup: real accuracy problems found in the old model via side-by-side testing, and why OpenRouter rather than Cloudflare's own hosting of the same new model — its default "thinking" mode burns the whole completion budget and returns empty content, with no working way found to disable it via Cloudflare's endpoint; OpenRouter's own `reasoning: {enabled: false}` works correctly against the same model. **No longer in sync as of 2026-09**: `ai_client.py` switched again, to `deepseek/deepseek-v4.1-flash`, after a second side-by-side test found more real accuracy problems in Gemma. This repo's `shared.js` still calls `google/gemma-4-26b-a4b-it` directly (`generateText()`, line ~205) — not yet re-evaluated against this repo's own prompts, which differ from the pipeline's (game summaries, scouting, draft analysis vs. the pipeline's narrative styles). Don't assume parity between the two repos' model choices without checking `shared.js` directly.

### Prediction win probability: Elo (2026-09)

`/prediction/analyze`'s two branches (in-season, and the true-preseason fallback in `buildPreseasonFallback()`) both read `team_elo_ratings` (a `eyewall-pipeline` table, updated nightly by `elo_ratings.py`) via `fetchEloRatings()`/`eloWinProb()`, replacing a hand-tuned scorecard (in-season, with a separately fitted isotonic-calibration patch) and a roster-continuity-dampened variant of the same scorecard (preseason) — see `eyewall-pipeline/docs/elo_prediction_model_results.md` for the backtest this is based on (Elo beat both prior systems on every metric, in both regimes). One model now serves both regimes; the preseason branch no longer needs roster/continuity data at all, since Elo's own season-boundary regression-to-mean (applied pipeline-side, nightly) already does that job from real outcomes.

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
| `APNS_ENV` | Native iOS push: `production` or `sandbox` (default when unset). **Set to `production` as of 2026-09-14** — TestFlight and App Store builds register production APNs tokens (Xcode signs archives with the production `aps-environment`, even though `App.entitlements` says `development`), and those tokens only work against `api.push.apple.com`. Side effect: debug builds run straight from Xcode get sandbox tokens and won't receive pushes while this is `production`. |
| `APNS_BUNDLE_ID` | Native iOS push: defaults to `com.eyewallanalytics.app` (the app's bundle ID) if unset |

## KV Namespace

Binding: `CACHE` (`08c4ef455c584c83a811a96aa3c620ed`)

Key patterns:

| Key | TTL | Description |
|-----|-----|-------------|
| `schedule:{ABBR}` | 10min | NHL team schedule |
| `roster:{ABBR}` | 1hr | NHL team roster (`/v1/roster/{team}/current` proxy — added 2026-09 alongside the KV caching fix below) |
| `nhl:injuries:{ABBR}` | 1hr | NHL team injury report (Supabase `player_injuries`, nightly-ingested from ESPN by `eyewall-pipeline`'s `injuries.py`) |
| `nhl:transactions:team:{ABBR}` / `nhl:transactions:league` | 1hr | NHL transactions feed with trade halves paired (Supabase `nhl_transactions`, nightly-ingested from ESPN by `eyewall-pipeline`'s `transactions.py`). A failed Supabase read is not cached |
| `nhl:trades:tree:{txId}` | 1hr | One trade's tree (`/trades/tree`, Supabase `trades` / `trade_assets` from `eyewall-pipeline`'s `trade_trees.py`). Not-found and failed reads are not cached |
| `nhl:scratches:{ABBR}:{season or auto}:{gameType}` | 1hr | Per-player scratch summary for one team-season (Supabase `game_scratches`, nightly-ingested by `eyewall-pipeline`'s `scratches.py`). `auto` = no explicit season (may fall back to the prior season). A failed Supabase read is not cached |
| `draft:pick-history:{ABBR}:{sinceYear}` | 6hr | A team's picks made + own picks traded away over the last 5 drafts (Supabase `draft_pick_history`, nightly-refreshed by `eyewall-pipeline`'s `draft_history.py`). A failed Supabase read is not cached |
| `nhl:playoff-odds:{ABBR}:{season or latest}` | 1hr | A team's simulated playoff odds: latest run, season history, next game-day stakes (Supabase `playoff_odds` / `playoff_odds_game_impacts`, written nightly by `eyewall-pipeline`'s `playoff_odds.py`). Neither a failed read nor an empty result (before the season's first run) is cached |
| `nhl:injury-impact:{ABBR}:{season or latest}` | 1hr | A team's season-to-date man-games + WAR lost to injury, with league averages (Supabase `team_injury_impact`, rebuilt nightly by `eyewall-pipeline`'s `injury_impact.py`). Neither a failed read nor an empty result (before the 2026-27 regular season's first game) is cached |
| `nhl:scorecard` | 1hr | The public prediction scorecard: each model's latest live period + backtest (Supabase `prediction_scorecard`, rebuilt nightly by `eyewall-pipeline`'s `prediction_scorecard.py`). Neither a failed read nor an empty table is cached |
| `nhl:elo-ratings` | 1hr | Every team's Elo rating + the home advantage (Supabase `team_elo_ratings`, updated nightly by `eyewall-pipeline`'s `elo_ratings.py`). Neither a failed read nor an empty table is cached |
| `nhl:probable-starters:{gameId}` | 1hr | Both teams' goalies and the probability each starts one game (Supabase `goalie_start_probs`, written nightly by `eyewall-pipeline`'s `starting_goalie.py` once the game is within 2 days). Neither a failed read nor an empty result (game outside the window) is cached |
| `live:gameId` | 60s | Current live NHL game ID |
| `pbp:{gameId}` | 60s live / 1hr final | NHL play-by-play |
| `boxscore:{gameId}` | 60s live / 1hr final | NHL boxscore |
| `standings` | 5min | NHL standings — `poll()` refetches only once this lapses, not every tick |
| `news:{ABBR}` | 30min | NHL team news |
| `pp_units:all` | 4hr | PP/PK unit rosters — the cron re-reads Supabase only once this lapses; `/pp-units/refresh` forces a re-read (e.g. right after a pipeline run) |
| `push:subs` | 1yr | Push subscriptions — Web Push (`endpoint`+`keys`) and, as of 2026-09, native iOS (`platform: 'ios'` + APNs device `token`) share this one array; `sendPush()`/`broadcast()` branch on `sub.platform` |
| `apns:jwt` | 55min | Cached APNs auth JWT (ES256, signed with `APNS_AUTH_KEY`) — Apple asks clients not to mint a fresh one per request; see `shared.js`'s `buildAPNsJWT()` |
| `pwhl:standings:{season}` | 1hr | PWHL standings |
| `pwhl:players:{teamId}:{season}` | 1hr | PWHL roster + stats |
| `pwhl:shots:{teamId}:{season}` | 6hr | PWHL shot events |
| `pwhl:schedule:{teamId}:{season}` | 30min | PWHL team schedule |
| `pwhl:news` | 25hr populated / 5min empty | PWHL news feed. Written by both `/pwhl/news/ingest` (nightly pipeline) and `fetchPWHLNews()` (on-demand cold-cache path) — both now use the same TTL (fixed 2026-08-14, was a 30min/5min mismatch that let the nightly job's fuller article set get silently replaced by the on-demand path's narrower 3-source result once a day). |
| `pwhl:today:{season}` | 60s | Today's PWHL games + status |
| `pwhl:live:{gameId}` | 30s live / 1hr final | PWHL live PBP |
| `pwhl:gamesummary:{gameId}` | 1hr | PWHL game summary (goals, MVPs, team stats, venue, officials, head coaches) |
| `pwhl:narrative:{period}:{gameId}:{carAbbr}` | 24hr | AI period/game narrative per team perspective |
| `pwhl:transactions:{season}` | 24hr | League-wide signings/moves feed |
| `pwhl:pshots:{playerId}:{season}` | 6hr | PWHL player shot heat map data |
| `pwhl:player:landing:{playerId}:{season|'latest'}` | 1hr | Single PWHL player's identity + one season's stat line |
| `config:season:nhl` | 6hr | Live-resolved current NHL season (see [Live Season Resolution](#live-season-resolution)) |
| `config:season:pwhl` | 6hr | Live-resolved current PWHL season `{seasonId, seasonType, startYear}` |
| `config:season:nhl:override` | none (manual) | Forces a specific NHL season, bypassing live resolution entirely |
| `config:season:pwhl:override` | none (manual) | Forces a specific PWHL season, bypassing live resolution entirely |
| `players-search-index` | 6hr | Flat NHL+PWHL+AHL+ECHL player list for the global player-search autocomplete |
| `trivia:{date}:{sport}:{team\|'ALL'}` | 24hr once populated, 60s if empty/partial | Daily trivia — all three tiers (easy/medium/hard) for one sport+team, one day (Phase 2, Session 92). Short TTL guard mirrors `/draft/picks`' pattern so a pre-publish snapshot from before the nightly job finishes doesn't get pinned for a full day. |
| `milestones:{sport}:{team}:{limit}:{season}` | 1hr | `/milestones`' own list cache, one entry per distinct query shape. Includes the live-resolved season (added 2026-08) so a cached entry never survives a season flip. |
| `milestones:latest:{sport}:{season}` | 1hr | Cheapest "is there anything new" check for the frontend's Milestones read-state badge (Phase 2, Session 92) — `{latestId, gameDate}` only, not the full feed. Season-scoped (added 2026-08) in lockstep with `/milestones` itself. |
| `ahl:standings:{season}` / `echl:standings:{season}` | 1hr | AHL/ECHL standings + L10/streak (no OT/SO split — see [AHL & ECHL](#ahl--echl)) |
| `ahl:schedule:{teamId}:{season}` / `echl:schedule:{teamId}:{season}` | 30min | Team schedule |
| `ahl:roster:{teamId}` / `echl:roster:{teamId}` | 24hr | Bare roster (name + jersey) — rarely changes |
| `ahl:players:{teamId}:{season}` / `echl:players:{teamId}:{season}` | 1hr | Roster + skater/goalie season stats, name-enriched |
| `ahl:leagueplayers:{season}` / `echl:leagueplayers:{season}` | 2hr | All teams' skater + goalie season stats (Leaders tab) |
| `ahl:shots:{teamId}:{season}` / `echl:shots:{teamId}:{season}` | 1hr | Shot events for team heat map — paginated fetch (1000-row Supabase batches), cached whole |
| `ahl:team-season-summary:{teamId}:{season}` / `echl:team-season-summary:{teamId}:{season}` | 1hr | Season-aggregate SOG + PP%/PK% — deliberately no hits/faceoff/penalties section (no data source, see [AHL & ECHL](#ahl--echl)) |
| `ahl:player:landing:{playerId}:{season|'latest'}` / `echl:player:landing:{...}` | 1hr | Player-popup self-fetch: identity + one season's stat line |
| `ahl:player:career:{playerId}` / `echl:player:career:{playerId}` | 24hr | Career Regular Season/Playoffs totals, live HockeyTech `view=player` proxy |
| `ahl:pshots:{playerId}:{season}` / `echl:pshots:{playerId}:{season}` | 6hr | Single skater's shot heat map data |
| `ahl:lastgame:{teamId}:{season}` / `echl:lastgame:{teamId}:{season}` | 1hr | Most recent completed game, opponent abbr resolved |
| `ahl:gamesummary:{gameId}` / `echl:gamesummary:{gameId}` | 1hr | Game summary (goals, MVPs, officials, coaches, venue) — hits/faceoff fields stripped |
| `ahl:gcpreview:{gameId}` / `echl:gcpreview:{gameId}` | 30min | Pre-game preview, raw HockeyTech `gameCenterPreview` passthrough |
| `ahl:gamebox:{gameId}` / `echl:gamebox:{gameId}` | 1hr | Per-player box score (skaters + goalies), name-enriched |
| `ahl:pgamelog:{playerId}:{season}` | 1hr | Per-game log for a single player — **AHL only**, no ECHL equivalent (see [AHL & ECHL](#ahl--echl)) |
| `ahl:prediction:{gameId}` / `echl:prediction:{gameId}` | 30min | Win probability + AI narrative — no Corsi term (no data source) |
| `ahl:team-seasons:compare:{teamId}:{seasons}` / `echl:team-seasons:compare:{...}` | 1hr | One team across a comma-separated season list |
| `ahl:team-seasons:compare-teams:{teamIds}:{season}` / `echl:team-seasons:compare-teams:{...}` | 1hr | Two teams, one shared season |
| `ahl:team-seasons:head-to-head:{teamIds}` / `echl:team-seasons:head-to-head:{teamIds}` | 1hr | All-time head-to-head across every season on record |
| `ahl:h2h-narrative:{teamIds}` / `echl:h2h-narrative:{teamIds}` | 24hr | AI narrative layer on the head-to-head stats above |
| `ahl:news` / `echl:news` | 25hr populated / 5min empty | News feed — 3 AHL sources, 2 ECHL sources (see [AHL & ECHL](#ahl--echl)); same populated/empty TTL split as `pwhl:news` above |
| `ahl:today:{season}` / `echl:today:{season}` | 60s | Today's games with live status |
| `ahl:live:{gameId}` / `echl:live:{gameId}` | 60s live / 1hr final | Live PBP + normalized events. 60s, not 30 — Cloudflare KV's `expiration_ttl` minimum is 60s (see [AHL & ECHL](#ahl--echl)) |
| `ahl:push:{state|start|period|goal|pen|pull|final}:...` / `echl:push:{...}` | 24-48hr | Per-game push-notification dedup keys (game start, period start, goal, PP, goalie pulled, final) — mirrors NHL/PWHL's own push state-tracking shape, prefixed per league |
| `config:season:ahl` / `config:season:echl` | 6hr | Live-resolved current AHL/ECHL season `{seasonId, seasonType}` |
| `config:season:ahl:override` / `config:season:echl:override` | none (manual) | Forces a specific AHL/ECHL season, bypassing live resolution entirely |
| `config:season:ahl:seasons` / `config:season:echl:seasons` | 6hr | Cached raw HockeyTech `modulekit&view=seasons` response backing season-type/season-list lookups |

## Config Endpoints

| Method | Path | Description |
|--------|------|--------------|
| `GET` | `/config/seasons` | Live-resolved current NHL + PWHL + AHL + ECHL season (`{nhl: {seasonId}, pwhl, ahl, echl}` — see [Live Season Resolution](#live-season-resolution)). Consumed by the frontend at app boot and by the pipeline's `season_lookup.py`. |
| `GET` | `/config/seasons/comparison` | Every season with `team_seasons`/`pwhl_team_seasons`/`ahl_team_seasons`/`echl_team_seasons` rows, per league, with a team count and a `comparable` flag (strictly more than half of the league's current active team count has a row). Backs the season-over-season comparison feature (Session 64; AHL/ECHL entries added 2026-08 — see [Live Season Resolution](#live-season-resolution) for the real AHL bug this fixed) — distinct from `/config/seasons`, which only ever answers "what's current." 1hr KV cache (`config:seasons:comparison`). |
| `GET` | `/players-search-index` | Flat `{id, name, team, position, sport}` list of every NHL + PWHL + AHL + ECHL player, for the frontend's player-search autocomplete. NHL team is resolved from each player's most-recently-updated current-season `player_seasons` row — unchanged by the Combined Prediction Calibration work's `players.team` addition (2026-07); that column exists now, but this route's own derivation wasn't revisited here, out of scope for that change. If the live season has zero `player_seasons` rows at all yet (season flipped ahead of real games, e.g. once the new schedule is released — see [Live Season Resolution](#live-season-resolution)), NHL entries fall back to one season back and add `teamStale: true` + `teamSeason: "<season>"`; a player with no row in either season gets `team: null` with no `teamStale` field. PWHL/AHL/ECHL have no season dimension in their players tables (one row per player, current team assignment only) — no staleness concept applies to those three. |
| `GET` | `/trivia/today?sport=&team=&locale=` | All three trivia tiers (easy/medium/hard) for one sport in a single response, `team` optional (adds that team's medium-tier question; omit for easy/hard only) — Daily Trivia (Phase 2, Session 92). Easy/medium require an exact `question_date` match (nightly-populated by the pipeline's `trivia_questions.py`; no match means "not published yet," shown as the empty state). Hard is hand-curated with no admin UI, added in batches rather than nightly — its query falls back to the most recent row on or before today (`question_date=lte.&order=question_date.desc`) instead of an exact match, so it only goes empty if zero hard rows exist yet for that sport, not on every day between curation batches. Correct answer/explanation are included in the response (not split into a post-answer reveal step) — accepted for a low-stakes trivia feature. `locale` (`en`/`fr`, defaults to `en`) filters all three tiers — see [French/English localization](#frenchenglish-localization) below. |
| `GET` | `/news/latest?sport=&team=` | Cheap "is there anything new" check for the frontend's News read-state badge (Phase 2, Session 92; `ahl`/`echl` added 2026-08 alongside their own news feeds — see [AHL & ECHL](#ahl--echl)) — reuses the exact `news:{ABBR}`/`pwhl:news`/`ahl:news`/`echl:news` KV entries `/news`/`/pwhl/news`/`/ahl/news`/`/echl/news` already populate (pure KV read when warm) rather than a second parallel fetch; triggers the same background warm on a cold cache and returns `{latestId: null}` for that request. `sport` must be `nhl`, `pwhl`, `ahl`, or `echl`. `team` required for `sport=nhl` (news is per-team), omitted for `sport=pwhl`/`ahl`/`echl` (one global feed each). |
| `GET` | `/milestones?team=&sport=&limit=` | Recent milestones (hat tricks, shutouts, SH goals, season/career thresholds) — hard-coded to NHL unless `sport=pwhl`, optional single-team filter, `limit` default 50 / max 100. Populated nightly by the pipeline's `milestones.py` (NHL) / `pwhl_milestones.py` (PWHL) into one shared `milestones` table (`is_pwhl` column). Scoped to the live-resolved current season (added 2026-08, see [Live Season Resolution](#live-season-resolution)) — before this, an unfiltered "most recent N" query had no way to age out an old row once the table stopped getting new ones (e.g. NHL offseason), so a leftover milestone from the prior season could sit as the only NHL row indefinitely. |
| `GET` | `/milestones/latest?sport=` | Same badge purpose as `/news/latest`, for Milestones — its own minimal `limit=1` query since no reusable unfiltered KV entry exists for that table (the real `/milestones` route's key always includes `team`+`limit`+`season`). `gameDate` is date-granularity, not a timestamp — `milestones` has no insertion-time column, accepted as good enough for a boolean seen/unseen badge. Season-scoped in lockstep with `/milestones` — otherwise this could flag "unseen" for an id that no longer appears in the (now season-scoped) list at all. |
| `GET` | `/admin/health` | News-feed source health (per-source last success/error/timestamps across all 4 leagues) — gated to the app owner, see `ADMIN_EMAILS` above. Added 2026-09; nothing recorded fetch success/failure before this, every `fetch*News()`/`*/news/ingest`/`/atom/ingest` call site now writes a `health:<league>:<sourceId>` KV record via `shared.js`'s `recordHealth()`. Consumed by `eyewall-analytics`'s hidden `/admin/health` page. |

## NHL Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/cache/:key` | Read any KV key (primary NHL data path) |
| `GET` | `/news?team=` | Team news feed |
| `GET` | `/schedule?team=` | Team schedule |
| `GET` | `/roster?team=` | Team roster (`/v1/roster/{team}/current` proxy, KV-cached 1hr — see `roster:{ABBR}` above). Added 2026-09: the frontend's own `getRoster()` used to call NHL directly with zero caching, unlike this route's `/schedule`/`/standings` siblings — every page load was a genuinely fresh live upstream fetch, the root cause of repeated Cypress flakiness against a real, unmocked, uncached third-party call. |
| `GET` | `/injuries?team=` | Team injury report, read from Supabase's `player_injuries` table (KV-cached 1hr — see `nhl:injuries:{ABBR}` above). NHL has no official injuries endpoint, so `eyewall-pipeline`'s `injuries.py` ingests from ESPN's undocumented API nightly and writes the table this route serves; not season-scoped, unlike `/team-lines`. Each row: `player_id` (nullable — unmatched ESPN names are kept), `player_name`, `status`, `comment`, `espn_updated_at`, plus `injury_type`/`injury_side`/`injury_detail`/`return_date` (2026-09, any of the four may be null). Degrades to `[]` on a Supabase read failure rather than a 502. The daily `player_injury_history` table isn't exposed by any route yet. |
| `GET` | `/transactions?team=` / `/transactions?scope=league` | NHL transactions feed from Supabase's `nhl_transactions` (`eyewall-pipeline`'s `transactions.py`, ESPN's NHL transactions feed — the NHL API has none). Team scope returns that team's own entries plus trades naming it (`or=(team.eq.X,counterparties.cs.{X})`); league scope returns the most recent moves league-wide; both newest first, up to 150 rows. ESPN posts each side of a trade separately, so `pairTransactions()` (`src/transactions.js`) merges a trade entry from A naming B with one from B naming A within ±2 days into `{ kind: 'trade', ids, date, teams, sides: [{team, description}] }` (focus team first); everything else is `{ kind: 'move', id, date, team, category, categories, counterparties, description }`. `ids`/`id` are the `nhl_transactions` row ids `/trades/tree?tx=` takes. Response: `{ scope, team, items }`. `team` must be a 2–3 letter abbreviation (400 otherwise — it's interpolated into the PostgREST filter). KV-cached 1hr; a Supabase read failure returns empty `items` and is **not** cached. |
| `GET` | `/trades/tree?tx=` | One NHL trade and where every asset went next, from Supabase's `trades` / `trade_assets` (`eyewall-pipeline`'s `trade_trees.py`: ESPN's trade text parsed into players and picks, picks resolved to the drafted player via the NHL's draft records, each asset linked by `next_trade_id` to the next trade its new team sent it on in). `tx` is any `nhl_transactions` id from `/transactions`' items — the trade containing it is the root. `fetchTradeTree()` (`src/trades.js`) follows `next_trade_id` breadth-first, one Supabase read per level, up to 5 levels / 30 trades (`truncated: true` past that), and loads the trades that brought the root's outgoing assets in (`origins`, one level back). Response: `{ found, root, trades: { <id>: { id, date, teams, via, descriptions, sides: [{ team, received: [asset] }] } }, origins: [{ id, date, teams, assets }], truncated }`; an asset is `{ type, from, to, next, … }` with `name`/`position`/`rights`/`playerId` for players and `pick: { year, round, conditional, overall, resolvedYear, resolvedOverall, draftedName, draftedId, note }` for picks (`note` null when resolved, else `future` / `not_traced` / `several_possible`). `tx` must be digits (400 otherwise — it's interpolated into the PostgREST filter). KV-cached 1hr; a not-found (`found: false`) and a failed read (`unavailable: true`) are **not** cached. |
| `GET` | `/scratches?team=&season=&gameType=` | Per-player scratch summary for one team-season from Supabase's `game_scratches` (`eyewall-pipeline`'s `scratches.py`: the NHL's own right-rail scratch lists, each classified `healthy`/`injured`/`suspended`/`unknown` against that day's injury snapshot). `gameType` 2 (regular season, default) or 3 (playoffs) — never pooled. Response: `{ team, season, gameType, stale, players: [{ player_id, player_name, total, healthy, injured, suspended, unknown, last_date }], totals, games_with_scratches, classified }`, players most-scratched first (`summarizeScratches()`, `src/scratches.js`). With no `season` and no rows yet for the live season, falls back to the prior season with `stale: true`. `classified: false` means every scratch is `unknown` (all games before 2026-09-12), so a healthy/injured split isn't meaningful. team (2–3 letters), season (8 digits) and gameType are validated (400 otherwise). KV-cached 1hr; a failed read returns an empty summary and is **not** cached. |
| `GET` | `/draft/pick-history?team=` | Where a team's recent draft picks came from and went, from Supabase's `draft_pick_history` (`eyewall-pipeline`'s `draft_history.py`: the NHL records API's draft data, each pick's `teamPickHistory` parsed into `pick_chain`, original owner first, drafting team last). Response: `{ team, sinceYear, made, tradedAway }` over the last 5 drafts, newest first — `made` = picks this team used, `tradedAway` = this team's own original picks another team used (`original_team=eq.X&team=neq.X`). Each row: `draft_year, round, pick_in_round, overall_pick, team, original_team, pick_chain, times_traded, player_id, player_name, position`. `team` must be 2–3 letters (400 otherwise). KV-cached 6hr; a failed read returns empty lists and is **not** cached. |
| `GET` | `/playoff-odds?team=&season=` | A team's simulated playoff odds from Supabase's `playoff_odds` / `playoff_odds_game_impacts` (`eyewall-pipeline`'s nightly `playoff_odds.py`: the rest of the regular season simulated from team Elo ratings). Without `season`, the season of the team's most recent run. Response: `{ team, season, runDate, stale, latest, history, nextGames }` — `latest` = that run's row (`playoff_pct`, `division_pct`, `proj_points`, `points_p10`/`points_p90`, `current_points`, `games_played`, `games_remaining`, `elo_rating`, `sims`, and `change`: `{ prev_run_date, prev_pct, delta, contributions: [{ game_id, home, away, winner, delta }], residual }`, why it moved since the previous run — null on a season's first run); `history` = `[{ run_date, playoff_pct }]` for that season, oldest first; `nextGames` = the team's odds under each result of the next game-day's games, `[{ game_id, game_date, home, away, ifHomeWins, ifAwayWins, own, swing }]`, own games first, then up to 2 other games that swing its odds by ≥ 0.5 pts (`summarizeNextGames()`, `src/playoffOdds.js`); `stale` = no run for 3+ days (season over, or the nightly stopped). Before the season's first run `latest` is null. team (2–3 letters) and season (8 digits) are validated (400 otherwise). KV-cached 1hr; a failed read returns `unavailable: true` and is **not** cached, nor is an empty result. |
| `GET` | `/injury-impact?team=&season=` | A team's season-to-date man-games and WAR lost to injury from Supabase's `team_injury_impact` (`eyewall-pipeline`'s nightly `injury_impact.py`: a player on the day's injury report who didn't dress is a man-game lost, valued at his WAR per game). Without `season`, the team's most recent season row. Response: `{ team, season, impact, league }` — `impact` = `{ season, team, games_played, man_games_lost, war_lost, players_injured, rank_man_games, rank_war_lost, players: [{ player_id, player_name, games, war_lost, last_date, status, injury_type }], updated_at }` (ranks: 1 = most lost in the league); `league` = `{ teams, avgManGames, avgWarLost, avgGamesPlayed }` over every team's row that season (`summarizeInjuryLeague()`, `src/injuryImpact.js`). `impact` is null before the 2026-27 regular season's first game (injury history starts 2026-09-12). team (2–3 letters) and season (8 digits) are validated (400 otherwise). KV-cached 1hr; a failed read returns `unavailable: true` and is **not** cached, nor is an empty result. |
| `GET` | `/scorecard` | The public prediction scorecard from Supabase's `prediction_scorecard` (`eyewall-pipeline`'s nightly `prediction_scorecard.py`): how the app's published predictions have done. Response: `{ models: { game_winner \| starting_goalie \| playoff_odds: { live, backtest } }, updatedAt }` — `live` = graded predictions that were published beforehand (from 2026-27; the model's most recent live period, so a new season's row takes over), `backtest` = the model replayed on past seasons, labeled as such (`summarizeScorecard()`, `src/scorecard.js`). Each row: `model, kind, period, status ('ok'\|'pending'), n, accuracy, brier, log_loss, baseline {name, accuracy, brier}, calibration [{bucket, n, predicted, actual}], recent, note, updated_at`. KV-cached 1hr; a failed read returns `unavailable: true` and is **not** cached, nor is an empty table. |
| `GET` | `/elo/ratings` | Every team's Elo rating from `team_elo_ratings` plus the home advantage: `{ ratings: { ABBR: rating }, homeAdvantage }` — the frontend computes each matchup's win probability with the exact formula `/prediction/analyze` (`eloWinProb()`) and `eyewall-pipeline`'s `win_probs.py` (the morning log the public scorecard grades) use: P(home) = 1 / (1 + 10^((away − (home + homeAdvantage)) / 400)), no advantage at a neutral site. One call covers the game preview's win bar and every schedule card. KV-cached 1hr; a failed read returns `unavailable: true` and is **not** cached, nor is an empty table. `/prediction/analyze` now applies the same neutral-site rule (it used to give the home side the advantage at neutral sites too). |
| `GET` | `/probable-starters?game=` | Both teams' goalies and the probability each starts one game, from Supabase's `goalie_start_probs` (`eyewall-pipeline`'s nightly `starting_goalie.py`: for each team's next regular-season game once it's within 2 days — a model of the team's own pattern, since the NHL publishes no probable starters). Response: `{ gameId, gameDate, runDate, teams: { ABBR: [{ goalie_id, goalie_name, start_prob, factors }] } }`, each team's goalies most likely first (`summarizeStarters()`, `src/probableStarters.js`); `factors` = `{ share_last10, started_last, back_to_back, days_rest, no_recent, injury_status }`. `teams` is `{}` until the game is inside the 2-day window (or for a team the pipeline skipped as still carrying a training-camp roster). `game` must be a 10-digit NHL game id (400 otherwise). KV-cached 1hr; a failed read returns `unavailable: true` and is **not** cached, nor is an empty result. |
| `GET` | `/nhl/today` | Today's games with live status — same normalized shape as `/pwhl/today`/`/ahl/today`/`/echl/today` (session102), but sourced straight from the league-wide `score/now` scoreboard `poll()` already fetches, not a Supabase table (NHL has no `nhl_game_log`-equivalent table; the live NHL API already returns real team abbrevs/scores). 60s KV TTL, matching `poll()`'s own cadence. |
| `GET` | `/health` | Worker health check |
| `POST` | `/poll?secret=` | Manual poll trigger |
| `POST` | `/push/subscribe` | Register a push subscription — Web Push body `{endpoint, keys, teamAbbr, prefs}`, or native iOS (2026-09) `{platform: 'ios', token, teamAbbr, prefs}`. Dedupes by `token` for iOS, `endpoint` otherwise |
| `POST` | `/push/unsubscribe` | Remove a push subscription — body `{endpoint}` (Web Push) or `{token}` (native iOS) |
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
| `GET` | `/pwhl/player/career?id=` | Career Regular Season / Playoffs totals, live proxy of HockeyTech's `view=player` server-computed `careerStats` Total rows (no Supabase, no aggregation on this side). `playoffs` is `null` if the player hasn't made the playoffs yet. Also carries `bioPoints` (plain-text career-highlight bullets, HTML stripped server-side), `photo` (the `is_primary` entry from the player's photo gallery), `draft` (`null` unless HockeyTech's own `display_drafts` flag is true and a row exists — `null` for most players tested so far), and `recentGames` (last 5 games, most-recent-first; field set differs by position). |
| `GET` | `/pwhl/transactions?season=` | League-wide signings/moves feed, live proxy of HockeyTech's `view=transactions`. Genuinely new fetch — not wired into any pipeline table. Returns `{transactions: [{date, player, team, type, action, from}]}`, `player` includes position inline (e.g. `"Neena Brick (F)"`). Not paginated — serves HockeyTech's default 50-row page as-is, the `num_results` section is ignored. |
| `GET` | `/pwhl/player-shots?playerId=&season=` | Player shot heat map data |
| `GET` | `/pwhl/goalie-shots?goalieId=&season=` | Shots faced by a specific goalie, for the goalie heat map (Session 100) — mirrors `/pwhl/player-shots`'s query/normalisation shape against `pwhl_shot_events.goalie_id`, excludes `blocked_shot` (never reaches the goalie) |
| `GET` | `/pwhl/today?season=` | Today's games with live status |
| `GET` | `/pwhl/live/:gameId` | Live PBP + normalized events |
| `GET` | `/pwhl/news` | PWHL news feed |
| `POST` | `/pwhl/news/ingest` | Ingest articles from GH Actions |
| `POST` | `/pwhl/news/bust` | Invalidate news KV cache |
| `POST` | `/pwhl/scout` | AI scouting report for a player |
| `POST` | `/pwhl/cache/bust?secret=&teamId=&season=` | Invalidate one team's KV caches (players/shots/schedule/lastgame) for a given season |
| `GET` | `/pwhl/summary?gameId=` | Game summary (goals, MVPs, team stats, venue, officials, head coaches) from HockeyTech |
| `POST` | `/pwhl/summary/narrative?gameId=&period=&carAbbr=` | AI period/game narrative (cached per team perspective) |
| `GET` | `/pwhl/preview?gameId=` | Pre-game preview for an upcoming game — season series, head-to-head, streaks, team-scoped leading scorers, special teams (Session 51, live HockeyTech `gameCenterPreview` passthrough) |
| `GET` | `/pwhl/prediction?gameId=&force=` | Win probability + AI narrative for an upcoming game (Session 51) — PWHL analog of `/prediction/analyze`'s fallback-tier heuristic, not its DB-first Tier-1 system. `corsiForPct` prefers 5v5-filtered shot-attempt share, falling back to all-situations if the 5v5 column isn't populated yet (Session 53, same preference order as `/prediction/analyze`) — check `corsiCaveat` for which one a given response used |
| `GET` | `/pwhl/team-seasons/compare?teamId=&seasons=` | Box-score fields only (gp/wins/losses/OTL/points/goals-for-against/PP%/PK%) for one team across a comma-separated `season_id` list. PWHL analog of `/team-seasons/compare` (Session 64). Missing seasons for that team are simply absent from the response — no placeholder rows. |
| `GET` | `/pwhl/team-seasons/compare-teams?teamIds=,&season=` | Box-score fields only, for exactly two `team_id`s at one shared `season_id`. PWHL analog of `/team-seasons/compare-teams` (Session 86). A team missing a row for that season (e.g. a 2026-27 expansion team with no prior season) is simply absent from the response. |
| `GET` | `/pwhl/team-seasons/head-to-head?teamIds=,` | All-time head-to-head between two teams across every season on record — PWHL analog of `/team-seasons/head-to-head` (Session 88). `pwhl_game_log` is one row per game with both teams in columns, so this uses an OR-of-AND home/away filter (no `season_id` filter) instead of NHL's simple two-sided filter, then shares the same `buildHeadToHeadPayload` derived-insight computation. |
| `POST` | `/pwhl/team-seasons/head-to-head/narrative` | AI narrative layer on top of the head-to-head stats above (Session 90) — PWHL analog of `/team-seasons/head-to-head/narrative`. This Worker has no PWHL team-name map of its own, so display names come from the client (same reason `/pwhl/summary/narrative` above takes `carName`/`oppName` instead of resolving them server-side). |

## AHL Endpoints

Added 2026-08 across 6 phases ([eyewall-poller#69](https://github.com/ehlersio/eyewall-poller/pull/69)–[#74](https://github.com/ehlersio/eyewall-poller/pull/74)) — see [AHL & ECHL](#ahl--echl) above for the phase breakdown, the data-shape ceiling relative to PWHL, and the real bugs found while building these.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/ahl/standings?season=` | League standings + L10/streak. No OT/shootout split in the streak calc (`ahl_game_log` has no OT/SO boolean columns) — every non-win counts as a plain loss, unlike PWHL's `'O'` |
| `GET` | `/ahl/schedule?teamId=&season=` | Team schedule |
| `GET` | `/ahl/roster?teamId=` | Bare roster (name + jersey) for name resolution (shot-map tooltips, etc.) |
| `GET` | `/ahl/players?teamId=&season=` | Roster + skater/goalie season stats, name-enriched, jersey-sorted roster list for the Roster tab |
| `GET` | `/ahl/league-players?season=` | All teams' skater + goalie season stats (Leaders tab) |
| `GET` | `/ahl/shots?teamId=&season=` | Shot events for team heat map. Only `shot`/`goal` `event_type` rows exist — no `blocked_shot` in this data source |
| `GET` | `/ahl/team-season-summary?teamId=&season=` | Season-aggregate SOG (car vs. opp) + PP%/PK% for the Shot Map's "All N" summary card. Deliberately **no** hits/blocked/faceoff/penalties section, unlike `/pwhl/team-season-summary` — no `ahl_pbp_events` table and no `blocked_shot` event type exist for this league at all; don't fabricate zeros for these fields |
| `GET` | `/ahl/player/landing?id=&season=` | Player-popup self-fetch: identity + one season's stat line, merged (`ahl_players` + `ahl_player_seasons`/`ahl_goalie_seasons`). Supabase-only, no HockeyTech call needed |
| `GET` | `/ahl/player/career?id=` | Career Regular Season/Playoffs totals, live proxy of HockeyTech's `view=player` server-computed `careerStats` Total rows — confirmed live to use the identical shape as `/pwhl/player/career`, reuses `shared.js`'s `extractCareerTotal`/`extractRows`/`extractBioPoints`/`extractPhoto` unmodified. No `?season=` param — career totals are season-independent |
| `GET` | `/ahl/player-shots?playerId=&season=` | Single skater's shot heat map data. **No `/ahl/goalie-shots` equivalent** — AHL's PBP goal events carry `goalie_id: null` (not carried on the goal event itself, a real structural difference from PWHL's feed), so a goalie heat map would silently under-count every goal allowed |
| `GET` | `/ahl/lastgame?teamId=&season=` | Most recent completed game, opponent abbr resolved. No OT/shootout fields (`ahl_game_log` has no such columns) |
| `GET` | `/ahl/summary?gameId=` | Game summary (goals, MVPs, officials, coaches, venue) from HockeyTech's `gameSummary` view — mirrors `/pwhl/summary` except `homeTeamStats`/`visitingTeamStats` strip `hits`/`faceoffAttempts`/`faceoffWins`/`faceoffWinPercentage`, which read `0` regardless of the real game (confirmed at the per-player level too — not charted, not just a PBP omission) |
| `GET` | `/ahl/preview?gameId=` | Pre-game preview for an upcoming game — raw passthrough of HockeyTech's `gameCenterPreview` view, no server-side reshaping (frontend does its own field reading, same as `/pwhl/preview`) |
| `GET` | `/ahl/game-box?gameId=` | Per-player box score (skaters + goalies) for a completed game, from `ahl_skater_game_box`/`ahl_goalie_game_box`. No hits/faceoff/blocked-shots/skater-TOI columns at all |
| `GET` | `/ahl/player-game-log?playerId=&season=` | One player's game-by-game box score rows for a season, oldest first (`skaters[]`/`goalies[]`, whichever table has the player). Data for the player popup's Compare-tab trend chart — same shape as `/pwhl/player-game-log`, but note the param is `season=`, not `seasonId=` |
| `GET` | `/ahl/prediction?gameId=&force=` | Win probability + AI narrative for an upcoming game — ported from `/pwhl/prediction` with the Corsi term dropped entirely (no shot-attempts data source for AHL) |
| `GET` | `/ahl/team-seasons/compare?teamId=&seasons=` | Box-score fields only for one team across a comma-separated `season_id` list. AHL analog of `/pwhl/team-seasons/compare` |
| `GET` | `/ahl/team-seasons/compare-teams?teamIds=,&season=` | Box-score fields only, for exactly two `team_id`s at one shared `season_id`. AHL analog of `/pwhl/team-seasons/compare-teams` |
| `GET` | `/ahl/team-seasons/head-to-head?teamIds=,` | All-time head-to-head between two teams across every season on record — same `buildHeadToHeadPayload` (shared.js) derived-insight computation as NHL/PWHL |
| `POST` | `/ahl/team-seasons/head-to-head/narrative` | AI narrative layer on top of the head-to-head stats above. This Worker has no AHL team-name map of its own for display purposes beyond `AHL_TEAM_CODES`'s abbreviations, so display names come from the client, same reasoning as PWHL's equivalent route |
| `GET` | `/ahl/news` | AHL news feed (3 sources — see [AHL & ECHL](#ahl--echl)) |
| `POST` | `/ahl/news/ingest` | Ingest articles from GH Actions (nightly `ahl_news.py`) |
| `POST` | `/ahl/news/bust` | Invalidate news KV cache |
| `GET` | `/ahl/today?season=` | Today's games with live status |
| `GET` | `/ahl/live/:gameId` | Live PBP + normalized events. Confirmed event types: `goal`, `shot`, `penalty`, `goalie_change`, `penaltyshot`, plus a defensively-included but still-unconfirmed `shootout`. No hit/faceoff/blocked_shot branches — confirmed absent from AHL's PBP entirely. Deliberately does **not** fetch `gameSummary` in parallel the way PWHL's live route does (no faceoff data to merge; goal events already carry assists/properties directly) |

`pollAHL` (built by `hockeytech.js`, not an HTTP route) runs from `worker.js`'s per-minute `scheduled()` alongside NHL/PWHL/ECHL's own poll functions — push notifications for game start, period start, goals (with hat-trick detection), power plays and pulled goalies, gated on `env.VAPID_PRIVATE_KEY` existing and an Oct–June active-season window. Final-score pushes exist in the code but never fire today: the poll only hands live games to the per-game handler, so a game is never seen as final there (`pollPWHL` has the same gap).

## ECHL Endpoints

Added 2026-08 across the same 6 phases as AHL ([eyewall-poller#75](https://github.com/ehlersio/eyewall-poller/pull/75)–[#81](https://github.com/ehlersio/eyewall-poller/pull/81)) — see [AHL & ECHL](#ahl--echl) above. Every route below is a direct port of its AHL equivalent (same query shapes, same KV caching shape) except where noted.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/echl/standings?season=` | League standings + L10/streak. Same no-OT/SO-split simplification as `/ahl/standings` |
| `GET` | `/echl/schedule?teamId=&season=` | Team schedule |
| `GET` | `/echl/roster?teamId=` | Bare roster (name + jersey) |
| `GET` | `/echl/players?teamId=&season=` | Roster + skater/goalie season stats, name-enriched |
| `GET` | `/echl/league-players?season=` | All teams' skater + goalie season stats (Leaders tab) |
| `GET` | `/echl/shots?teamId=&season=` | Shot events for team heat map. Only `shot`/`goal` `event_type` rows exist |
| `GET` | `/echl/team-season-summary?teamId=&season=` | Season-aggregate SOG + PP%/PK%. Same deliberate omission of hits/blocked/faceoff/penalties as `/ahl/team-season-summary` — no `echl_pbp_events` table, no `blocked_shot` event type |
| `GET` | `/echl/player/landing?id=&season=` | Player-popup self-fetch: identity + one season's stat line. Added 2026-08-30, mirrors `/ahl/player/landing` exactly |
| `GET` | `/echl/player/career?id=` | Career Regular Season/Playoffs totals, live HockeyTech `view=player` proxy — reuses the same generic `shared.js` parsers as AHL/PWHL, confirmed identical shape |
| `GET` | `/echl/player-shots?playerId=&season=` | Single skater's shot heat map data. **No `/echl/goalie-shots` equivalent** — same `goalie_id: null` structural gap confirmed live for ECHL too |
| `GET` | `/echl/lastgame?teamId=&season=` | Most recent completed game, opponent abbr resolved. Added 2026-08-30 |
| `GET` | `/echl/summary?gameId=` | Game summary from HockeyTech — confirmed byte-identical shape to AHL's `gameSummary`, same hits/faceoff-field stripping |
| `GET` | `/echl/preview?gameId=` | Pre-game preview, raw HockeyTech `gameCenterPreview` passthrough — confirmed identical top-level shape to AHL's |
| `GET` | `/echl/game-box?gameId=` | Per-player box score, from `echl_skater_game_box`/`echl_goalie_game_box` (already populated for both seasons from the foundation pass — no new pipeline work needed for this route) |
| `GET` | `/echl/player-game-log?playerId=&season=` | One player's game-by-game box score rows for a season, same shape as `/ahl/player-game-log`. Added 2026-09 with the `hockeytech.js` merge |
| `GET` | `/echl/prediction?gameId=&force=` | Win probability + AI narrative — same Corsi-term omission as `/ahl/prediction` |
| `GET` | `/echl/team-seasons/compare?teamId=&seasons=` | Box-score fields only across a comma-separated `season_id` list. ECHL analog of `/ahl/team-seasons/compare` |
| `GET` | `/echl/team-seasons/compare-teams?teamIds=,&season=` | Box-score fields only for exactly two `team_id`s at one shared `season_id` |
| `GET` | `/echl/team-seasons/head-to-head?teamIds=,` | All-time head-to-head across every season on record |
| `POST` | `/echl/team-seasons/head-to-head/narrative` | AI narrative layer on the head-to-head stats above. No ECHL team-name map of its own beyond `ECHL_TEAM_CODES` — display names come from the client |
| `GET` | `/echl/news` | ECHL news feed — **only 2 sources**, not AHL's 3 (`echl.com` has no discoverable RSS feed at all — see [AHL & ECHL](#ahl--echl)) |
| `POST` | `/echl/news/ingest` | Ingest articles from GH Actions (nightly `echl_news.py`) |
| `POST` | `/echl/news/bust` | Invalidate news KV cache |
| `GET` | `/echl/today?season=` | Today's games with live status |
| `GET` | `/echl/live/:gameId` | Live PBP + normalized events. Confirmed live against a real completed game (24296, 81 events) that ECHL's PBP has the identical event shape to AHL's, including a confirmed-real `penaltyshot` type (`echl_penalty_shots.py`) |

`pollECHL` (built by `hockeytech.js`) runs from the same per-minute `scheduled()` as AHL's, with identical push-notification event coverage.

## October Season Prep

**Most of this is now automatic (2026-07)** — see [Live Season Resolution](#live-season-resolution). What's left:

- ~~`NHL_SEASON` secret → new season string~~ — no longer read anywhere in this repo
- ~~`PWHL_CURRENT_SEASON` in `pwhl.js`~~ — removed entirely; resolved live via `seasons.js`
- ~~Add PWHL expansion team IDs~~ — done 2026-07 (`PWHL_TEAM_CODES` in `pwhl.js` includes DET=10, HAM=11, LV=12, SJS=13)
- Narrative KV keys include `carAbbr` — stale keys from prior season expire naturally (24hr TTL) — still true, no change needed
- **If a future expansion wave adds a new team_id again:** add it to `pwhl.js`'s `PWHL_TEAM_CODES` map. Also worth checking the pipeline's `pwhl_stats.py`/`pwhl_salaries.py` for their own separate team-ID maps — those don't share this file's map and need the same addition independently (found the hard way in 2026-07: three separate places across two repos enumerate PWHL team IDs).
- **If live season resolution ever misjudges the real season boundary:** use the KV override documented above rather than an emergency redeploy. The real Sept/Oct 2026 transition (resolving `20262027` correctly via the schedule look-ahead, ahead of any `20262027` games being played) was directly verified live 2026-09-11 — see `nextSeasonHasImminentSchedule()` above. What's genuinely still unverified: the transition all the way through to `gamesPlayed > 0` actually landing once real regular-season games are played in late September/October, and `_getTeamStats()`'s prior-season-stats fallback (frontend) behaving correctly through that whole window — worth a deliberate check-in once real games start.
- **If a future realignment or expansion changes AHL/ECHL team IDs:** add the new id to `ahl.js`'s `AHL_TEAM_CODES` or `echl.js`'s `ECHL_TEAM_CODES` — same "multiple independent per-league team-ID maps, no shared table" situation as PWHL's bullet above, not yet hit for either league but worth remembering when it is.
- AHL's 2026-27 regular season starts 2026-10-02 (preseason 2026-09-26) — live-game tracking (`/ahl/live/:gameId`, `pollAHL`) has only been verified against completed historical games so far, never a genuine live one. Worth a deliberate check-in once the first real live game happens (see [AHL & ECHL](#ahl--echl) above).

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
