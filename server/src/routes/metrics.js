// Metriken (Beta): Dashboards zu den Metrics-Endpunkten der Komponenten und die zugehörigen Systemeinstellungen.
import { logAudit } from '../audit.js';
import { requirePermission } from '../auth.js';
import { many, query } from '../db.js';
import { cleanMetricsSettings, GROUP_OF, getMetricsSettings, metricEndpoints, metricsState, scrapeEndpoint, seriesFor } from '../metricsCollector.js';

export default async function metricsRoutes(app) {
  const viewer = { preHandler: requirePermission('suite.view') };
  const settingsAdmin = { preHandler: requirePermission('settings.manage') };

  // Dashboards: je Komponente mit Metrics-Endpunkt aktuelle Werte und Verlauf (Standard 60 Minuten).
  app.get('/api/metrics', viewer, async (request) => {
    const minutes = Math.min(Math.max(Number(request.query.minutes ?? 60), 5), 1440);
    const endpoints = await metricEndpoints('and e.tenant_id = $1 and ($2::uuid is null or e.platform_id = $2)', [request.user.tenant_id, request.query.platform_id || null]);
    const settings = await getMetricsSettings();
    const components = await Promise.all(
      endpoints.map(async (e) => {
        const series = await seriesFor(e, minutes);
        const st = metricsState().get(e.id) ?? null;
        return { id: e.id, name: e.name, kind: e.kind, group: GROUP_OF[e.kind], platform_name: e.platform_name, state: st, latest: series.at(-1)?.v ?? null, series };
      }),
    );
    return { enabled: settings.enabled, interval_s: settings.interval_s, minutes, components };
  });

  // Systemeinstellungen der Metrikdarstellung mit dem Zustand aller Metrics-Endpunkte.
  async function settingsView(request) {
    const endpoints = await metricEndpoints('and e.tenant_id = $1', [request.user.tenant_id]);
    const last = await many(`select endpoint_id, max(at) as at, count(*)::int as samples from metric_samples where endpoint_id = any($1::uuid[]) group by 1`, [endpoints.map((e) => e.id)]);
    return {
      settings: await getMetricsSettings(),
      endpoints: endpoints.map((e) => {
        const l = last.find((x) => x.endpoint_id === e.id);
        return { id: e.id, name: e.name, kind: e.kind, platform_name: e.platform_name, url: e.metrics_url, state: metricsState().get(e.id) ?? null, last_sample_at: l?.at ?? null, samples: l?.samples ?? 0 };
      }),
    };
  }

  app.get('/api/settings/metrics', settingsAdmin, settingsView);

  app.put('/api/settings/metrics', settingsAdmin, async (request) => {
    const value = cleanMetricsSettings(request.body);
    await query(`insert into app_settings (key, value, updated_by) values ('metrics', $1, $2) on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`, [JSON.stringify(value), request.user.id]);
    await logAudit(request, 'settings.metrics', 'settings', 'metrics', value);
    return settingsView(request);
  });

  // Alle Endpunkte jetzt abfragen (aktualisiert den angezeigten Zustand).
  app.post('/api/settings/metrics/check', settingsAdmin, async (request) => {
    const endpoints = await metricEndpoints('and e.tenant_id = $1', [request.user.tenant_id]);
    await Promise.all(endpoints.map(scrapeEndpoint));
    return settingsView(request);
  });
}
