// src/__tests__/news-sources.test.js
// Regression coverage for the RotoWire NHL news source added 2026-09.
// A tester reported a real trade (Devils acquiring Luke Evangelista)
// missing from news -- NHL.com's own RSS feeds turned out to be dead
// (redirect to a 404 page), and RotoWire's live feed was the one
// candidate that actually carried this exact trade within hours. These
// tests pin parseRSS()'s handling of RotoWire's item shape (including its
// "Day, DD Mon YYYY H:MM:SS AM/PM ZZZ" pubDate format, which differs from
// the other sources' pubDate formats) and confirm the per-team keyword
// filter used for league-wide sources actually matches a real trade
// headline in RotoWire's terse, player-centric style.

import { describe, it, expect } from 'vitest'
import { parseRSS } from '../shared.js'

// A trimmed real snippet of RotoWire's NHL feed (2026-09-02), including the
// double-slash link artifact RotoWire's own feed emits.
const ROTOWIRE_SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>RotoWire.com Latest NHL News</title>
    <item>
        <guid>nhl593022</guid>
        <title>Jonathan Marchessault: Expected to be ready for camp</title>
        <link>https://www.rotowire.com//hockey/player/jonathan-marchessault-4047</link>
        <description>Marchessault (undisclosed) is expected to be available for training camp, Nick Kieser of Lower Broad Hockey reports Tuesday.</description>
        <pubDate>Tue, 01 Sep 2026 6:40:00 PM PDT</pubDate>
    </item>
    <item>
        <guid>nhl593021</guid>
        <title>Luke Evangelista: Flipped to New Jersey</title>
        <link>https://www.rotowire.com//hockey/player/luke-evangelista-6308</link>
        <description>Evangelista was traded to the Devils from the Predators on Tuesday in exchange for a conditional first-round pick and a second-round pick.</description>
        <pubDate>Tue, 01 Sep 2026 5:12:00 PM PDT</pubDate>
    </item>
  </channel>
</rss>`

describe('parseRSS: RotoWire source', () => {
  it('parses title/link/date for RotoWire\'s item shape, unfiltered', () => {
    const items = parseRSS(ROTOWIRE_SAMPLE_XML, { id: 'rotowire' })
    expect(items).toHaveLength(2)
    expect(items[0].title).toBe('Jonathan Marchessault: Expected to be ready for camp')
    expect(items[0].url).toBe('https://www.rotowire.com//hockey/player/jonathan-marchessault-4047')
    expect(items[0].publishedAt).toBe(new Date('Tue, 01 Sep 2026 6:40:00 PM PDT').toISOString())
  })

  it('the NJD team filter matches the real Evangelista trade headline, and skips unrelated items', () => {
    const njdFilter = 'devils|new jersey|hischier|hughes|vanecek' // TEAM_CONFIGS.NJD.keywords, joined
    const items = parseRSS(ROTOWIRE_SAMPLE_XML, { id: 'rotowire', filter: njdFilter })
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('Luke Evangelista: Flipped to New Jersey')
  })

  it('the NSH team filter also matches via the description mentioning the Predators', () => {
    const nshFilter = 'predators|nashville' // subset of TEAM_CONFIGS.NSH.keywords
    const items = parseRSS(ROTOWIRE_SAMPLE_XML, { id: 'rotowire', filter: nshFilter })
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('Luke Evangelista: Flipped to New Jersey')
  })
})
