/**
 * Colours for users, by subscription tier: one hue family per tier, a shade per member.
 *
 * Users used to get a fixed palette that included green, orange and red, the colours the
 * topology also uses for state (healthy, provider limit, refused). pro:user4's red dots
 * read as errors. Tier hues avoid all three, so a particle says which tier sent it and
 * red, amber and green keep one meaning each. All hues are from the Red Hat palette.
 */
const TIER_PALETTES: Record<string, string[]> = {
  free: ['#63bdbd', '#9ad8d8', '#37a3a3'], // Red Hat teal
  pro: ['#4394e5', '#92c5f9', '#2b9af3'], // Red Hat blue
  max: ['#876fd4', '#b6a6e9', '#d0c5f4'], // Red Hat purple
};

/** For tiers other deployments may name differently, in order of appearance. */
const FALLBACK_PALETTES = [
  ['#ffcc17', '#ffe072', '#dca614'], // Red Hat yellow
  ['#f8ae54', '#fccb8f', '#f5921b'], // Red Hat orange
  ['#e0e0e0', '#d2d2d2', '#c7c7c7'], // silver
];

/** Users with no tier (the admin): neutral, outside the tier families. */
const NO_TIER = '#e0e0e0';

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
