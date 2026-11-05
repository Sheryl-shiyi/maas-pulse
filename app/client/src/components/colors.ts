/**
 * Colours for users, by subscription tier: one hue family per tier, a shade per member.
 *
 * Users used to get a fixed palette that included green, orange and red, the colours the
 * topology also uses for state (healthy, provider limit, refused). pro:user4's red dots
 * read as errors. Tier hues avoid all three, so a particle says which tier sent it and
 * red, amber and green keep one meaning each.
 */
const TIER_PALETTES: Record<string, string[]> = {
  free: ['#2dd4bf', '#5eead4', '#14b8a6'], // teal
  pro: ['#60a5fa', '#93c5fd', '#3b82f6'], // blue
  max: ['#a78bfa', '#c4b5fd', '#8b5cf6'], // violet
};

/** For tiers other deployments may name differently, in order of appearance. */
const FALLBACK_PALETTES = [
  ['#22d3ee', '#67e8f9', '#06b6d4'], // cyan
  ['#f472b6', '#f9a8d4', '#ec4899'], // pink
  ['#818cf8', '#a5b4fc', '#6366f1'], // indigo
];

/** Users with no tier (the admin): neutral, outside the tier families. */
const NO_TIER = '#e2e8f0';

export function userColors(users: { tier?: string }[]): string[] {
  const tierOrder: string[] = [];
  const seenInTier = new Map<string, number>();
  return users.map(u => {
    const tier = (u.tier || '').toLowerCase();
    if (!tier) return NO_TIER;
    if (!tierOrder.includes(tier)) tierOrder.push(tier);
    const palette = TIER_PALETTES[tier]
      ?? FALLBACK_PALETTES[tierOrder.filter(t => !TIER_PALETTES[t]).indexOf(tier) % FALLBACK_PALETTES.length]!;
    const n = seenInTier.get(tier) ?? 0;
    seenInTier.set(tier, n + 1);
    return palette[n % palette.length]!;
  });
}
