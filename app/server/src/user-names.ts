/**
 * The short form of a user identity, as the dashboards show it.
 *
 * Kubernetes fixes a ServiceAccount's username as `system:serviceaccount:<ns>:<name>`,
 * which for the demo tiers reads `system:serviceaccount:maas-tier-free:user1`. The chart's
 * TelemetryPolicy writes `free:user1` into the metrics instead (the same rule, in CEL), so
 * RHOAI's own dashboard and this one agree with the traffic view. Series recorded before
 * that change still carry the long form in Prometheus; folding them here keeps every time
 * window in one spelling. Anything else (`admin`, an OIDC user) is left as it is.
 */
const TIER_SA_PREFIX = 'system:serviceaccount:maas-tier-';

export function shortUserName(user: string): string {
  return user.startsWith(TIER_SA_PREFIX) && user.length > TIER_SA_PREFIX.length
    ? user.slice(TIER_SA_PREFIX.length)
    : user;
}
