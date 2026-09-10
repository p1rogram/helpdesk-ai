import { useEffect, useState } from 'react';
import type { KbSearchResult } from '@helpdesk/shared';
import type { ApiClient } from '../lib/api';

/** "Поиск по базе знаний" - self-service without a dialogue. */
export function KbScreen(props: { api: ApiClient }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<KbSearchResult[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (q.trim().length < 1) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      props.api
        .searchKb(q.trim())
        .then((r) => setResults(r.results))
        .catch(() => setResults([]));
    }, 150);
    return () => clearTimeout(t);
  }, [q, props.api]);

  return (
    <>
      <div className="search">
        <input placeholder="Поиск по базе знаний: например, VPN" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      <div className="list">
        {q.trim().length >= 1 && !results.length && <div className="empty">Ничего не найдено. Опишите проблему в чате.</div>}
        {results.map((r) => (
          <div key={r.id} className="item" onClick={() => setOpen(open === r.id ? null : r.id)}>
            <div className="t">{r.title}</div>
            {open === r.id && (
              <ol style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {r.steps.map((s, i) => (
                  <li key={i} style={{ margin: '4px 0' }}>
                    {s}
                  </li>
                ))}
              </ol>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
