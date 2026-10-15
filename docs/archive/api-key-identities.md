# Archived: MaaS API keys as the demo identities

Superseded on 2026-10-15 by ServiceAccount identities. **Nothing was deleted** — the code
path is still present and still works, so going back is a values change, not a rewrite.
This note records how it worked, why we left, and how to return.

## How it worked

Six users, each holding a MaaS API key (`sk-oai-…`) issued by hand from the RHOAI
dashboard's Gen AI Studio:

```
user_keys.json            gitignored, the local source of truth
  ↓ all-in-one.sh reads it, or you pass --set
trafficUI.apiKeys         chart creates Secret maas-pulse-ui-apikeys
  ↓ or trafficUI.apiKeysSecret to point at a Secret you manage
USER_API_KEYS             env var on the UI pod, positional against USER_NAMES
  ↓
one OpenAI client per user, constructed with that key as a static bearer
```

Authorization was by Kubernetes group: the users belonged to the OCP groups `admin` and
`user`, synced from the Keycloak `sso` realm at login, and `MaaSSubscription` /
`MaaSAuthPolicy` owned those groups.

## Why we moved away

**Keys expire or vanish and you cannot find out why.** On 2026-10-15 three of the six
keys (`user1`, `user2`, `user5`) started returning 403 at the gateway while the other
three kept working. Everything that could be checked was checked: the subscription was
Active and covered the models, the group membership was unchanged, it was not rate
limiting, the 90-day `API_KEY_MAX_EXPIRATION_DAYS` ceiling was far off, and the
`maas-api-key-cleanup` CronJob reported deleting zero keys. Keys live in Postgres with no
auditable Kubernetes object, so the cause was not recoverable. They simply stopped.

**Issuing a key cannot be scripted.** It needs a bearer token for the user, and
`oc login -u/-p` does not work because the OCP identity provider is RHBK — OIDC providers
have no password grant. So every rebuild of the demo needed someone to click through the
dashboard six times. That sits badly with a project whose point is one-command deploy.

**Group membership is awkward to change.** Groups come from the Keycloak realm and sync
into OpenShift at login, so re-tiering a user means editing the realm import and having
that user log in again.

## What replaced it

ServiceAccount tokens, minted on demand through the Kubernetes TokenRequest API. The
gateway accepts them because every AuthConfig enables the `openshift-identities` method
backed by `kubernetesTokenReview`. One namespace per subscription tier, so the tier is
the built-in group `system:serviceaccounts:<namespace>` and moving a user between tiers
is moving which namespace its ServiceAccount lives in.

See `charts/maas-pulse/templates/tier-identities.yaml` and
`app/server/src/sa-token.ts`.

## How to go back

Both paths are still in the code and can run side by side — `admin` still used an API key
when this was written, while the nine tier users used ServiceAccounts.

To put a user back on an API key, clear its slot in `trafficUI.userServiceAccounts` and
put the key in the matching slot of `trafficUI.apiKeys` (or point
`trafficUI.apiKeysSecret` at a Secret you manage). The lists are positional against
`trafficUI.userNames`, so keep them the same length.

To go back entirely, clear `userServiceAccounts`, restore the `admin` and `user`
subscriptions as the only ones with members, and remove the `serviceAccountNamespace` and
`serviceAccounts` fields from the tier entries under `subscriptions`. The server falls
back to the API key path for any user with no ServiceAccount.

## Loose ends from the migration

- `user_keys.json` still exists locally and is still gitignored. Three of its six keys
  are dead. Nothing reads it unless `all-in-one.sh` is run.
- The one-user prototype that proved the approach,
  `docs/reference/sa-identity-prototype.yaml`, is superseded by the chart. Its cluster
  resources (`demo-user1` ServiceAccount, subscription and auth policy in
  `models-as-a-service`) should be deleted once the chart's tiers are live:
  `oc delete -f docs/reference/sa-identity-prototype.yaml`
- The old `user` subscription and its OCP group are kept for now so the migration can be
  rolled back. Remove them once the tiers have been demoed successfully.
