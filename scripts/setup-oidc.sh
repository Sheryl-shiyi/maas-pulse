#!/usr/bin/env bash
# Set up OIDC authentication for MaaS on the current cluster.
#
# This script automates what the Helm chart does when oidc.enabled=true,
# but can be run standalone for manual or iterative setups.
#
# Prerequisites:
#   - Logged into an OpenShift cluster with cluster-admin
#   - Keycloak Operator installed and a Keycloak instance running
#   - MaaS (RHOAI 3.5+) installed with an AITenant
#
# Usage:
#   ./setup-oidc.sh                              # auto-detect Keycloak
#   ./setup-oidc.sh --keycloak-namespace keycloak # explicit namespace
#   ./setup-oidc.sh --issuer-url https://...      # skip auto-detection
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="${DIR}/../charts/maas-pulse"
KC_NS=""
ISSUER_URL=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --keycloak-namespace) KC_NS="$2"; shift 2 ;;
    --issuer-url) ISSUER_URL="$2"; shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown option: $1"; exit 1 ;;
  esac
done

oc whoami >/dev/null 2>&1 || { echo "Not logged in to a cluster"; exit 1; }

# --- 1. Find Keycloak ---
if [ -z "$KC_NS" ]; then
  FOUND=$(oc get keycloak -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}' 2>/dev/null | sed '/^$/d')
  COUNT=$(printf '%s\n' "$FOUND" | sed '/^$/d' | wc -l | tr -d ' ')
  [ "$COUNT" -eq 0 ] && { echo "No Keycloak found. Install Keycloak Operator first."; exit 1; }
  [ "$COUNT" -gt 1 ] && { echo "Multiple Keycloak instances — specify with --keycloak-namespace:"; printf '  %s\n' "$FOUND"; exit 1; }
  KC_NS="${FOUND%%/*}"
fi
KC_NAME=$(oc get keycloak -n "$KC_NS" -o jsonpath='{.items[0].metadata.name}')
echo "==> Using Keycloak ${KC_NS}/${KC_NAME}"

# --- 2. Import the maas realm ---
echo "==> Importing 'maas' realm into Keycloak"
REALM_TEMPLATE="${CHART_DIR}/templates/oidc/keycloak-realm-import.yaml"

sed "s/REALM_NAMESPACE/${KC_NS}/" "${DIR}/realm-import-standalone.yaml" | oc apply -f -

# Wait for realm import
echo "==> Waiting for realm import..."
for i in $(seq 1 60); do
  DONE=$(oc get keycloakrealmimport maas -n "$KC_NS" -o jsonpath='{.status.conditions[?(@.type=="Done")].status}' 2>/dev/null || true)
  [ "$DONE" = "True" ] && { echo "    Realm imported successfully"; break; }
  sleep 5
done
[ "${DONE:-}" = "True" ] || { echo "    Realm import did not complete. Check: oc get keycloakrealmimport maas -n $KC_NS -o yaml"; exit 1; }

# --- 3. Derive issuer URL ---
if [ -z "$ISSUER_URL" ]; then
  KC_HOST=$(oc get keycloak "$KC_NAME" -n "$KC_NS" -o jsonpath='{.spec.hostname.hostname}' 2>/dev/null)
  [ -z "$KC_HOST" ] && KC_HOST=$(oc get route -n "$KC_NS" -o jsonpath='{.items[0].spec.host}')
  ISSUER_URL="https://${KC_HOST}/realms/maas"
fi
echo "==> Issuer URL: ${ISSUER_URL}"

# Verify discovery endpoint
CODE=$(curl -sSk -o /dev/null -w '%{http_code}' "${ISSUER_URL}/.well-known/openid-configuration" || echo 000)
[ "$CODE" = "200" ] || { echo "    Discovery endpoint returned HTTP ${CODE} — check the URL"; exit 1; }
echo "    Discovery endpoint OK (HTTP 200)"

# --- 4. Patch AITenant with OIDC config ---
echo "==> Patching AITenant with OIDC configuration"
if oc get crd aitenants.maas.opendatahub.io >/dev/null 2>&1; then
  oc patch aitenants.maas.opendatahub.io models-as-a-service -n ai-tenants --type merge \
    -p "{\"spec\":{\"oidc\":{\"clientId\":\"maas-oidc\",\"issuerUrl\":\"${ISSUER_URL}\",\"ttl\":300}}}"
else
  oc patch tenants.maas.opendatahub.io default-tenant -n models-as-a-service --type merge \
    -p "{\"spec\":{\"externalOIDC\":{\"clientId\":\"maas-oidc\",\"issuerUrl\":\"${ISSUER_URL}\"}}}"
fi

echo
echo "==> OIDC setup complete"
echo "    Issuer:  ${ISSUER_URL}"
echo "    Client:  maas-oidc"
echo "    Users:   maas-user / maas-user  (groups: data-scientists, ml-engineers)"
echo "             restricted-user / restricted-user  (groups: data-scientists)"
echo
echo "Next steps:"
echo "  1. Deploy OIDC auth policies and subscriptions via Helm:"
echo "     helm upgrade <release> ${CHART_DIR} --set oidc.enabled=true --set oidc.issuerUrl=${ISSUER_URL}"
echo "  2. Run the demo app:"
echo "     python3 ${DIR}/../demo/oidc/maas-ui.py --from-cluster --model-served 'publishers/llm/models/qwen3-8b-fp8' --model-path 'qwen3-8b-fp8'"
