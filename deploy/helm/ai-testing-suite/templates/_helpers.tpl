{{- define "suite.fullname" -}}
{{- printf "%s" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "suite.labels" -}}
app.kubernetes.io/name: ai-testing-suite
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "suite.selector" -}}
app.kubernetes.io/name: ai-testing-suite
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "suite.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{- define "suite.secretName" -}}
{{- .Values.secrets.existingSecret | default (printf "%s-secrets" (include "suite.fullname" .)) -}}
{{- end -}}

{{/* Gemeinsame Umgebungsvariablen für Web, Worker und Migration */}}
{{- define "suite.env" -}}
- name: PUBLIC_URL
  value: {{ .Values.publicUrl | quote }}
- name: APP_VERSION
  value: {{ .Values.appVersion | default .Chart.AppVersion | quote }}
- name: LOG_LEVEL
  value: {{ .Values.logLevel | quote }}
- name: AUTH_MODE
  value: oidc
- name: OIDC_ISSUER_URL
  value: {{ .Values.oidc.issuerUrl | quote }}
- name: OIDC_TRUST_DISCOVERED_ISSUER
  value: {{ .Values.oidc.trustDiscoveredIssuer | default false | quote }}
- name: OIDC_CLIENT_ID
  value: {{ .Values.oidc.clientId | quote }}
- name: ADMIN_EMAILS
  value: {{ join "," .Values.adminEmails | quote }}
{{- $info := .Values.info | default dict }}
{{- $imprint := $info.imprint | default dict }}
{{- $support := $info.support | default dict }}
{{- range $pair := list (list "IMPRINT_COMPANY" $imprint.company) (list "IMPRINT_ADDRESS" $imprint.address) (list "IMPRINT_EMAIL" $imprint.email) (list "IMPRINT_PHONE" $imprint.phone) (list "IMPRINT_REGISTER" $imprint.register) (list "IMPRINT_REPRESENTED_BY" $imprint.representedBy) (list "SUPPORT_EMAIL" $support.email) (list "SUPPORT_PHONE" $support.phone) (list "SUPPORT_URL" $support.url) (list "SUPPORT_HOURS" $support.hours) (list "COPYRIGHT_HOLDER" $info.copyright) }}
{{- if index $pair 1 }}
- name: {{ index $pair 0 }}
  value: {{ index $pair 1 | quote }}
{{- end }}
{{- end }}
{{- if .Values.branding.existingConfigMap }}
- name: BRANDING_DIR
  value: /branding
{{- end }}
- name: WORKER_CONCURRENCY
  value: {{ .Values.worker.concurrency | quote }}
{{- range $key := list "DATABASE_URL" "APP_SECRET" "OIDC_CLIENT_SECRET" }}
- name: {{ $key }}
  valueFrom:
    secretKeyRef:
      name: {{ include "suite.secretName" $ }}
      key: {{ $key }}
      optional: {{ ne $key "DATABASE_URL" | and (ne $key "APP_SECRET") }}
{{- end }}
{{- with .Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end -}}
