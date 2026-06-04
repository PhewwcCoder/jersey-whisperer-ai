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
}

export const TIER_LISTS = {
  players: {
    most: ['Messi', 'Ronaldo', 'Neymar', 'Mbappé', 'Mbappe', 'Haaland', 'Bellingham', 'Vinicius', 'Vinicius Junior', 'Lamine Yamal', 'Salah', 'Lewandowski'],
    mid:  ['Kane', 'De Bruyne', 'Bruno Fernandes', 'Saka', 'Foden', 'Pedri', 'Gavi', 'Musiala', 'Rodrygo', 'Lautaro', 'Lautaro Martinez', 'Palmer', 'Griezmann', 'Modric', 'Di Maria', 'Di María'],
    low:  ['Wirtz', 'Alvarez', 'Julian Alvarez', 'Güler', 'Guler', 'Hakimi', 'Kroos', 'Ramos'],
  },
  clubs: {
    most: ['Real Madrid', 'Barcelona', 'Manchester United', 'Manchester City', 'Liverpool', 'Arsenal', 'Bayern Munich', 'PSG', 'Paris Saint-Germain', 'Inter Miami', 'Al Nassr'],
    mid:  ['Chelsea', 'Tottenham', 'Dortmund', 'Borussia Dortmund', 'Inter Milan', 'AC Milan', 'Juventus', 'Atletico Madrid', 'Atlético Madrid', 'Al Hilal', 'Napoli', 'Leverkusen', 'Bayer Leverkusen'],
    low:  ['Santos', 'Ajax', 'Benfica', 'Roma', 'Newcastle'],
  },
  national: {
    most: ['Argentina', 'Brazil', 'Portugal', 'France', 'Germany', 'Spain', 'England', 'Italy', 'Netherlands', 'Belgium', 'Bangladesh'],
    mid:  ['Croatia', 'Uruguay', 'Japan', 'South Korea', 'Mexico', 'Egypt', 'Norway'],
    low:  ['Saudi Arabia', 'Denmark'],
  },
}

export const NATIONAL_TEAM_MAP: Record<string, string> = {
  Messi: 'Argentina', Ronaldo: 'Portugal', Neymar: 'Brazil',
  'Mbappé': 'France', Mbappe: 'France', Haaland: 'Norway',
  Bellingham: 'England', Vinicius: 'Brazil', 'Vinicius Junior': 'Brazil',
  'Lamine Yamal': 'Spain', Salah: 'Egypt', Lewandowski: 'Poland',
  Kane: 'England', 'De Bruyne': 'Belgium', 'Bruno Fernandes': 'Portugal',
  Saka: 'England', Foden: 'England', Pedri: 'Spain', Gavi: 'Spain',
  Musiala: 'Germany', Rodrygo: 'Brazil', 'Lautaro Martinez': 'Argentina',
  Palmer: 'England', Griezmann: 'France', Modric: 'Croatia',
  'Di María': 'Argentina', 'Di Maria': 'Argentina',
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

export function resolveTier(name: string): Tier {
  const n = name.toLowerCase()
  for (const category of ['players', 'clubs', 'national'] as const) {
    if (TIER_LISTS[category].most.some(x => x.toLowerCase() === n)) return 'most'
    if (TIER_LISTS[category].mid.some(x => x.toLowerCase() === n)) return 'mid'
    if (TIER_LISTS[category].low.some(x => x.toLowerCase() === n)) return 'low'
  }
  return 'low'
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
