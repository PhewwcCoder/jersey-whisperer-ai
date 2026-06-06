import type { Product } from './types'

export type NewsEventType =
  | 'transfer'
  | 'trophy'
  | 'wc_final'
  | 'kit_release'
  | 'retirement'
  | 'performance'

export type Tier = 'most' | 'mid' | 'low'

export interface NewsEvent {
  id: string
  type: NewsEventType
  player: string | null
  team: string
  secondary_team: string | null
  event_date: string   // ISO timestamptz from Supabase
  tier: Tier
  base_m: number
  source: string
  geo: string
  context?: string | null // DISPLAY-ONLY AI demand color; never used in scoring
}

export const TIER_LISTS = {
  players: {
    most: ['Lionel Messi', 'Cristiano Ronaldo', 'Neymar Jr', 'Kylian Mbappe', 'Erling Haaland', 'Jude Bellingham', 'Vinicius Junior', 'Lamine Yamal', 'Mohamed Salah', 'Robert Lewandowski'],
    mid:  ['Harry Kane', 'Kevin De Bruyne', 'Bruno Fernandes', 'Bukayo Saka', 'Phil Foden', 'Pedri', 'Gavi', 'Jamal Musiala', 'Rodrygo', 'Lautaro Martinez', 'Cole Palmer', 'Antoine Griezmann', 'Luka Modric', 'Angel Di Maria'],
    low:  ['Florian Wirtz', 'Julian Alvarez', 'Arda Guler', 'Achraf Hakimi', 'Toni Kroos', 'Sergio Ramos'],
  },
  clubs: {
    most: ['Real Madrid', 'Barcelona', 'Manchester United', 'Manchester City', 'Liverpool', 'Arsenal', 'Bayern Munich', 'Paris Saint-Germain', 'Inter Miami', 'Al Nassr'],
    mid:  ['Chelsea', 'Tottenham Hotspur', 'Borussia Dortmund', 'Inter Milan', 'AC Milan', 'Juventus', 'Atletico Madrid', 'Al Hilal', 'Napoli', 'Bayer Leverkusen'],
    low:  ['Santos', 'Ajax', 'Benfica', 'Roma', 'Newcastle United'],
  },
  national: {
    most: ['Argentina', 'Brazil', 'Portugal', 'France', 'Germany', 'Spain', 'England', 'Italy', 'Netherlands', 'Belgium', 'Bangladesh'],
    mid:  ['Croatia', 'Uruguay', 'Japan', 'South Korea', 'Mexico', 'Egypt', 'Norway'],
    low:  ['Saudi Arabia', 'Denmark'],
  },
}

// Player → national team, for transfer routing (team = national jersey boost,
// secondary_team = destination club). Keys are the EXACT tier-list player names so
// resolveKnownPlayer's canonical name looks up cleanly. Every player above is mapped.
export const NATIONAL_TEAM_MAP: Record<string, string> = {
  'Lionel Messi': 'Argentina', 'Cristiano Ronaldo': 'Portugal', 'Neymar Jr': 'Brazil',
  'Kylian Mbappe': 'France', 'Erling Haaland': 'Norway', 'Jude Bellingham': 'England',
  'Vinicius Junior': 'Brazil', 'Lamine Yamal': 'Spain', 'Mohamed Salah': 'Egypt',
  'Robert Lewandowski': 'Poland', 'Harry Kane': 'England', 'Kevin De Bruyne': 'Belgium',
  'Bruno Fernandes': 'Portugal', 'Bukayo Saka': 'England', 'Phil Foden': 'England',
  Pedri: 'Spain', Gavi: 'Spain', 'Jamal Musiala': 'Germany', Rodrygo: 'Brazil',
  'Lautaro Martinez': 'Argentina', 'Cole Palmer': 'England', 'Antoine Griezmann': 'France',
  'Luka Modric': 'Croatia', 'Angel Di Maria': 'Argentina', 'Florian Wirtz': 'Germany',
  'Julian Alvarez': 'Argentina', 'Arda Guler': 'Turkey', 'Achraf Hakimi': 'Morocco',
  'Toni Kroos': 'Germany', 'Sergio Ramos': 'Spain',
}

const TIER_WEIGHT: Record<Tier, number> = { most: 1.0, mid: 0.7, low: 0.4 }

const LAMBDA: Record<NewsEventType, number> = {
  transfer:    Math.LN2 / 7,
  trophy:      Math.LN2 / 7,
  wc_final:    Math.LN2 / 7,
  kit_release: Math.LN2 / 7,
  retirement:  Math.LN2 / 30,
  performance: Math.LN2 / 7,
}

// Flattened tier entries (players + clubs + national), longest-name-first so the
// most specific entry wins and generic shared tokens don't cause false matches.
interface TierEntry { lower: string; tokens: string[]; tier: Tier }
const ALL_TIER_ENTRIES: TierEntry[] = (() => {
  const out: TierEntry[] = []
  for (const category of ['players', 'clubs', 'national'] as const) {
    for (const tier of ['most', 'mid', 'low'] as const) {
      for (const name of TIER_LISTS[category][tier]) {
        const lower = name.toLowerCase()
        out.push({ lower, tokens: lower.split(/\s+/).filter(t => t.length > 3), tier })
      }
    }
  }
  return out.sort((a, b) => b.lower.length - a.lower.length)
})()

