/**
 * Best-effort PDF import.
 *
 * A PDF says where glyphs sit on a page; it says nothing about paragraphs,
 * headings or reading order. Everything below is inference, and it is tuned
 * for the case this reader cares about: a single-column novel. Anything with
 * real layout — columns, tables, figures — degrades, and the caller is told so
 * rather than being handed silent nonsense.
 *
 * The output is an EPUB, so a converted PDF is a book like any other: it
 * syncs, it takes bookmarks, it reflows, it gets bionic text.
 */

import { createZip, type ZipEntry } from './zip';

export type PdfImportWarning = 'columns' | 'sparse';

export type PdfImportResult = {
  file: File;
  cover: Blob | null;
  title: string;
  creator: string;
  pages: number;
  warnings: PdfImportWarning[];
};

export class PdfTextMissingError extends Error {
  constructor() {
    super(
      'This PDF has no text in it, only page images. A scan has to be run through OCR before it can be read.',
    );
    this.name = 'PdfTextMissingError';
  }
}

type Line = {
  text: string;
  left: number;
  right: number;
  top: number;
  size: number;
};

type Block = { kind: 'heading' | 'paragraph'; text: string };

const HYPHENS = /[-‐‑]$/;
const PAGE_NUMBER = /^[\divxlcDIVXLC]+$/;
// Sections are split so EPUB.js has something to page through.
const SECTION_LIMIT = 60_000;

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

type Item = { str: string; transform: number[]; height: number; width: number };

/** Group a column's glyph runs into lines, in the order a person would read. */
function toLines(items: Item[]) {
  const rows: Line[] = [];

  for (const item of items) {
    const text = item.str;
    if (!text.trim()) {
      continue;
    }
    const left = item.transform[4];
    const top = item.transform[5];
    const size = item.height || Math.abs(item.transform[3]) || 10;
    // PDF.js reports the run's real width, which beats guessing from length.
    const width = item.width || text.length * size * 0.5;
    // Same baseline, give or take: PDFs rarely align them exactly.
    const row = rows.find(
      candidate =>
        Math.abs(candidate.top - top) < Math.max(2, size * 0.4) &&
        Math.abs(candidate.size - size) < 0.6,
    );

    if (row) {
      const gap = left - row.right;
      row.text +=
        gap > size * 0.25 && !row.text.endsWith(' ') && !text.startsWith(' ')
          ? ` ${text}`
          : text;
      row.left = Math.min(row.left, left);
      row.right = Math.max(row.right, left + width);
    } else {
      rows.push({ text, left, right: left + width, top, size });
    }
  }

  return rows.sort((first, second) => second.top - first.top);
}

/**
 * Find a vertical gutter no run crosses, before anything is joined into lines:
 * a left column and a right column share baselines, so merging first would
 * splice the two together and lose the gutter along with the reading order.
 */
export function pageLines(items: Item[], pageWidth: number) {
  const real = items.filter(item => item.str.trim());
  if (real.length < 20) {
    return { lines: toLines(real), columns: 1 };
  }

  const middle = pageWidth / 2;
  const band = pageWidth * 0.06;
  const spans = real.map(item => ({
    item,
    left: item.transform[4],
    right: item.transform[4] + (item.width || 0),
  }));
  const crossing = spans.filter(
    span => span.left < middle - band && span.right > middle + band,
  );
  const left = spans.filter(span => span.right <= middle + band);
  const right = spans.filter(span => span.left >= middle - band);

  const isTwoColumn =
    crossing.length / real.length < 0.06 &&
    left.length > real.length * 0.3 &&
    right.length > real.length * 0.3;

  if (!isTwoColumn) {
    return { lines: toLines(real), columns: 1 };
  }

  return {
    // Anything spanning the gutter is a title or a figure caption: it belongs
    // above both columns, which is where reading starts.
    lines: [
      ...toLines(crossing.map(span => span.item)),
      ...toLines(left.map(span => span.item)),
      ...toLines(right.map(span => span.item)),
    ],
    columns: 2,
  };
}

