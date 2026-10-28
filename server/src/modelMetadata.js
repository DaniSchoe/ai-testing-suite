// Metadaten eines Modells aus dem Namen ableiten lassen: das in den Systemeinstellungen als "KI-Analyse" gewählte Modell
// liefert Lizenz, Anbieter, Herkunftsland, Open Weights, Parameterzahl und Fähigkeiten. Fehler führen nie zum Abbruch.
import { one, many } from './db.js';
import { getAnalysisSetting } from './analysis.js';
import { ENDPOINT_SELECT, llmClientFor, resolveModel } from './models.js';

const CAPS = ['vision', 'tools', 'reasoning', 'json'];

const SYSTEM = `MODEL_METADATA: Du bekommst den Namen eines KI-Modells. Antworte ausschließlich mit einem JSON-Objekt ohne Erklärung und ohne Markdown mit diesen Schlüsseln:
{"provider": string|null (Hersteller bzw. Anbieter, z. B. "Alibaba Cloud"), "license": string|null (Name bzw. SPDX-Kennung der Lizenz der Modellgewichte, z. B. "Apache-2.0", "MIT", "Llama 3.1 Community License", "proprietär"; kein Titel von Nutzungsbedingungen wie "Terms of Use"), "origin": string|null (ISO-3166-Ländercode des Herstellers, z. B. "CN", "US", "FR"), "open_weights": boolean|null, "parameters_b": number|null (Parameter in Milliarden; bei MoE die Gesamtzahl), "capabilities": array aus "vision", "tools", "reasoning", "json"}
Nutze null, wenn du dir nicht sicher bist. Erfinde nichts.`;

// Nutzungsbedingungen sind keine Lizenz; solche Angaben der KI verwerfen wir lieber, als eine falsche Lizenz einzutragen.
const NOT_A_LICENSE = /terms\s+of\s+(use|service)|nutzungsbedingungen|\beula\b|terms\s+and\s+conditions/i;

export function parseSuggestion(text) {
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  let j;
  try {
    j = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const str = (v, max = 120) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const origin = str(j.origin, 20)?.toUpperCase() ?? null;
  const params = Number(j.parameters_b);
  return {
    provider: str(j.provider),
    license: str(j.license) && !NOT_A_LICENSE.test(str(j.license)) ? str(j.license) : null,
    origin: origin && /^[A-Z]{2}$/.test(origin) ? origin : null,
    open_weights: typeof j.open_weights === 'boolean' ? j.open_weights : null,
    parameters_b: Number.isFinite(params) && params > 0 ? params : null,
    capabilities: Array.isArray(j.capabilities) ? [...new Set(j.capabilities.filter((c) => CAPS.includes(c)))] : [],
  };
}

export async function suggestModelMetadata(tenantId, name, log = console) {
  try {
    const setting = await getAnalysisSetting(tenantId);
    if (!setting) return null;
    const endpoint = await one(`${ENDPOINT_SELECT} where e.id = $1`, [setting.endpoint_id]);
    if (!endpoint) return null;
    const rows = await many('select * from endpoint_models where endpoint_id = $1', [endpoint.id]);
    const model = resolveModel(rows, setting.model).name;
    const res = await llmClientFor(endpoint, { timeoutMs: 60_000 }).chat({
      model,
      temperature: 0,
      max_tokens: 400,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Modellname: ${name}` }],
    });
    return parseSuggestion(res.content);
  } catch (err) {
    log.warn?.(`Modell-Metadaten für „${name}“ nicht ermittelt: ${err.message}`);
    return null;
  }
}
