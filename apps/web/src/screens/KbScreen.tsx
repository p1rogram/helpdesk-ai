import { useEffect, useState } from 'react';
import type { DocPassage, KbSearchResult } from '@helpdesk/shared';
import type { ApiClient } from '../lib/api';
import { Icon, categoryVisual } from '../components/Icon';

interface Category {
  id: string;
  name: string;
}

/** AI: База знаний: плитки категорий, поиск с первого символа, статья с пошаговой инструкцией. */
export function KbScreen(props: { api: ApiClient }) {
  const [q, setQ] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [category, setCategory] = useState<Category | null>(null);
  const [results, setResults] = useState<KbSearchResult[] | null>(null);
  const [docs, setDocs] = useState<DocPassage[]>([]);
  const [open, setOpen] = useState<KbSearchResult | null>(null);

  useEffect(() => {
    props.api
      .categories()
      .then((r) => setCategories(r.categories))
      .catch(() => setCategories([]));
  }, [props.api]);

  useEffect(() => {
    const query = q.trim();
    if (!query && !category) {
      setResults(null);
      setDocs([]);
      return;
    }
    const t = setTimeout(() => {
      props.api
        .searchKb(query || (category?.name ?? ''))
        .then((r) => {
          setResults(
            category && !query ? r.results.filter((x) => x.categoryId === category.id) : r.results,
          );
          // AI: Documentation fragments (RAG) only for a typed query - a category tile is not a question.
          setDocs(query ? dedupeDocs(r.docs ?? []) : []);
        })
        .catch(() => {
          setResults([]);
          setDocs([]);
        });
    }, 150);
    return () => clearTimeout(t);
  }, [q, category, props.api]);

  if (open) {
    return (
      <>
        <div className="toolbar">
          <button className="pill-btn" onClick={() => setOpen(null)}>
            <Icon name="back" size={14} /> Назад
          </button>
        </div>
        <div className="list scroll">
          <div className="panel">
            <h3 style={{ fontSize: 16, marginBottom: 4 }}>{open.title}</h3>
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>
              Пошаговая инструкция · {open.steps.length} шага
            </div>
            <ol className="article-steps">
              {open.steps.map((s, i) => (
                <li key={i}>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="search">
        <span className="ico">
          <Icon name="search" size={17} />
        </span>
        <input placeholder="Поиск по статьям…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {category && (
        <div className="toolbar">
          <button className="pill-btn" onClick={() => setCategory(null)}>
            <Icon name="back" size={14} /> Все категории
          </button>
          <span style={{ color: 'var(--muted)' }}>{category.name}</span>
        </div>
      )}

      <div className="scroll">
        {!q.trim() && !category && (
          <div className="tiles">
            {categories.map((c) => {
              const v = categoryVisual(c.id);
              return (
                <button key={c.id} className="tile" onClick={() => setCategory(c)}>
                  <span className={`tile-ico ${v.tone}`}>
                    <Icon name={v.icon} size={19} />
                  </span>
                  {c.name}
                </button>
              );
            })}
          </div>
        )}

        <div className="list">
          {results?.map((r) => (
            <div key={r.id} className="item" onClick={() => setOpen(r)}>
              <div className="body">
                <div className="t">{r.title}</div>
                <div className="m">Пошаговая инструкция · {r.steps.length} шага</div>
              </div>
              <Icon name="back" size={16} className="chev" />
            </div>
          ))}
          {docs.length > 0 && (
            <>
              <div className="section-label">Из документации ТПУ</div>
              {docs.map((d) => (
                <a key={d.id} className="item doc" href={d.url} target="_blank" rel="noreferrer">
                  <div className="body">
                    <div className="t">
                      {d.title}
                      {d.section && <span className="sec"> › {d.section}</span>}
                    </div>
                    <div className="snippet">{d.snippet}</div>
                    <div className="m">{new URL(d.url).hostname}</div>
                  </div>
                  <Icon name="back" size={16} className="chev" />
                </a>
              ))}
            </>
          )}
          {results !== null && !results.length && !docs.length && (
            <div className="empty">
              <span className="art">
                <Icon name="search" size={30} />
              </span>
              <div className="lead">Ничего не найдено</div>
              <div>Опишите проблему в чате, помощник разберётся.</div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** AI: Several chunks of one page often match; show each page once (its best chunk). */
function dedupeDocs(docs: DocPassage[]): DocPassage[] {
  const seen = new Set<string>();
  return docs.filter((d) => {
    const key = d.url.replace(/\/+$/, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
