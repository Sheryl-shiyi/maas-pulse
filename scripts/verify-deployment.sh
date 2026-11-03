#!/usr/bin/env bash
# Verify a maas-pulse deployment end to end: the platform settings it depends on, and
# real traffic through the MaaS gateway, including every failure mode found while
# upgrading the demo cluster on 2026-11-03 (operations log, T10/T18/T28).
#
# Read-only apart from the requests it sends. Costs about ten calls to the paid OpenAI
# model, well under one cent; --skip-paid leaves them out. The rate-limit check uses up
# the Free test user's quota on the internal model for a minute.
#
# Prerequisites:
#   - oc logged in as cluster-admin, plus curl and jq
#   - GPUs up for the internal-model checks; they are skipped, not failed, otherwise
#
# Usage:
#   ./verify-deployment.sh
#   ./verify-deployment.sh --skip-paid
#   GATEWAY_URL=https://maas.apps.example.com ./verify-deployment.sh
#
# Settings, all overridable from the environment:
#   GATEWAY_URL     default https://maas.<cluster ingress domain>
#   MODELS_NS       default llm
#   INTERNAL_MODEL  default publishers/llm/models/qwen3-8b-fp8
#   OPENAI_MODEL    default gpt-5.4-nano
#   GEMINI_MODEL    default gemini-3.1-flash-lite
#   FREE_USER       default maas-tier-free/user1 (namespace/serviceaccount)
#   MAX_USER        default maas-tier-max/user7
#
# Exit status is 1 if any check FAILs. WARN marks a problem outside the cluster, such as
# a provider's own 503.
set -euo pipefail

SKIP_PAID=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-paid) SKIP_PAID=true; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed -E 's/^# ?//'; exit 0 ;;
    *) echo "unknown option: $1"; exit 1 ;;
  esac
done

for tool in oc curl jq; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool"; exit 1; }
done

GATEWAY_URL="${GATEWAY_URL:-https://maas.$(oc get ingresses.config/cluster -o jsonpath='{.spec.domain}')}"
MODELS_NS="${MODELS_NS:-llm}"
INTERNAL_MODEL="${INTERNAL_MODEL:-publishers/llm/models/qwen3-8b-fp8}"
OPENAI_MODEL="${OPENAI_MODEL:-gpt-5.4-nano}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.1-flash-lite}"
FREE_USER="${FREE_USER:-maas-tier-free/user1}"
MAX_USER="${MAX_USER:-maas-tier-max/user7}"

PASS=0; FAIL=0; WARN=0; SKIP=0
if [ -t 1 ]; then G=$'\033[32m' R=$'\033[31m' Y=$'\033[33m' N=$'\033[0m'; else G='' R='' Y='' N=''; fi
pass() { PASS=$((PASS+1)); printf '  %sPASS%s  %s\n' "$G" "$N" "$*"; }
fail() { FAIL=$((FAIL+1)); printf '  %sFAIL%s  %s\n' "$R" "$N" "$*"; }
warn() { WARN=$((WARN+1)); printf '  %sWARN%s  %s\n' "$Y" "$N" "$*"; }
skip() { SKIP=$((SKIP+1)); printf '  SKIP  %s\n' "$*"; }

# version_ge A B: true when A >= B
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }

# installed_version <package>: version of the installed CSV, from its Subscription
installed_version() {
  oc get subscription -A -o json \
    | jq -r --arg p "$1" '[.items[] | select(.spec.name==$p) | .status.installedCSV // empty][0] // ""' \
    | sed -E 's/^[a-z-]+\.v?//'
}

token() { oc create token "${1#*/}" -n "${1%/*}" --duration=10m; }

# call <token> <model> [extra curl args...]: prints "<http code> <seconds>", never retries
call() {
  local tok=$1 model=$2; shift 2
  curl -sk --http1.1 -o /dev/null -w '%{http_code} %{time_total}' --max-time 20 \
    "$GATEWAY_URL/v1/chat/completions" -H "Authorization: Bearer $tok" \
    -H 'Content-Type: application/json' "$@" \
    -d "$(jq -nc --arg m "$model" '{model:$m,messages:[{role:"user",content:"Say OK"}],max_completion_tokens:10}')" || true
}

echo "Gateway: $GATEWAY_URL"
echo
echo "Platform"

rhoai=$(installed_version rhods-operator)
[ -n "$rhoai" ] && pass "RHOAI $rhoai installed" || fail "rhods-operator Subscription not found"

