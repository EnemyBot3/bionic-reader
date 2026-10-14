import { beforeEach, describe, expect, it } from 'vitest';

import {
  getBookKey,
  getBookmarks,
  getSavedPosition,
  getUpdatedAt,
  listStoredBookKeys,
  markUpdated,
  savePosition,
} from './storage';

const asFile = (name: string, size: number, lastModified: number) =>
  ({ name, size, lastModified } as File);

describe('getBookKey', () => {
  it('ignores the filesystem timestamp, which differs per device', () => {
    const here = asFile('golden.epub', 2_000, 1_000);
    const there = asFile('golden.epub', 2_000, 9_999);

    expect(getBookKey(here)).toBe(getBookKey(there));
  });

  it('separates different books with the same name', () => {
    expect(getBookKey(asFile('book.epub', 10, 1))).not.toBe(
      getBookKey(asFile('book.epub', 20, 1)),
    );
  });
});

describe('reading state', () => {
  beforeEach(() => window.localStorage.clear());

  const position = (cfi: string, updatedAt: number) => ({
    cfi,
    href: 'ch1.xhtml',
    chapter: 'One',
    progress: 0.25,
    updatedAt,
  });

  it('keeps a position and stamps when it was written', () => {
    savePosition('book', position('epubcfi(/6/4)', 4_000));

    expect(getSavedPosition('book')?.cfi).toBe('epubcfi(/6/4)');
    expect(getUpdatedAt('bionic-reader:position:book')).toBe(4_000);
  });

  it('lists every book it holds state for', () => {
    savePosition('one', position('a', 1));
    savePosition('two', position('b', 2));

    expect(listStoredBookKeys().sort()).toEqual(['one', 'two']);
  });

  it('adopts an entry saved under the old timestamped key', () => {
    // Written by a build whose keys still carried the file's timestamp.
    window.localStorage.setItem(
      'bionic-reader:position:golden.epub:2000:1699999999',
      JSON.stringify(position('epubcfi(/6/20)', 7_000)),
    );

    const adopted = getSavedPosition('golden.epub:2000');

    expect(adopted?.cfi).toBe('epubcfi(/6/20)');
    expect(
      window.localStorage.getItem('bionic-reader:position:golden.epub:2000'),
    ).toBeTruthy();
    expect(
      window.localStorage.getItem(
        'bionic-reader:position:golden.epub:2000:1699999999',
      ),
    ).toBeNull();
  });

  it('returns nothing rather than throwing on damaged storage', () => {
    window.localStorage.setItem('bionic-reader:position:book', '{ not json');
    window.localStorage.setItem('bionic-reader:bookmarks:book', 'also not');

    expect(getSavedPosition('book')).toBeNull();
    expect(getBookmarks('book')).toEqual([]);
  });

  it('remembers the newest stamp for a key', () => {
    markUpdated('key', 100);
    markUpdated('key', 250);

    expect(getUpdatedAt('key')).toBe(250);
  });
});
