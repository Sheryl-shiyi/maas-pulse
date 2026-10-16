# maas-pulse task list

Single source of truth for open work. Updated and printed every turn.
Last updated: 2026-10-15

Status key: `[ ]` todo · `[~]` in progress · `[?]` blocked on a decision · `[x]` done

---

## Open

- [ ] **T18 · `Premature close` on external models.** Seen in the live feed during the
  user's manual test, against `gpt-4.1-nano`, affecting several identities at once.
  Could not be reproduced afterwards: 5 sequential and 12 concurrent calls all returned
  200, and Gemini was fine. It is a connection-layer failure (the upstream closed before
  the body finished), unrelated to the 401/500 auth noise. Suggested fix is one
  automatic retry for external models, since this class of error is retryable and an
  audience should never see it.

- [ ] **T21 · Does the A10G / FP8 warning actually matter for us?** Other Red Hat MaaS
  material says not to run FP8 on `g5` / A10G. A10G is Ampere at compute capability 8.6
  so it clears the stated >= 8.0 bar, and `qwen3-8b-fp8` has run on it throughout — but
  it has no *native* FP8 hardware, so vLLM falls back to Marlin kernels. Worth measuring
  what that costs in throughput and latency, and deciding whether the demo should move
  Qwen3 to an Ada or Hopper instance. Benchmark before changing anything; the current
  setup works.

- [ ] **T22 · A GPU-free path, modelled on rhoai-maas-guide.** They ship two models that
  need no GPU: `ghcr.io/llm-d/llm-d-inference-sim` and CPU vLLM
  (`registry.redhat.io/rhaiis/vllm-cpu-rhel9` with `VLLM_CPU_KVCACHE_SPACE=4`). We
  require an L40S *and* an A10G, so nobody can try this project without both. That is
  the single biggest barrier to anyone else using it.

- [ ] **T9 · Limitador has no persistence.** The chargeback "all" view loses history
  whenever Limitador restarts. Either add Redis or switch the query to `increase()`.

- [ ] **T10 · RHCL 1.3.4 → 1.4.3.** We pin `startingCSV`; the channel head is 1.4.3 and
  the maas-guide claims 1.3.x is outside the support matrix. Verify that claim first.

- [ ] **T11 · Release rename** `maas-code-assistant` → `maas-pulse`. Needs
  uninstall/reinstall. The operations log records what that destroys — Keycloak and
  OCP console login, the monitoring ConfigMaps — and the user has deliberately deferred
  it. Note the UI itself no longer lives in `default`; what remains there is the Helm
  release record and cluster-scoped objects.

- [ ] **T12 · GPU start/stop skill.** "Finish for the day" releases the GPUs, "start"
  adds them back. Not designed. `oc scale` now passes the permission classifier, so a
  skill could run it directly.

- [ ] **T13 · Delete the stale `maas-api-key-cleanup` CronJob** in
  `redhat-ods-applications`, a 3.4 leftover that fails every 15 minutes.

- [ ] **T14 · Decide whether `docs/research/` should be tracked in git.** Currently
  gitignored, so the two research write-ups live only on this machine.

- [ ] **T19 · Clean up the SA prototype resources.** `demo-user1` (ServiceAccount,
  subscription, auth policy in `models-as-a-service`) is superseded by the chart's
  tiers. `oc delete -f docs/reference/sa-identity-prototype.yaml`. Its subscription also
  still carries the `user` group added during the dashboard test, which makes the
  subscription-watcher report it as a `user` tier.

- [ ] **T20 · Retire the old `admin` and `user` subscriptions** once the tiers have been
  demoed successfully. Kept for now so the migration can be rolled back.

- [ ] **T23 · Where should skill assets live? Decide after the project, not now.** The
  `gpu-session` skill sits at `.claude/skills/gpu-session/SKILL.md`, which is gitignored,
  so it exists only on this machine — lost on a new laptop and invisible to anyone who
  clones the repo. The user has deliberately chosen not to put it in this project. The
  open question is the general one: where do skills that encode a project's operational
  knowledge belong, given that `.claude/` is personal config and the repo is a
  deliverable. Revisit once the project wraps up.

## Waiting on the user

- [ ] **T15 · The user's own unbuilt demo feature ideas.** Raised 2026-10-13, still not
  described. These take priority over everything above once stated.

- [?] **Should the "wrong signal vs right signal" comparison live in code?** I proposed a
  toggle that keeps the old pressure signal for a side-by-side demo, then did not build
  it: it would mean two threshold paths maintained forever for one demo beat. The same
  story can be told from the measured numbers. The user has not weighed in.

