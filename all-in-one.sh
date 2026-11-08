#!/usr/bin/env bash

set -e
cd "$(dirname "$(realpath "$0")")"

if [ "$(oc get storageclass -ogo-template='{{ range .items }}{{ if .metadata.annotations }}{{ if eq (index .metadata.annotations "storageclass.kubernetes.io/is-default-class") "true" }}found{{ break }}{{ end }}{{ end }}{{ end }}')" != "found" ]; then
  echo 'You do not have a default StorageClass. This deployment requires persistent storage. Check the documentation.' >&2
  exit 1
fi

if [ -r .env ]; then
  . .env
fi
if [ -z "$ADMIN_PASSWORD" ]; then
  read -rsp 'Enter a password to set for the admin user (will be created): ' ADMIN_PASSWORD
  echo
  echo "ADMIN_PASSWORD=\"$ADMIN_PASSWORD\"" >> .env
fi
export ADMIN_PASSWORD
if [ -z "$USER_PASSWORD" ]; then
  read -rsp 'Enter a password to set for the generated users (user1-user5 by default): ' USER_PASSWORD
  echo
  echo "USER_PASSWORD=\"$USER_PASSWORD\"" >> .env
fi
export USER_PASSWORD
if [ -z "$GEMINI_API_KEY" ]; then
  read -rp 'Enter a Google Gemini API key to deploy the external model (optional, press Enter to skip): ' GEMINI_API_KEY
  if [ -n "$GEMINI_API_KEY" ]; then
    echo "GEMINI_API_KEY=\"$GEMINI_API_KEY\"" >> .env
  fi
fi
export GEMINI_API_KEY
if [ -z "$OPENAI_API_KEY" ]; then
  read -rp 'Enter an OpenAI API key to deploy the GPT external model (optional, press Enter to skip): ' OPENAI_API_KEY
  if [ -n "$OPENAI_API_KEY" ]; then
    echo "OPENAI_API_KEY=\"$OPENAI_API_KEY\"" >> .env
  fi
fi
export OPENAI_API_KEY
if [ -z "$REMOVE_KUBE_ADMIN" ]; then
  read -rn 1 -p 'Do you want to remove the kubeadmin user, if it exists? [y/N]: ' answer
  if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
    echo "Removing kubeadmin while stitching up keycloak..." >&2
    REMOVE_KUBE_ADMIN=true
  else
    echo "Leaving kubeadmin user..." >&2
    REMOVE_KUBE_ADMIN=false
  fi
  echo "REMOVE_KUBE_ADMIN=\"$REMOVE_KUBE_ADMIN\"" >> .env
fi
export REMOVE_KUBE_ADMIN

function noisy {
  local censored=()
  while [ "$1" = "-c" ]; do
    shift;
    censored+=("$1")
    shift;
  done
  local clean="${*}"
  for var in "${censored[@]}"; do
    clean="${clean/$var/<CENSORED>}"
  done
  echo "+ ${clean}"
  "${@}"
}

# Release name for the main chart. Clusters installed before the project was renamed
# run it as `maas-code-assistant`; point RELEASE_NAME at the existing release to upgrade
# one of those in place, instead of creating a second release that fights over the same
# resources. Check with: helm list -A
RELEASE_NAME="${RELEASE_NAME:-maas-pulse}"

INGRESS_DOMAIN=$(oc get ingresscontroller -n openshift-ingress-operator default -ojsonpath='{.status.domain}' 2>/dev/null)
if [ -z "$INGRESS_DOMAIN" ]; then
  echo "Unable to retrieve ingress configuration from your cluster." >&2
  echo "Are you logged in with oc?" >&2
  oc whoami
  exit 1
fi
export INGRESS_DOMAIN

INGRESS_CERTIFICATE=$(oc get ingresscontroller -n openshift-ingress-operator default -ojsonpath='{.spec.defaultCertificate.name}' 2>/dev/null)
if [ -z "$INGRESS_CERTIFICATE" ]; then
  INGRESS_CERTIFICATE=router-certs-default
  INGRESS_CA="$(oc get secret -n openshift-ingress-operator router-ca -ogo-template='{{ index .data "tls.crt" | base64decode }}')"
else
  INGRESS_CA=""
fi
export INGRESS_CERTIFICATE INGRESS_CA

if [ "$(oc get config.imageregistry cluster -ogo-template='{{ range .status.conditions }}{{ if eq .type "Available" }}{{ .status }}{{ end }}{{ end }}')" = "True" ]; then
  TOOLS_IMAGE=image-registry.openshift-image-registry.svc:5000/openshift/tools:latest
else
  TOOLS_IMAGE=quay.io/openshift-release-dev/ocp-v4.0-art-dev@sha256:e850f92068d8365e68bab663ae7b76be22c0af33f6a7803c5c95f5ee3f3748f4
fi
export TOOLS_IMAGE

