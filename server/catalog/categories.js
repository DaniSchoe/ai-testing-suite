// Kategorien, nach denen Berichte und Dashboard gruppieren: OWASP LLM Top 10, AIC4 und die Souveränitätsziele (SOV).
// Weitere eigene Kategorien legen Administratoren in der Oberfläche an.
export const OWASP = 'OWASP LLM Top 10';
export const AIC4 = 'AIC4';
export const SOV = 'SOV';

export const CATEGORIES = [
  { framework: OWASP, key: 'LLM01', name: 'Prompt Injection' },
  { framework: OWASP, key: 'LLM02', name: 'Sensitive Information Disclosure' },
  { framework: OWASP, key: 'LLM03', name: 'Supply Chain' },
  { framework: OWASP, key: 'LLM04', name: 'Data and Model Poisoning' },
  { framework: OWASP, key: 'LLM05', name: 'Improper Output Handling' },
  { framework: OWASP, key: 'LLM06', name: 'Excessive Agency' },
  { framework: OWASP, key: 'LLM07', name: 'System Prompt Leakage' },
  { framework: OWASP, key: 'LLM08', name: 'Vector and Embedding Weaknesses' },
  { framework: OWASP, key: 'LLM09', name: 'Misinformation' },
  { framework: OWASP, key: 'LLM10', name: 'Unbounded Consumption' },
  // AIC4 (BSI): Kriterienbereiche in Kurzform. Die genaue Zuordnung einzelner Kriterien ergänzen Mandanten als eigene Kategorien.
  { framework: AIC4, key: 'SR', name: 'Security and Robustness' },
  { framework: AIC4, key: 'PF', name: 'Performance and Functionality' },
  { framework: AIC4, key: 'RE', name: 'Reliability' },
  { framework: AIC4, key: 'DQ', name: 'Data Quality' },
  { framework: AIC4, key: 'DM', name: 'Data Management' },
  { framework: AIC4, key: 'EX', name: 'Explainability' },
  { framework: AIC4, key: 'BI', name: 'Bias' },
  // Souveränitätsziele nach dem EU Cloud Sovereignty Framework (SEAL-Stufen 0 bis 4 je Ziel).
  { framework: SOV, key: 'SOV-1', name: 'Strategische Souveränität' },
  { framework: SOV, key: 'SOV-2', name: 'Rechtliche und juristische Souveränität' },
  { framework: SOV, key: 'SOV-3', name: 'Daten- und KI-Souveränität' },
  { framework: SOV, key: 'SOV-4', name: 'Betriebliche Souveränität' },
  { framework: SOV, key: 'SOV-5', name: 'Lieferketten-Souveränität' },
  { framework: SOV, key: 'SOV-6', name: 'Technologische Souveränität' },
  { framework: SOV, key: 'SOV-7', name: 'Sicherheit und Compliance' },
  { framework: SOV, key: 'SOV-8', name: 'Ökologische Nachhaltigkeit' },
].map((c) => ({ ...c, builtin: true }));

export const SOV_GOALS = CATEGORIES.filter((c) => c.framework === SOV);