---

## Done 2026-10-16

- [x] **T6 · Long-prompt shapes, and the rate that actually works.** `short`,
  `shared-prefix` and `unique-prefix`, on an axis separate from the traffic pattern.
  Measured on one A10G: 1500 tokens at **1/s** is the demo setting — KV crosses 80% at
  ~40s, the queue climbs 0 → 8 → 25 and autoscaling fires for a real reason. 2/s reaches
  343 and runs away; 4/s with 4000 tokens reaches 461 and everything times out. The
  constraint is token throughput but not linearly: 750 tokens at 2/s moves the same
  tokens and queues four times deeper, so length cannot be traded for frequency.
  Documented as two demo segments in the README, because rate limiting and autoscaling
  need opposite request sizes.
- [x] **Authorino scaled to three replicas**, which removed the ServiceAccount
  TokenReview bottleneck completely (4/s went from ~30% rejected to zero; 8/s from ~52%
  to zero) and let the generator's ceiling go back to 10/s. Captured in the chart as a
  post-install hook since Kuadrant owns the CR and exposes no setting for it.
- [x] **Max tier raised to 800k tokens/min** so long-context runs are not throttled by
  the tier whose purpose is not to throttle.
- [x] **Live feed wording for 401/403** no longer claims an API key is invalid.

- [x] **T3 · GPU taint moved into both MachineSet templates.** It used to be applied by
  hand to running nodes and was therefore lost on every rebuild — on 2026-10-15 all
  three nodes came back with none. Patched before scaling up, so this restore is itself
  the acceptance test.
- [x] **T12 · `gpu-session` skill**, project-level at
  `.claude/skills/gpu-session/SKILL.md`. Ends a session by scaling both MachineSets to
  0; starts one by resetting Qwen3 to 1 replica *first*, scaling up, then handing the
  15-50 minute wait to a subagent so the main thread keeps working. It **verifies** the
  taint rather than reapplying it, so a MachineSet regression surfaces instead of being
  papered over.
- [x] **README hardware section** — both GPU types mandatory and why, the A10G/FP8
  warning and why we disagree with it, the taint and toleration contract, first-start
  timings, and the absence of a GPU-free path as a stated gap.

## Done 2026-10-15

- [x] **T5 · Pressure signal corrected, colours and scaling together.** Both now use
  queued requests and KV cache, never `vllm:num_requests_running`, which counts the
  current continuous batch rather than a backlog. Thresholds match RHOAI's own WVA
  defaults (queue 5, KV 80%). Model nodes now show `R:` and `Q:` separately instead of
  one conflated `Q:`. Verified: 90s at 3/s with 24 running and 0 queued produced no
  scale-up, where the old signal would have provisioned a second GPU immediately.
  7 tests added (18 → 25), one of which encodes the exact measurement that exposed the
  bug.
- [x] **T2 / T17 · ServiceAccount identities and subscription tiers.** Nine users across
  Free (1k/min), Pro (10k) and Max (50k), one namespace per tier so the tier is the
  built-in group `system:serviceaccounts:<ns>`; admin stays on an API key at 100k.
  Tokens are minted through the TokenRequest API and cached. Verified end to end,
  including a live limit change from the RHOAI dashboard taking effect immediately.
  Traffic is capped at 4/s because validating a SA token costs a TokenReview per
  request: 0% failures at 2/s, ~30% at 4/s, ~52% at 8/s, while the API-key identity
  never failed. Rate limiting still appears within 16s at 3/s.
- [x] **T1 · UI moved to the `maas-pulse` namespace**, with the console Topology labels,
  plus the live-feed fixes deployed.
- [x] **T16 · OIDC tab restored and now Helm-managed** — the five out-of-band OIDC
  resources were adopted, closing a gap that had been open since the feature shipped.
- [x] **T4 · Commits pushed.**
- [x] Verified the GPU restore after the break; found all three GPU nodes come back
  without the taint, which is what T3 fixes.

## Done 2026-10-13

- [x] Removed two manual secret steps (Prometheus SA token, API key secret)
- [x] Extracted model-name normalization, 18 tests, CI green on first run
- [x] RHOAI 3.5.0 → 3.5.1, Helm rev 36 → 38
- [x] Pinned the EPP scheduling profile in the chart
- [x] Disproved the "gateway does not load-balance to new replicas" issue and found the
      real defect in our own autoscaler, which became T5
- [x] Replaced the git hook so it blocks Claude attribution rather than every commit
