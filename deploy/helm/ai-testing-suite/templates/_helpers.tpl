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
- name: LOG_LEVEL
  value: {{ .Values.logLevel | quote }}
- name: AUTH_MODE
  value: oidc
- name: OIDC_ISSUER_URL
  value: {{ .Values.oidc.issuerUrl | quote }}
- name: OIDC_CLIENT_ID
  value: {{ .Values.oidc.clientId | quote }}
- name: OIDC_PERSONA_CLIENT_ID
  value: {{ .Values.oidc.personaClientId | quote }}
- name: ROLE_ADMIN
  value: {{ .Values.oidc.roles.admin | quote }}
- name: ROLE_TESTER
  value: {{ .Values.oidc.roles.tester | quote }}
- name: ROLE_VIEWER
  value: {{ .Values.oidc.roles.viewer | quote }}
- name: DEFAULT_ROLE
  value: {{ .Values.oidc.defaultRole | quote }}
- name: WORKER_CONCURRENCY
  value: {{ .Values.worker.concurrency | quote }}
{{- range $key := list "DATABASE_URL" "APP_SECRET" "OIDC_CLIENT_SECRET" "OIDC_PERSONA_CLIENT_SECRET" }}
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