/** Drop the running header and footer a book repeats on every page. */
export function stripRunningTitles(pages: Line[][]) {
  const seen = new Map<string, number>();
  const edges = (lines: Line[]) =>
    [lines[0], lines[lines.length - 1]].filter(Boolean);

  for (const lines of pages) {
    for (const line of edges(lines)) {
      const key = line.text.replace(/\d+/g, '#').trim().toLowerCase();
      if (key.length > 1) {
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
  }

  const repeated = new Set(
    [...seen.entries()]
      .filter(([, count]) => count >= Math.max(3, pages.length * 0.4))
      .map(([key]) => key),
  );

  return pages.map(lines =>
    lines.filter((line, index) => {
      if (index !== 0 && index !== lines.length - 1) {
        return true;
      }
      const text = line.text.trim();
      if (PAGE_NUMBER.test(text)) {
        return false;
      }
      return !repeated.has(text.replace(/\d+/g, '#').toLowerCase());
    }),
  );
}

/** Turn ordered lines into paragraphs and headings. */
export function toBlocks(pages: Line[][]) {
  const all = pages.flat();
  if (all.length === 0) {
    return [];
  }

  const sizes = all.map(line => line.size).sort((a, b) => a - b);
  const bodySize = sizes[Math.floor(sizes.length / 2)];
  const widths = all.map(line => line.right - line.left).sort((a, b) => a - b);
  const bodyWidth = widths[Math.floor(widths.length * 0.75)];

  const blocks: Block[] = [];
  let current = '';

  const flush = () => {
    const text = current.replace(/\s+/g, ' ').trim();
    if (text) {
      blocks.push({ kind: 'paragraph', text });
    }
    current = '';
  };

  for (const lines of pages) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const text = line.text.trim();
      if (!text) {
        continue;
      }

      // A short, larger line on its own is a chapter title far more often
      // than it is a sentence.
      if (line.size > bodySize * 1.18 && text.length < 70) {
        flush();
        blocks.push({ kind: 'heading', text });
        continue;
      }

      const previous = lines[index - 1];
      const gap = previous ? previous.top - line.top : 0;
      const startsParagraph =
        !previous ||
        gap > line.size * 1.8 ||
        (previous.right - previous.left < bodyWidth * 0.82 &&
          /[.!?"'”’]$/.test(previous.text.trim()));

      if (startsParagraph && current) {
        flush();
      }

      if (HYPHENS.test(current) && /^[a-zß-ÿ]/.test(text)) {
        // A word broken across lines is rejoined, hyphen and all.
        current = current.replace(HYPHENS, '') + text;
      } else {
        current = current ? `${current} ${text}` : text;
      }
    }
  }

  flush();
  return blocks;
}

function buildEpub(
  blocks: Block[],
  title: string,
  creator: string,
  cover: Uint8Array<ArrayBuffer> | null,
) {
  const sections: string[][] = [[]];
  const headings: string[] = [title];
  let length = 0;

  for (const block of blocks) {
    const current = sections[sections.length - 1];
    const isNewSection =
      (block.kind === 'heading' && current.length > 0) ||
      length > SECTION_LIMIT;
    if (isNewSection) {
      sections.push([]);
      headings.push(block.kind === 'heading' ? block.text : '…');
      length = 0;
    } else if (block.kind === 'heading' && current.length === 0) {
      // A section that opens with its own heading is named after it.
      headings[sections.length - 1] = block.text;
    }
    sections[sections.length - 1].push(
      block.kind === 'heading'
        ? `<h2>${escapeXml(block.text)}</h2>`
        : `<p>${escapeXml(block.text)}</p>`,
    );
    length += block.text.length;
  }

  const files: ZipEntry[] = [
    { path: 'mimetype', data: 'application/epub+zip' },
    {
      path: 'META-INF/container.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
    },
  ];

  sections.forEach((section, index) => {
    files.push({
      path: `OEBPS/section${index + 1}.xhtml`,
      data: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escapeXml(
        headings[index] ?? title,
      )}</title></head>
<body>${section.join('\n') || '<p/>'}</body></html>`,
    });
  });

  if (cover) {
    files.push({ path: 'OEBPS/cover.jpg', data: cover });
  }

  const manifest = sections
    .map(
      (_, index) =>
        `<item id="s${index + 1}" href="section${
          index + 1
        }.xhtml" media-type="application/xhtml+xml"/>`,
    )
    .join('\n    ');
  const spine = sections
    .map((_, index) => `<itemref idref="s${index + 1}"/>`)
    .join('\n    ');
  const navItems = sections
    .map(
      (_, index) =>
        `<li><a href="section${index + 1}.xhtml">${escapeXml(
          headings[index] ?? `Part ${index + 1}`,
        )}</a></li>`,
    )
    .join('\n      ');

  files.push({
    path: 'OEBPS/nav.xhtml',
    data: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${escapeXml(
      title,
    )}</title></head>
<body><nav epub:type="toc" id="toc"><ol>
      ${navItems}
</ol></nav></body></html>`,
  });

  files.push({
    path: 'OEBPS/content.opf',
    data: `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">pdf-${Date.now()}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:creator>${escapeXml(creator)}</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${new Date()
      .toISOString()
      .replace(/\.\d+Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${
      cover
        ? '<item id="cover" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>'
        : ''
    }
    ${manifest}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`,
  });

  return createZip(files);
}

/**
 * PDF titles are routinely the exporter's scratch name rather than the book's:
 * "about:blank", "Microsoft Word - draft3.doc", an untouched template. Fall
 * back to the file name when the metadata is obviously not a title.
 */
export function cleanTitle(raw: string | undefined, fileName: string) {
  const fromFile = fileName
    .replace(/\.pdf$/i, '')
    .replace(/_+/g, ' ')
    .trim();
  const value = (raw ?? '')
    .replace(/^microsoft word\s*-\s*/i, '')
    .replace(/\.(docx?|pdf|indd|tex|pages)$/i, '')
    .trim();

  const unusable =
    value.length < 2 ||
    /^(untitled|unknown|document|new document|presentation)$/i.test(value) ||
    /^about:/i.test(value) ||
    value.includes('/') ||
    value.includes(String.fromCharCode(92));

  return unusable ? fromFile || 'Untitled' : value;
}

/** Read a PDF and hand back an EPUB built from whatever text it holds. */
export async function importPdf(
  source: File,
  onProgress?: (done: number, total: number) => void,
): Promise<PdfImportResult> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();

  const document = await pdfjs.getDocument({
    data: new Uint8Array(await source.arrayBuffer()),
  }).promise;

  const pages: Line[][] = [];
  let columnPages = 0;

  for (let number = 1; number <= document.numPages; number += 1) {
    const page = await document.getPage(number);
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });
    const split = pageLines(content.items as Item[], viewport.width);
    if (split.columns > 1) {
      columnPages += 1;
    }
    pages.push(split.lines);
    page.cleanup();
    onProgress?.(number, document.numPages);
  }

  const characters = pages
    .flat()
    .reduce((total, line) => total + line.text.trim().length, 0);
  if (characters < document.numPages * 40) {
    throw new PdfTextMissingError();
  }

  const blocks = toBlocks(stripRunningTitles(pages));

  const metadata = await document.getMetadata().catch(() => null);
  const info = (metadata?.info ?? {}) as { Title?: string; Author?: string };
  const title = cleanTitle(info.Title, source.name);
  const creator = info.Author?.trim() || 'Unknown author';

  // The first page makes a serviceable cover.
  let cover: Blob | null = null;
  try {
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale: 1.4 });
    const canvas = window.document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext('2d');
    if (context) {
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      cover = await new Promise<Blob | null>(resolve =>
        canvas.toBlob(resolve, 'image/jpeg', 0.82),
      );
    }
  } catch {
    // A missing cover costs nothing.
  }

  const warnings: PdfImportWarning[] = [];
  if (columnPages > document.numPages * 0.3) {
    warnings.push('columns');
  }
  if (characters < document.numPages * 400) {
    warnings.push('sparse');
  }

  const epub = buildEpub(
    blocks,
    title,
    creator,
    cover ? new Uint8Array<ArrayBuffer>(await cover.arrayBuffer()) : null,
  );
  const name = `${source.name.replace(/\.pdf$/i, '')}.epub`;
  const pageCount = document.numPages;

  return {
    file: new File([epub], name, { type: 'application/epub+zip' }),
    cover,
    title,
    creator,
    pages: pageCount,
    warnings,
  };
}
