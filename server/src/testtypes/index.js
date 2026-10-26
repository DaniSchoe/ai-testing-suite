// Registry aller Testtypen. Ein neuer Typ braucht nur { type, label, description, defaults, run(ctx) }.
import smoke from './smoke.js';
import performance from './performance.js';
import load from './load.js';
import quality from './quality.js';
import comparison from './comparison.js';
import security from './security.js';
import access from './access.js';
import mcp from './mcp.js';
import ratelimit from './ratelimit.js';
import structured from './structured.js';

export const testTypes = Object.fromEntries(
  [smoke, performance, load, quality, comparison, security, access, mcp, ratelimit, structured].map((t) => [t.type, t]),
);

export function describeTypes() {
  return Object.values(testTypes).map(({ type, label, description, defaults, endpointKinds }) => ({
    type,
    label,
    description,
    defaults,
    endpointKinds: endpointKinds ?? ['litellm', 'vllm', 'openai'],
  }));
}
