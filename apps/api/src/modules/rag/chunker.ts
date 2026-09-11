/**
 * AI: Splits a crawled page into retrieval units. The crawler emits one text element per line, so
 * a chunk is a run of consecutive lines of roughly `target` characters; long paragraphs are cut at
 * sentence boundaries with a small overlap so a fact that straddles the border is still found.
 * A short caption-like line followed by real text is treated as a heading and travels with every
 * chunk of its section - the model sees "Экскурсии в ТПУ › Минералогический музей".
 */
export interface Chunk {
  section: string;
  content: string;
}

const MD_HEADING = /^#{1,4}\s+(.+)$/;

export function chunkText(
  text: string,
  opts: { target?: number; max?: number; overlap?: number } = {},
): Chunk[] {
  const target = opts.target ?? 700;
  const max = opts.max ?? 1100;
  const overlap = opts.overlap ?? 120;

  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);

  const out: Chunk[] = [];
  let section = '';
  let buf = '';

  const flush = () => {
    const c = buf.trim();
    if (c.length >= 40) out.push({ section, content: c });
    buf = '';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const md = MD_HEADING.exec(line);
    if (md) {
      flush();
      section = md[1]!.trim();
      continue;
    }
    if (isHeading(line, lines[i + 1])) {
      flush();
      section = line;
      continue;
    }
    // AI: An oversized paragraph is cut into sentence-aligned windows with overlap.
    const pieces = line.length <= max ? [line] : windows(line, max, overlap);
    for (const piece of pieces) {
      if (buf && buf.length + piece.length + 1 > target) {
        // AI: Never orphan a label ("Проректор по …", "Адрес") at the end of a chunk - the row it
        // introduces (hours, room, phone) must travel with it.
        const cut = buf.lastIndexOf('\n');
        const tail = buf.slice(cut + 1);
        if (cut > 0 && isLabel(tail)) {
          buf = buf.slice(0, cut);
          flush();
          buf = tail;
        } else {
          flush();
        }
      }
      buf += (buf ? '\n' : '') + piece;
    }
  }
  flush();
  return out;
}

/** AI: Short caption-like line: no digits, no closing punctuation. */
function isLabel(line: string): boolean {
  return line.length >= 3 && line.length <= 70 && !/[.!?:;,]$/.test(line) && !/\d/.test(line);
}

/** AI: A label followed by a proper paragraph -> a heading. */
function isHeading(line: string, next: string | undefined): boolean {
  return isLabel(line) && next !== undefined && next.length > 80;
}

/**
 * AI: Site-wide boilerplate (menus, footers, breadcrumbs) repeats on every page and would match
 * every query. Lines shared by many pages are dropped before chunking; field labels are kept.
 */
export function stripBoilerplate(
  pages: string[],
  opts: { minPages?: number; maxLen?: number } = {},
): string[] {
  const minPages = opts.minPages ?? Math.max(4, Math.floor(pages.length * 0.15));
  const maxLen = opts.maxLen ?? 60;
  const count = new Map<string, number>();
  for (const page of pages) {
    const seen = new Set(
      page
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );
    for (const l of seen) count.set(l, (count.get(l) ?? 0) + 1);
  }
  const LABEL = /^(адрес|почта|e-?mail|тел\.?|телефон|факс|время работы|режим работы|сайт)$/i;
  const noise = (l: string) =>
    l.length <= maxLen && (count.get(l) ?? 0) >= minPages && !LABEL.test(l);
  return pages.map((page) =>
    page
      .split('\n')
      .filter((l) => !noise(l.trim()))
      .join('\n'),
  );
}

function windows(s: string, max: number, overlap: number): string[] {
  const sentences = s.split(/(?<=[.!?…])\s+/);
  const out: string[] = [];
  let cur = '';
  for (const sent of sentences) {
    if (cur && cur.length + sent.length + 1 > max) {
      out.push(cur);
      cur = cur.slice(Math.max(0, cur.length - overlap)) + ' ' + sent;
    } else {
      cur += (cur ? ' ' : '') + sent;
    }
  }
  if (cur) out.push(cur);
  return out;
}
