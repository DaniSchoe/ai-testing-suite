import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Card, KindBadge, TYPE_LABELS, useApi } from '../lib.jsx';
import { TYPE_DOCS } from '../testTypeDocs.js';

// Beschreibt, was eine Testart konkret durchführt.
export default function TestTypeInfo() {
  const { type } = useParams();
  const types = useApi('/api/test-types');
  const info = types.data?.find((t) => t.type === type);
  const doc = TYPE_DOCS[type];
  if (types.data && !info) return <div className="empty">Testart nicht gefunden</div>;
  if (!info || !doc) return null;
  const Icon = doc.Icon;
  return (
    <>
      <div className="page-head">
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <span className="icon-chip" style={{ width: 44, height: 44 }}>
            <Icon size={22} />
          </span>
          <div>
            <h1>{TYPE_LABELS[type] ?? info.label}</h1>
            <p>{doc.summary}</p>
          </div>
        </div>
        <Link className="btn" to="/test-builder">
          <ArrowLeft size={15} /> Zum Test-Builder
        </Link>
      </div>
      <div className="two-col">
        <Card title="Was passiert beim Ausführen?">
          <ol className="steps">
            {doc.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <p className="sub" style={{ marginTop: 12 }}>
            {doc.when}
          </p>
        </Card>
        <Card title="Kennzahlen">
          <ul className="steps">
            {doc.metrics.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <div style={{ marginTop: 14 }} className="tags">
            {info.endpointKinds.map((k) => (
              <KindBadge key={k} kind={k} />
            ))}
          </div>
          <div className="sub" style={{ marginTop: 6 }}>
            Passt zu diesen Endpoint-Arten
          </div>
        </Card>
      </div>
      <Card title="Standardkonfiguration" sub="Wird im Test-Builder vorbefüllt und lässt sich im Experten-Modus anpassen">
        <pre className="mono code-block">{JSON.stringify(info.defaults, null, 2)}</pre>
      </Card>
    </>
  );
}
