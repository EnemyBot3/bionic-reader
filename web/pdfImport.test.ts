import { describe, expect, it } from 'vitest';

import {
  cleanTitle,
  pageLines,
  stripRunningTitles,
  toBlocks,
} from './pdfImport';

/** A text run as PDF.js reports one: text, a transform, a size and a width. */
const run = (str: string, x: number, y: number, size = 11, width?: number) => ({
  str,
  transform: [size, 0, 0, size, x, y],
  height: size,
  width: width ?? str.length * size * 0.5,
});

const line = (text: string, top: number, left = 60, size = 11) => ({
  text,
  left,
  right: left + text.length * size * 0.5,
  top,
  size,
});

describe('cleanTitle', () => {
  it('keeps a real title', () => {
    expect(cleanTitle('Golden Son', 'whatever.pdf')).toBe('Golden Son');
  });

  it('falls back to the file name for an exporter artefact', () => {
    expect(cleanTitle('about:blank', 'Golden Son.pdf')).toBe('Golden Son');
    expect(cleanTitle('untitled', 'Golden Son.pdf')).toBe('Golden Son');
    expect(cleanTitle(undefined, 'Golden Son.pdf')).toBe('Golden Son');
    expect(cleanTitle('', 'Golden Son.pdf')).toBe('Golden Son');
  });

  it('unwraps a word processor name', () => {
    expect(cleanTitle('Microsoft Word - Golden Son.doc', 'x.pdf')).toBe(
      'Golden Son',
    );
  });

  it('rejects anything that is really a path', () => {
    expect(cleanTitle('C:/books/draft.pdf', 'Golden Son.pdf')).toBe(
      'Golden Son',
    );
  });

  it('tidies underscores in a file name', () => {
    expect(cleanTitle(undefined, 'golden_son_final.pdf')).toBe(
      'golden son final',
    );
  });
});

describe('pageLines', () => {
  it('reads a single column down the page', () => {
    const items = [
      run('First line', 60, 700),
      run('Second line', 60, 680),
      run('Third line', 60, 660),
    ];

    const result = pageLines(items, 600);
    expect(result.columns).toBe(1);
    expect(result.lines.map(l => l.text)).toEqual([
      'First line',
      'Second line',
      'Third line',
    ]);
  });

  it('reads two columns one after the other, not across the gutter', () => {
    // Left and right columns share baselines, which is exactly the case that
    // interleaves if lines are joined before the columns are separated.
    const items = [];
    for (let row = 0; row < 12; row += 1) {
      const y = 700 - row * 20;
      items.push(run(`left ${row}`, 50, y, 11, 200));
      items.push(run(`right ${row}`, 320, y, 11, 200));
    }

    const result = pageLines(items, 600);

    expect(result.columns).toBe(2);
    const text = result.lines.map(l => l.text);
    expect(text.slice(0, 12)).toEqual(
      Array.from({ length: 12 }, (_, row) => `left ${row}`),
    );
    expect(text.slice(12)).toEqual(
      Array.from({ length: 12 }, (_, row) => `right ${row}`),
    );
    // Nothing from the right column leaked into a left column line.
    expect(
      text.some(value => value.includes('left') && value.includes('right')),
    ).toBe(false);
  });

  it('puts a line spanning the gutter above both columns', () => {
    const items = [run('A Title Across The Page', 50, 760, 16, 500)];
    for (let row = 0; row < 12; row += 1) {
      const y = 700 - row * 20;
      items.push(run(`left ${row}`, 50, y, 11, 200));
      items.push(run(`right ${row}`, 320, y, 11, 200));
    }

    const result = pageLines(items, 600);
    expect(result.columns).toBe(2);
    expect(result.lines[0].text).toBe('A Title Across The Page');
  });
});

describe('stripRunningTitles', () => {
  it('drops a header repeated on every page and the page numbers', () => {
    const pages = Array.from({ length: 5 }, (_, index) => [
      line('THE LIGHTHOUSE AT CALDER POINT', 800),
      line('Body text of the page.', 700),
      line(String(index + 1), 40),
    ]);

    const stripped = stripRunningTitles(pages);

    expect(stripped.every(page => page.length === 1)).toBe(true);
    expect(stripped[0][0].text).toBe('Body text of the page.');
  });

  it('leaves a heading that only appears once', () => {
    const pages = [
      [line('Chapter One', 800), line('Body.', 700)],
      [line('Body.', 800), line('More body.', 700)],
      [line('Body.', 800), line('More body.', 700)],
    ];

    expect(stripRunningTitles(pages)[0][0].text).toBe('Chapter One');
  });
});

describe('toBlocks', () => {
  it('joins lines of a paragraph and rejoins a split word', () => {
    const blocks = toBlocks([
      [
        line('The lighthouse keeper watched the light-', 700),
        line('house fade into the evening fog.', 682),
      ],
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe(
      'The lighthouse keeper watched the lighthouse fade into the evening fog.',
    );
  });

  it('starts a paragraph after a wide vertical gap', () => {
    const blocks = toBlocks([
      [
        line('First paragraph running to the margin.', 700),
        line('Second paragraph after a gap.', 640),
      ],
    ]);

    expect(blocks.map(block => block.text)).toEqual([
      'First paragraph running to the margin.',
      'Second paragraph after a gap.',
    ]);
  });

  it('treats a short, larger line as a heading', () => {
    // The body size is the median line size, so the page needs a body.
    const body = Array.from({ length: 8 }, (_, row) =>
      line(
        `Body line ${row} running on to the margin of the page.`,
        700 - row * 18,
      ),
    );
    const blocks = toBlocks([[line('One. The Keeper', 760, 60, 17), ...body]]);

    expect(blocks[0]).toEqual({ kind: 'heading', text: 'One. The Keeper' });
    expect(blocks[1].kind).toBe('paragraph');
  });

  it('keeps a hyphen that belongs to the word', () => {
    const blocks = toBlocks([
      [line('She climbed the ninety-', 700), line('Three steps slowly.', 682)],
    ]);

    // The next line starts with a capital, so this is a real hyphen.
    expect(blocks[0].text).toContain('ninety- Three');
  });
});
