// Plattform-Konfiguration (Cluster, Annahmen, Metrik-Endpunkte) und Zugriff darauf für Routen und Lasttests.
import { decrypt } from './crypto.js';
import { many, one, query } from './db.js';
import { createSampler } from './platformMetrics.js';

export const DEFAULT_PLATFORM = {
  cluster: {
    gpu_type: 'h100-sxm',
    gpu_count: 8,
    nvlink: true,
    inference: { server: 'vllm', tensor_parallel: 4, gpu_memory_utilization: 0.9, max_num_seqs: 256 },
    gateway: { type: 'litellm', instances: 2, rps_per_instance: 250 },
  },
  workload: { model: 'qwen3-32b', dtype: 'fp8', kv_dtype: 'fp16', avg_context: 4000, avg_output: 400, think_time_s: 30, target_tps: 15 },
  extra: { gpu_type: 'h100-sxm', gpu_count: 0 },
  metrics: { gpu: { urls: [], api_key_id: null }, inference: { urls: [], api_key_id: null }, gateway: { urls: [], api_key_id: null } },
};

export async function getPlatform() {
  const row = await one('select config, updated_at from platform_config where id = 1');
  const c = row?.config ?? {};
  return {
    config: {
      cluster: { ...DEFAULT_PLATFORM.cluster, ...c.cluster, inference: { ...DEFAULT_PLATFORM.cluster.inference, ...c.cluster?.inference }, gateway: { ...DEFAULT_PLATFORM.cluster.gateway, ...c.cluster?.gateway } },
      workload: { ...DEFAULT_PLATFORM.workload, ...c.workload },
      extra: { ...DEFAULT_PLATFORM.extra, ...c.extra },
      metrics: Object.fromEntries(Object.keys(DEFAULT_PLATFORM.metrics).map((k) => [k, { ...DEFAULT_PLATFORM.metrics[k], ...c.metrics?.[k] }])),
    },
    updated_at: row?.updated_at ?? null,
    saved: Boolean(row),
  };
}

export async function savePlatform(config, userId) {
  await query(
    `insert into platform_config (id, config, updated_by) values (1, $1, $2)
     on conflict (id) do update set config = excluded.config, updated_at = now(), updated_by = excluded.updated_by`,
    [JSON.stringify(config), userId ?? null],
  );
}

// Metrik-Endpunkte mit aufgelöstem Authorization-Header (Key aus der API-Key-Sammlung, nur serverseitig entschlüsselt).
export async function metricComponents() {
  const { config } = await getPlatform();
  const keys = await many('select id, secret_enc from api_keys');
  const byId = new Map(keys.map((k) => [k.id, k]));
  return Object.fromEntries(
    Object.entries(config.metrics).map(([name, m]) => {
      const key = m.api_key_id ? byId.get(m.api_key_id) : null;
      return [name, { urls: m.urls ?? [], authorization: key ? `Bearer ${decrypt(key.secret_enc)}` : undefined }];
    }),
  );
}

export async function platformSampler(intervalMs) {
  return createSampler(await metricComponents(), intervalMs);
}
