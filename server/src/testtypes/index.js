// Registry aller Testtypen. Ein neuer Typ braucht nur { type, label, description, defaults, run(ctx) }.
import smoke from './smoke.js';
import performance from './performance.js';
import load from './load.js';
import quality from './quality.js';
import coding from './coding.js';
import ocr from './ocr.js';
import security from './security.js';
import access from './access.js';
import mcp from './mcp.js';
import structured from './structured.js';
import thinking from './thinking.js';

export const testTypes = Object.fromEntries(
  [smoke, performance, load, quality, coding, ocr, security, access, mcp, structured, thinking].map((t) => [t.type, t]),
);

export function describeTypes() {
  return Object.values(testTypes).map(({ type, label, description, defaults, endpointKinds, modelMode }) => ({
    type,
    label,
    description,
    defaults,
    endpointKinds: endpointKinds ?? ['ai_proxy', 'llm'],
    modelMode: modelMode ?? 'each',
  }));
}