// resolveTier: case-insensitive loose matching so full names from the news
// ("Erling Haaland", "Lionel Messi", "Kylian Mbappé") resolve to the same tier as
// their short list entries ("Haaland", "Messi", "Mbappe") instead of falling through
// to 'low'. Uses the SAME loose matching the transfer player-gate uses (substring
// both ways) plus longest-name-first ordering, in priority passes:
//   1. exact match
//   2. substring either way (handles "Erling Haaland"⊃"Haaland", "Barca"⊂"Barcelona")
//   3. token-subset: every significant (>3-char) token of the shorter name appears in
//      the longer (handles "Man City" ↔ "Manchester City"), while NOT matching on a
//      single shared generic token (so "Real Sociedad" ≠ "Real Madrid").
// Tier weights, the magnitude rubric, and decay math are unchanged.
export function resolveTier(name: string): Tier {
  const n = (name ?? '').trim().toLowerCase()
  if (!n) return 'low'

  // Pass 1 — exact.
  for (const e of ALL_TIER_ENTRIES) if (e.lower === n) return e.tier

  // Pass 2 — substring either way (transfer player-gate parity), longest entry first.
  for (const e of ALL_TIER_ENTRIES) {
    if (n.includes(e.lower) || e.lower.includes(n)) return e.tier
  }

  // Pass 3 — token-subset: all >3-char tokens of the shorter name present in the
  // longer (>=1 token). Avoids single-shared-token false positives like "Real".
  const nTokens = n.split(/\s+/).filter(t => t.length > 3)
  for (const e of ALL_TIER_ENTRIES) {
    if (!e.tokens.length || !nTokens.length) continue
    const [shorter, longer] =
      n.length <= e.lower.length ? [nTokens, e.tokens] : [e.tokens, nTokens]
    if (shorter.every(t => longer.includes(t))) return e.tier
  }

  return 'low'
}

// isKnownEntity: true iff `name` resolves to ANY tier-list entry (players + clubs +
// national teams) via the SAME loose matching resolveTier uses. resolveTier can't answer
// this on its own because it returns 'low' both for genuinely-low entries AND for names
// not in any list. This predicate is used by the all-event relevance gate to drop events
// whose team/player/secondary all fall outside the curated fan-favorite lists.
export function isKnownEntity(name: string | null | undefined): boolean {
  const n = (name ?? '').trim().toLowerCase()
  if (!n) return false

  // Pass 1 — exact.
  for (const e of ALL_TIER_ENTRIES) if (e.lower === n) return true
  // Pass 2 — substring either way.
  for (const e of ALL_TIER_ENTRIES) if (n.includes(e.lower) || e.lower.includes(n)) return true
  // Pass 3 — token-subset (>3-char tokens of the shorter name all present in the longer).
  const nTokens = n.split(/\s+/).filter(t => t.length > 3)
  for (const e of ALL_TIER_ENTRIES) {
    if (!e.tokens.length || !nTokens.length) continue
    const [shorter, longer] =
      n.length <= e.lower.length ? [nTokens, e.tokens] : [e.tokens, nTokens]
    if (shorter.every(t => longer.includes(t))) return true
  }
  return false
}

// trendMedian is reserved for future tier-promotion logic. Currently unused (conservative).
export function computeNewsScore(
  product: Product,
  events: NewsEvent[],
  _trendMedian?: number,
): number {
  let rawN = 0

  for (const event of events) {
    const dtDays = (Date.now() - new Date(event.event_date).getTime()) / 86400000
    if (!Number.isFinite(dtDays) || dtDays > 60) continue

    const productText = `${product.team_country_club} ${product.player_name ?? ''} ${product.font_name ?? ''}`.toLowerCase()
    const productTeam = product.team_country_club.toLowerCase()
    const eventTeam = event.team.toLowerCase()
    const eventSecondary = (event.secondary_team ?? '').toLowerCase()
    const eventPlayer = (event.player ?? '').toLowerCase()

    const teamMatch = productTeam === eventTeam || (eventSecondary.length > 0 && productTeam === eventSecondary)
    const playerMatch = eventPlayer.length > 0 && productText.includes(eventPlayer)

    if (!teamMatch && !playerMatch) continue

    let effectiveBaseM = event.base_m
    if (event.type === 'performance') {
      // team-jersey boost vs. name-print boost have different magnitudes
      effectiveBaseM = (teamMatch && !playerMatch) ? 0.1 : 0.4
    }

    const contribution = effectiveBaseM * TIER_WEIGHT[event.tier] * Math.exp(-LAMBDA[event.type] * dtDays)
    if (Number.isFinite(contribution)) rawN += contribution
  }

  return Math.min(rawN, 1)
}
