// Modellkatalog: Abruf der Modelle je Endpoint und Auflösung von Aliasen.
import { decrypt } from './crypto.js';
import { many, query } from './db.js';
import { LlmClient } from './runner/clients.js';

export function endpointHeaders(endpoint) {
  const key = decrypt(endpoint.api_key_enc);
  return { ...endpoint.headers, ...(key ? { authorization: `Bearer ${key}` } : {}) };
}

export async function listEndpointModels(endpointId) {
  return many('select * from endpoint_models where endpoint_id = $1 order by coalesce(alias, name)', [endpointId]);
}

// /v1/models abfragen und den Katalog abgleichen. Nicht mehr gelistete Modelle bleiben mit
// available = false erhalten, damit Aliase und Historie nicht verloren gehen.
export async function syncEndpointModels(endpoint) {
  if (endpoint.kind === 'mcp') return [];
  try {
    const names = await new LlmClient({ baseUrl: endpoint.base_url, headers: endpointHeaders(endpoint), timeoutMs: 15_000 }).models();
    await query(
      `insert into endpoint_models (endpoint_id, name, source, available, last_seen_at)
       select $1, unnest($2::text[]), 'discovered', true, now()
       on conflict (endpoint_id, name) do update set available = true, last_seen_at = now()`,
      [endpoint.id, names],
    );
    await query(
      `update endpoint_models set available = false
       where endpoint_id = $1 and source = 'discovered' and not (name = any($2::text[]))`,
      [endpoint.id, names],
    );
    await query('update endpoints set models_synced_at = now(), models_sync_error = null where id = $1', [endpoint.id]);
    return names;
  } catch (err) {
    await query('update endpoints set models_sync_error = $2 where id = $1', [endpoint.id, err.message.slice(0, 500)]);
    throw err;
  }
}

export async function syncAllModels(log = console) {
  const endpoints = await many(`select * from endpoints where enabled and auto_discover and kind <> 'mcp'`);
  for (const e of endpoints) {
    try {
      const names = await syncEndpointModels(e);
      log.info(`Modelle von ${e.name}: ${names.length}`);
    } catch (err) {
      log.warn(`Modellabruf für ${e.name} fehlgeschlagen: ${err.message}`);
    }
  }
}

// Angefragten Namen (echter Name oder Alias) auf den Namen am Endpoint abbilden.
export function resolveModel(rows, requested) {
  if (!requested) return null;
  const hit = rows.find((r) => r.name === requested) ?? rows.find((r) => r.alias === requested);
  return hit ? { name: hit.name, alias: hit.alias ?? hit.name } : { name: requested, alias: requested };
}

export function aliasOf(rows, name) {
  const hit = rows.find((r) => r.name === name);
  return hit?.alias ?? name;
}
