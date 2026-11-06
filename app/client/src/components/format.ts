/** "0.31 s", "4.2 s", "18 s": two significant figures, enough to compare scenes by. */
export function formatSeconds(t: number): string {
  if (t < 1) return `${t.toFixed(2)} s`;
  if (t < 10) return `${t.toFixed(1)} s`;
  return `${Math.round(t)} s`;
}
