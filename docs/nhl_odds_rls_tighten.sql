-- Odds Persistence Writer -- tighten nhl_odds RLS, closing the Supabase
-- linter's "RLS Policy Always True" warnings on the INSERT/UPDATE policies
-- added in docs/nhl_odds_table.sql, without introducing a service-role
-- key into the Worker (see the conversation this came out of: a
-- service-role key would bypass RLS on every table in the project from a
-- public-facing surface -- much larger blast radius than a narrow,
-- validated policy on one low-sensitivity table).
--
-- Run this in the Supabase SQL editor.
--
-- What changed: `with check (true)` / `using (true)` allowed literally any
-- row shape. Replaced with real bounds matching what a legitimate write
-- from fetchOdds() actually looks like -- a plausible season, valid-looking
-- team abbrevs, a commence_time in the near future (this writer only ever
-- fetches upcoming games within a 7-day window), and American-odds-shaped
-- moneyline values (always magnitude >= 100 by definition). Doesn't make
-- the table bulletproof against a determined attacker holding the anon
-- key, but closes "anything at all, no validation" -- which is what the
-- linter is actually flagging.

drop policy if exists "anon can upsert nhl_odds" on public.nhl_odds;
drop policy if exists "anon can update nhl_odds" on public.nhl_odds;

create policy "anon can insert plausible nhl_odds rows" on public.nhl_odds
  for insert to anon
  with check (
    season between 20222023 and 20302031
    and home_abbr ~ '^[A-Z]{2,3}$'
    and away_abbr ~ '^[A-Z]{2,3}$'
    and home_abbr <> away_abbr
    and commence_time > now() - interval '1 day'
    and commence_time < now() + interval '30 days'
    and (moneyline_home is null or abs(moneyline_home) >= 100)
    and (moneyline_away is null or abs(moneyline_away) >= 100)
  );

create policy "anon can update plausible nhl_odds rows" on public.nhl_odds
  for update to anon
  using (
    season between 20222023 and 20302031
    and commence_time > now() - interval '1 day'
    and commence_time < now() + interval '30 days'
  )
  with check (
    season between 20222023 and 20302031
    and home_abbr ~ '^[A-Z]{2,3}$'
    and away_abbr ~ '^[A-Z]{2,3}$'
    and home_abbr <> away_abbr
    and commence_time > now() - interval '1 day'
    and commence_time < now() + interval '30 days'
    and (moneyline_home is null or abs(moneyline_home) >= 100)
    and (moneyline_away is null or abs(moneyline_away) >= 100)
  );

-- "anon can read nhl_odds" (select, using (true)) is unchanged -- the
-- linter deliberately excludes SELECT USING (true) from this warning
-- category, since public-read is often intentional (it is here).
