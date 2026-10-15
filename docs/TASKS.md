# maas-pulse task list

Single source of truth for open work. Updated and printed every turn.
Last updated: 2026-10-15

Status key: `[ ]` todo · `[~]` in progress · `[?]` blocked on a decision · `[x]` done

---

## In flight

- [x] **T1 · UI moved into the `maas-pulse` namespace, live-feed fixes deployed** —
  rev 39. Pod running, URL unchanged, `default` left clean, 6/6 keys picked up.
  Two regressions surfaced by the move, below.

- [x] **T16 · OIDC tab restored, and the resources are now Helm-managed** — adopted the
  five out-of-band OIDC resources (annotate + label), then upgraded with
  `oidc.enabled=true`; rev 40 logs `[oidc] configured`. The saved values snapshot was
  refreshed so a later upgrade cannot silently switch it off again. This also closes the
  long-standing gap where OIDC lived outside Helm.


- [~] **T17 · Subscription tiers (Free / Pro / Max + admin)** — the user wants changing
  one group's limit in the Dashboard to visibly move a whole cohort, with the UI showing
  who belongs to which tier. Verified mechanics: OCP groups are **synced from the
  Keycloak `sso` realm at login**, so a realm change does not take effect until each
  user logs in again.
  **Coupled to T2 and must be decided together.** If identities become ServiceAccounts,
  one namespace per tier is the clean design: the tier is then the built-in group
  `system:serviceaccounts:<tier-ns>`, membership is "which namespace the SA lives in",
  no Keycloak round trip, no empty-group hack, and it all fits in the chart.
  Suggested ladder: Free 1k/min (user4-5), Pro 10k (user2-3), Max 50k (user1),
  admin 100k. Free must throttle within seconds for the demo to land.

- [~] **T2 · Replace API keys with ServiceAccount identities** — decided 2026-10-15:
  option (b). SA tokens never expire out from under us and need no manual minting;
  `kubernetesTokenReview` is enabled on every AuthConfig, so the gateway accepts them
  directly. Three dead keys (`user1`, `user2`, `user5`) are the trigger.
  **Prototype written**: `docs/reference/sa-identity-prototype.yaml` — one user only
  (`demo-user1`), server-side dry-run passes. Both CRs accept `users: [string]`, so the
  SA username form works.
  **Applied and verified on-cluster 2026-10-15** — the technical path works end to end:
  the SA token authenticates (HTTP 200, no API key anywhere), the AuthPolicy correctly
  scopes the catalogue to the two granted models, and Prometheus attributes the calls to
  `subscription="demo-user1"`, so the right quota is in force.
  **Found**: the `user` label becomes the full SA username,
  `system:serviceaccount:models-as-a-service:demo-user1` — too long for the chargeback
  table and the topology node. A SA → display-name mapping is therefore **mandatory**,
  not optional, if all six users convert. Budget it.
  **Dashboard question answered 2026-10-15 — it works.** The Dashboard lists the
  SA-owned subscription, edits its token limit, and the edit reaches the cluster
  (nemotron 6000 → 1000). Saving does **not** wipe `owner.users`.
  **One real limitation**: `Groups` is a required field in the edit form, so the
  Dashboard cannot save a users-only subscription. The test run added the `user` group
  to get past it, which made our subscription-watcher report demo-user1 as a `user`
  group tier and misreport user1-5's nemotron limit as 1k in the UI (the gateway still
  enforced 6k — only the display was wrong). Empirically the group addition did **not**
  move user1-5 onto the demo subscription; only the SA is charged to it.
  The Dashboard also warns that authorization policies are not updated automatically,
  so editing a limit is fine but changing the model list needs a second manual step.
  **Next**: decide API keys vs ServiceAccounts, which determines T17's shape.

## Ready to apply (prepared, needs the user to run it)

- [ ] **T3 · Taint the GPU MachineSets** — `docs/reference/gpu-machineset-taint.yaml`.
  Only affects machines created afterwards, so the next GPU rebuild picks it up.
- [ ] **T4 · Push commit `d22eb8d`** (live-feed error reporting).

## Agreed, not yet written

- [ ] **T5 · Fix the autoscaler signal** — scale on `vllm:num_requests_waiting` and
  `vllm:kv_cache_usage_perc`; drop `num_requests_running`, which is batching
  concurrency, not back-pressure. Thresholds to match WVA: `waiting > 5`, `kv > 80%`.
  Keep the old behaviour behind `autoscaling.signal: legacy` so the "wrong signal vs
  right signal" comparison can be demoed. Expect scale-up to become harder to trigger —
  that is the point, and it pairs with T6.
- [ ] **T6 · A "unique long prefix" traffic pattern** — forces cache misses so routing
  and scaling behaviour become visible. Prerequisite for demoing T5 honestly.

## Backlog

- [ ] **T7 · Per-replica cache-hit colouring** on the topology canvas
  (`vllm:prefix_cache_hits_total / _queries_total` by pod). Metrics verified present.
- [ ] **T8 · Overlay the EPP's own view** (`inference_pool_per_pod_queue_size`).
- [ ] **T9 · Limitador has no persistence** — the chargeback "all" view loses history
  whenever Limitador restarts. Either add Redis or switch the query to `increase()`.
- [ ] **T10 · RHCL 1.3.4 → 1.4.3** — we pin `startingCSV`; the channel head is 1.4.3 and
  the maas-guide says 1.3.x is outside the support matrix. Verify that claim first.
- [ ] **T11 · Release rename** `maas-code-assistant` → `maas-pulse`. Needs
  uninstall/reinstall; see the operations log for what that destroys (Keycloak and OCP
  console login, monitoring ConfigMaps, and the unowned OIDC resources that will block
  a reinstall). Deferred deliberately.
- [ ] **T12 · GPU start/stop skill** — "finish for the day" releases the GPUs, "start"
  adds them back. Design not started. Note `oc scale` is a cluster mutation and hits the
  permission wall, so the skill has to end by handing over a command.
- [ ] **T13 · Delete the stale `maas-api-key-cleanup` CronJob** in
  `redhat-ods-applications` (a 3.4 leftover that fails every 15 minutes).
- [ ] **T14 · Decide whether `docs/research/` should be tracked in git** — currently
  gitignored, so the two research write-ups live only on this machine.

## Waiting on the user

- [ ] **T15 · The user's own unbuilt demo feature ideas.** Raised on 2026-10-13 and not
  yet described. These take priority over everything in the backlog once stated.

---

## Done on 2026-10-15

- [x] Verified the GPU restore: 3 machines Running, 4 models serving, UI and chargeback
      healthy, EPP scorer profile survived (EPP pods are CPU-only, never destroyed)
- [x] Found all three GPU nodes now have no taint, confirming it was applied by hand and
      is lost on every rebuild → T3
- [x] Built and pushed the amd64 image containing the live-feed fixes

## Done on 2026-10-13

- [x] Removed two manual secret steps (Prometheus SA token, API key secret)
- [x] Extracted model-name normalization, 18 tests, CI green on first run
- [x] RHOAI 3.5.0 → 3.5.1, Helm rev 36 → 38
- [x] Pinned the EPP scheduling profile in the chart
- [x] Disproved the long-standing "gateway does not load-balance to new replicas" issue
      and found the real defect in our own autoscaler → T5
- [x] Replaced the git hook so it blocks Claude attribution rather than every commit