function gateway_use_route {
  ret=1
  if ! oc get svc -n openshift-ingress router-default >/dev/null 2>&1; then
    ret=0
  fi
  if [ "$(oc get svc -n openshift-ingress router-default -ojsonpath='{.spec.type}')" != "LoadBalancer" ]; then
    ret=0
  fi
  if [ "$ret" -ne 1 ]; then
    echo "WARNING: Detected a non-load-balancer ingress configuration. Using a Route to back Gateway API resources." >&2
  fi
  return $ret
}
if gateway_use_route; then
  GATEWAY_USE_ROUTE=true
else
  GATEWAY_USE_ROUTE=false
fi
export GATEWAY_USE_ROUTE

MONITORING_CONFIG=true
if oc get configmap -n openshift-monitoring cluster-monitoring-config >/dev/null 2>&1; then
  echo "WARNING: Detected an existing cluster monitoring config. Ensure user-workload monitoring is enabled yourself for metrics to work!" >&2
  MONITORING_CONFIG=false
fi
export MONITORING_CONFIG

KEYCLOAK_CLIENT_SECRET=$(LC_ALL=C tr -dc 'A-Za-z0-9_!@#$%^&*()\-+=' < /dev/urandom | head -c32)
export KEYCLOAK_CLIENT_SECRET

if [ -f environment.yaml ]; then
  if ! grep -qF "$INGRESS_DOMAIN" environment.yaml; then
    echo "ERROR: You have an environment.yaml file templated, but it doesn't match the cluster you're logged into right now!" >&2
    echo >&2
    echo "If it's left over from an old deployment, delete it. Otherwise, ensure you're logged into the correct cluster" >&2
    exit 1
  fi
  processed=$(grep '^\s*processed: ' environment.yaml| cut -d: -f2 | tr -d '[:space:]')
else
  eval "cat << EOF > environment.yaml
$(<environment.yaml.tpl)
EOF
"
  processed=false
fi

if ! $processed; then
  for operator in $(oc get subscriptions -A -ojsonpath='{range .items[*]}{.spec.name}{"\n"}{end}' 2>/dev/null); do
    sed '/^[[:space:]]*'"$operator"':$/{n; s/enabled: true/enabled: false/;}' environment.yaml > environment.yaml.tmp && mv environment.yaml.tmp environment.yaml
  done
  # OpenShift AI installed beforehand: keep its DataScienceCluster (a cluster has only one).
  if [ -n "$(oc get datasciencecluster -o name 2>/dev/null)" ]; then
    printf '\ndataScienceCluster:\n  create: false\n' >> environment.yaml
  fi
  sed 's/^\([[:space:]]*processed:\) false/\1 true/' environment.yaml > environment.yaml.tmp && mv environment.yaml.tmp environment.yaml
fi

# Operators that were already installed are left alone above, so check that their versions
# are ones the demo works on (README, "Minimum software requirements").
function installed_version {
  oc get subscriptions.operators.coreos.com -A \
    -ojsonpath="{range .items[?(@.spec.name==\"$1\")]}{.status.installedCSV}{end}" 2>/dev/null \
    | sed 's/^[^.]*\.//; s/^v//'
}
function version_lt {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$1" ]
}
RHCL_VERSION=$(installed_version rhcl-operator)
if [ -n "$RHCL_VERSION" ] && version_lt "$RHCL_VERSION" 1.4.4; then
  echo "ERROR: Red Hat Connectivity Link $RHCL_VERSION is installed. The demo needs 1.4.4 or later," >&2
  echo "on channel stable-1.4 (not 'stable'): earlier versions hold gateway responses open on upstream" >&2
  echo "errors and compressed bodies. Move the rhcl-operator Subscription to channel stable-1.4," >&2
  echo "approve the upgrade, then re-run. Set SKIP_VERSION_CHECK=true to go ahead anyway." >&2
  [ "$SKIP_VERSION_CHECK" = "true" ] || exit 1
fi
RHOAI_VERSION=$(installed_version rhods-operator)
if [ -n "$RHOAI_VERSION" ] && version_lt "$RHOAI_VERSION" 3.5.2; then
  echo "WARNING: OpenShift AI $RHOAI_VERSION is installed; this project is tested on 3.5.2." >&2
fi

echo "environment.yaml:"
cat environment.yaml | sed 's/^/  /'

# Install all dependency operators, and create the DataScienceCluster for RHOAI
noisy helm upgrade --install --timeout 15m0s \
  dependency-operators charts/dependency-operators \
  -f environment.yaml