# 1.4.4 is the first RHCL whose wasm shim (0.14.3) stops holding responses open when it
# cannot read token usage. The head of the `stable` channel, 1.4.3, does not have it.
rhcl=$(installed_version rhcl-operator)
if [ -z "$rhcl" ]; then fail "rhcl-operator Subscription not found"
elif version_ge "$rhcl" 1.4.4; then pass "RHCL $rhcl (>= 1.4.4, has the wasm-shim fix)"
else fail "RHCL $rhcl is older than 1.4.4: upstream errors and compressed bodies will hang (use channel stable-1.4)"; fi

kuadrant_ns=$(oc get kuadrant -A -o jsonpath='{.items[0].metadata.namespace}' 2>/dev/null || true)
if [ -z "$kuadrant_ns" ]; then
  fail "no Kuadrant resource found"
else
  ready=$(oc get kuadrant -n "$kuadrant_ns" -o json | jq -r '.items[0].status.conditions[]? | select(.type=="Ready") | "\(.status) \(.message // "")"')
  [ "${ready%% *}" = "True" ] && pass "Kuadrant Ready" || fail "Kuadrant not Ready: ${ready#* }"
  # An RHCL upgrade once recreated the Authorino Service without its serving-cert
  # annotation; the cert was garbage collected and any Authorino restart would have
  # taken authentication down.
  if oc get secret authorino-server-cert -n "$kuadrant_ns" >/dev/null 2>&1; then
    pass "authorino-server-cert present"
  else
    fail "authorino-server-cert missing: oc annotate svc authorino-authorino-authorization -n $kuadrant_ns service.beta.openshift.io/serving-cert-secret-name=authorino-server-cert --overwrite"
  fi
fi

mem=$(oc get deploy -n openshift-ingress -l gateway.networking.k8s.io/gateway-name=maas-default-gateway \
  -o jsonpath='{.items[0].spec.template.spec.containers[?(@.name=="istio-proxy")].resources.limits.memory}' 2>/dev/null || true)
case "$mem" in
  "") fail "MaaS gateway deployment or its memory limit not found" ;;
  *Gi) [ "${mem%Gi}" -ge 2 ] && pass "gateway istio-proxy memory limit $mem" || fail "gateway memory limit $mem; RHCL 1.4 needs 2Gi" ;;
  *) warn "gateway memory limit $mem (expected 2Gi)" ;;
esac

# From RHCL 1.4 an unresolvable label fails the wasm task and holds every response open.
ef=$(oc get envoyfilter kuadrant-maas-default-gateway -n openshift-ingress -o json 2>/dev/null || true)
if [ -z "$ef" ]; then
  fail "EnvoyFilter kuadrant-maas-default-gateway not found"
else
  labels=$(echo "$ef" | grep -o 'metrics\.labels\.[a-z_]*' | sed 's/metrics\.labels\.//' | sort -u | tr '\n' ' ')
  if echo "$ef" | grep -q 'subscription_info\.'; then
    fail "telemetry labels read subscription_info fields, which hang every response on RHCL 1.4 (labels: $labels)"
  else
    pass "telemetry labels resolve: ${labels:-none}"
  fi
fi

# The AWS NAT drops TCP flows idle for 350s; pooled connections kept longer fail with 503.
drs=$(oc get destinationrule -n "$MODELS_NS" -l inference.opendatahub.io/external-provider -o json 2>/dev/null \
  | jq -r '.items[] | "\(.metadata.name) \(.spec.trafficPolicy.connectionPool.http.idleTimeout // "unset")"')
if [ -z "$drs" ]; then
  skip "no external-provider DestinationRules"
else
  while read -r name idle; do
    secs=${idle%s}
    if [ "$idle" != "unset" ] && [[ "$secs" =~ ^[0-9]+$ ]] && [ "$secs" -lt 350 ]; then
      pass "$name idleTimeout $idle"
    else
      fail "$name idleTimeout $idle: first calls after 6 idle minutes will get 503 (externalProviderIdleTimeout)"
    fi
  done <<< "$drs"
fi

echo
echo "Traffic"
T_MAX=$(token "$MAX_USER")
T_FREE=$(token "$FREE_USER")

