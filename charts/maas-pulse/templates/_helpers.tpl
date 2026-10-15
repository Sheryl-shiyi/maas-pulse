{{/*
Expand the name of the chart.
*/}}
{{- define "maas-pulse.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "maas-pulse.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "maas-pulse.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "maas-pulse.labels" -}}
helm.sh/chart: {{ include "maas-pulse.chart" . }}
{{ include "maas-pulse.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "maas-pulse.selectorLabels" -}}
app.kubernetes.io/name: {{ include "maas-pulse.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Common labels for the traffic UI resources.

Same as maas-pulse.labels except that app.kubernetes.io/name stays maas-pulse-ui.
The UI templates used to write that label themselves and then include
maas-pulse.labels, which emits the key a second time as maas-pulse; a duplicate
YAML key silently keeps the last value, so the resources ended up labelled
maas-pulse and `oc get -l app.kubernetes.io/name=maas-pulse-ui` did not find them.
Do not use this for a selector — the pod template and the Deployment/Service
selectors set the name label directly, and selectors are immutable.
*/}}
{{- define "maas-pulse.uiLabels" -}}
helm.sh/chart: {{ include "maas-pulse.chart" . }}
app.kubernetes.io/name: maas-pulse-ui
app.kubernetes.io/instance: {{ .Release.Name }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- /* part-of groups the resources into one card in the OpenShift console
       Topology view; runtime picks the icon drawn on it. */}}
app.kubernetes.io/part-of: maas-pulse
app.openshift.io/runtime: nodejs
{{- end }}

{{/*
Namespace the traffic UI runs in.

It used to land in the release namespace, which is `default` — a namespace the
OpenShift console hides from the Topology view unless you tick "Show default
projects", so the UI was effectively invisible there. Giving it its own namespace
also makes teardown a single delete. The Helm release itself stays where it is;
only the UI's own resources move, so this needs no reinstall.
*/}}
{{- define "maas-pulse.uiNamespace" -}}
{{- .Values.trafficUI.namespace | default .Release.Namespace }}
{{- end }}