DSC_NAME=$(oc get datasciencecluster -ojsonpath='{.items[0].metadata.name}' 2>/dev/null)
noisy oc wait --for=condition=Ready datasciencecluster "${DSC_NAME:-default-dsc}" --timeout 15m0s
DSC_NAME=$(oc get datasciencecluster -ojsonpath='{.items[0].metadata.name}')
MAAS_STATE=$(oc get datasciencecluster "$DSC_NAME" -ojsonpath='{.spec.components.kserve.modelsAsService.managementState}{.spec.components.aigateway.modelsAsAService.managementState}')
if [ "${MAAS_STATE#*Managed}" = "$MAAS_STATE" ]; then
  echo "WARNING: Models-as-a-Service is not Managed in DataScienceCluster $DSC_NAME. Enable it" >&2
  echo "(spec.components.kserve.modelsAsService) before the models can be served through MaaS." >&2
fi

# Secrets for the main chart go in a temporary values file (mode 600), not on the command
# line: they stay out of `ps`, and a --set on one externalModels entry would replace the
# whole list and deploy no external model at all.
SECRETS_FILE=$(mktemp)
chmod 600 "$SECRETS_FILE"
trap 'rm -f "$SECRETS_FILE"' EXIT

# External models: provider keys by model name, as in charts/maas-pulse/values.yaml.
if [ -z "$GEMINI_API_KEY" ] && [ -z "$OPENAI_API_KEY" ]; then
  echo "Skipping the external models (no API keys provided)."
  echo "externalModels: []" >> "$SECRETS_FILE"
else
  echo "externalModelKeys:" >> "$SECRETS_FILE"
  if [ -n "$GEMINI_API_KEY" ]; then
    echo "  \"gemini-3.1-flash-lite\": \"$GEMINI_API_KEY\"" >> "$SECRETS_FILE"
  else
    echo "WARNING: no GEMINI_API_KEY: Gemini is deployed with a placeholder key, so its calls will fail." >&2
  fi
  if [ -n "$OPENAI_API_KEY" ]; then
    echo "  \"gpt-5.4-nano\": \"$OPENAI_API_KEY\"" >> "$SECRETS_FILE"
  else
    echo "WARNING: no OPENAI_API_KEY: GPT is deployed with a placeholder key, so its calls will fail." >&2
  fi
fi

# Traffic UI. The tier users are ServiceAccounts whose tokens the UI mints itself, so the
# only MaaS API key it needs is admin's. Keys line up with trafficUI.userNames: admin's
# first, then an empty entry for each tier user. ADMIN_API_KEY from .env, else the "admin"
# entry of user_keys.json (both gitignored). USER_API_KEYS (one per user) overrides both.
if [ -z "$ADMIN_API_KEY" ] && [ -r user_keys.json ]; then
  ADMIN_API_KEY=$(sed -n 's/.*"admin"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' user_keys.json | head -1)
fi
USER_COUNT=$(sed -n 's/^[[:space:]]*userNames:[[:space:]]*"\(.*\)".*/\1/p' charts/maas-pulse/values.yaml | head -1 | tr ',' '\n' | wc -l | tr -d ' ')
UI_KEYS="$USER_API_KEYS"
if [ -z "$UI_KEYS" ] && [ -n "$ADMIN_API_KEY" ]; then
  UI_KEYS="$ADMIN_API_KEY"
  i=1
  while [ "$i" -lt "$USER_COUNT" ]; do UI_KEYS="$UI_KEYS,"; i=$((i + 1)); done
fi
if [ -n "$UI_KEYS" ]; then
  printf 'trafficUI:\n  apiKeys: "%s"\n' "$UI_KEYS" >> "$SECRETS_FILE"
else
  echo "WARNING: no MaaS API key for the traffic UI's admin user, so admin's requests will be" >&2
  echo "refused (401). After this install, sign in to the OpenShift AI dashboard as admin, create an" >&2
  echo "API key in Gen AI Studio, put ADMIN_API_KEY=\"...\" in .env and re-run this script." >&2
fi
TRAFFIC_UI_ARGS=()
if [ -n "$TRAFFIC_UI_IMAGE" ]; then
  TRAFFIC_UI_ARGS+=(--set "trafficUI.image=$TRAFFIC_UI_IMAGE")
fi

# Only censor non-empty values — an empty pattern matches at position 0.
CENSOR_ARGS=()
for secret in "$ADMIN_PASSWORD" "$USER_PASSWORD"; do
  if [ -n "$secret" ]; then
    CENSOR_ARGS+=(-c "$secret")
  fi
done

# Install the chart
noisy "${CENSOR_ARGS[@]}" helm upgrade --install -n default --timeout 20m0s \
  "$RELEASE_NAME" charts/maas-pulse \
  -f charts/maas-pulse/all-dependencies.yaml \
  -f environment.yaml \
  --set keycloak.realm.admin.password="$ADMIN_PASSWORD" \
  --set keycloak.realm.user.password="$USER_PASSWORD" \
  -f "$SECRETS_FILE" \
  ${TRAFFIC_UI_ARGS[@]+"${TRAFFIC_UI_ARGS[@]}"}

echo ""
echo "Traffic UI: https://pulse.${INGRESS_DOMAIN}"
echo "Check the deployment with: ./scripts/verify-deployment.sh --skip-paid"