internal_isvc=${INTERNAL_MODEL##*/}
internal_ready=$(oc get llminferenceservice "$internal_isvc" -n "$MODELS_NS" \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)

if [ "$internal_ready" = "True" ]; then
  read -r code t <<< "$(call "$T_MAX" "$INTERNAL_MODEL" -H 'Accept-Encoding: identity')"
  [ "$code" = "200" ] && pass "internal $internal_isvc: 200 in ${t}s" || fail "internal $internal_isvc: HTTP $code after ${t}s"

  # Rate limiting must still be enforced: 1k tokens/min for Free, ~117 tokens a call.
  codes=""; hit=""
  for i in $(seq 1 20); do
    c=$(curl -sk --http1.1 -o /dev/null -w '%{http_code}' --max-time 30 "$GATEWAY_URL/v1/chat/completions" \
      -H "Authorization: Bearer $T_FREE" -H 'Content-Type: application/json' -H 'Accept-Encoding: identity' \
      -d "$(jq -nc --arg m "$INTERNAL_MODEL" '{model:$m,messages:[{role:"user",content:"Explain in detail what a load balancer does."}],max_completion_tokens:100}')" || true)
    codes="$codes $c"
    if [ "$c" = "429" ]; then hit=$i; break; fi
  done
  [ -n "$hit" ] && pass "Free tier rate limited at request $hit" || fail "Free tier never rate limited in 20 requests:$codes"
else
  skip "internal model $internal_isvc not Ready (GPUs scaled down?)"
  skip "rate limit check needs the internal model"
fi

read -r code t <<< "$(call "$T_MAX" "$GEMINI_MODEL" -H 'Accept-Encoding: identity')"
case "$code" in
  200) pass "external $GEMINI_MODEL: 200 in ${t}s" ;;
  429|503) warn "external $GEMINI_MODEL: provider answered $code in ${t}s (Google capacity or quota, not the cluster)" ;;
  *) fail "external $GEMINI_MODEL: HTTP $code after ${t}s" ;;
esac

# An upstream 4xx must come straight back. On RHCL < 1.4.4 it hung until the client gave up.
code_time=$(curl -sk --http1.1 -o /dev/null -w '%{http_code} %{time_total}' --max-time 15 "$GATEWAY_URL/v1/chat/completions" \
  -H "Authorization: Bearer $T_MAX" -H 'Content-Type: application/json' -H 'Accept-Encoding: identity' \
  -d "$(jq -nc --arg m "$GEMINI_MODEL" '{model:$m,messages:[{role:"user",content:"Say OK"}],max_completion_tokens:5,temperature:9}')" || true)
read -r code t <<< "$code_time"
if [ "$code" = "400" ] && awk -v t="$t" 'BEGIN{exit !(t<5)}'; then
  pass "upstream 400 returned in ${t}s"
else
  fail "upstream error took ${t}s (HTTP $code); expected a 400 within 5s (wasm-shim hang, RHCL < 1.4.4?)"
fi

if $SKIP_PAID; then
  skip "paid OpenAI checks (--skip-paid)"
else
  # First call, no retry: a 503 here is the stale-connection failure (T28).
  read -r code t <<< "$(call "$T_MAX" "$OPENAI_MODEL" -H 'Accept-Encoding: identity')"
  [ "$code" = "200" ] && pass "external $OPENAI_MODEL: 200 in ${t}s on the first attempt" || fail "external $OPENAI_MODEL: HTTP $code after ${t}s"

  # A compressed success must complete. Before RHCL 1.4.4, 9 of 9 hung.
  hung=0
  while read -r t; do
    awk -v t="$t" 'BEGIN{exit !(t>=14.9)}' && hung=$((hung+1))
  done < <(for i in $(seq 1 9); do
      curl -sk --http1.1 -o /dev/null -w '%{time_total}\n' --max-time 15 "$GATEWAY_URL/v1/chat/completions" \
        -H "Authorization: Bearer $T_MAX" -H 'Content-Type: application/json' -H 'Accept-Encoding: br' \
        -d "$(jq -nc --arg m "$OPENAI_MODEL" '{model:$m,messages:[{role:"user",content:"Explain in two sentences what a load balancer does."}],max_completion_tokens:100}')" &
    done; wait)
  [ "$hung" -eq 0 ] && pass "9 concurrent compressed responses all completed" || fail "$hung of 9 compressed responses hung (wasm-shim, RHCL < 1.4.4?)"
fi

echo
echo "Result: $PASS passed, $FAIL failed, $WARN warnings, $SKIP skipped"
[ "$FAIL" -eq 0 ]
