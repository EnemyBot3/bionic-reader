import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  mergeSnapshots,
  type LibraryEntry,
  type SyncSnapshot,
} from './syncState';

const empty: SyncSnapshot = { version: 2, books: {} };

const position = (cfi: string, at: number) => ({
  value: {
    cfi,
    href: 'ch1.xhtml',
    chapter: 'One',
    progress: 0.5,
    updatedAt: at,
  },
  updatedAt: at,
});

const entry = (overrides: Partial<LibraryEntry> = {}): LibraryEntry => ({
  title: 'Golden Son',
  creator: 'Pierce Brown',
  fileName: 'golden.epub',
  fileType: 'application/epub+zip',
  size: 2_000_000,
  lastModified: 1,
  slices: ['slice-1'],
  updatedAt: 1_000,
  ...overrides,
});

describe('mergeSnapshots', () => {
  it('keeps whichever side wrote last', () => {
    const local: SyncSnapshot = {
      version: 2,
      books: { book: { position: position('local', 200) } },
    };
    const remote: SyncSnapshot = {
      version: 2,
      books: { book: { position: position('remote', 100) } },
    };

    expect(mergeSnapshots(local, remote).books.book.position?.value.cfi).toBe(
      'local',
    );
    expect(mergeSnapshots(remote, local).books.book.position?.value.cfi).toBe(
      'local',
    );
  });

  it('takes books the other device has and this one does not', () => {
    const remote: SyncSnapshot = {
      version: 2,
      books: { other: { position: position('remote', 10) } },
    };

    expect(Object.keys(mergeSnapshots(empty, remote).books)).toEqual(['other']);
  });

  it('merges position and bookmarks independently', () => {
    const local: SyncSnapshot = {
      version: 2,
      books: {
        book: {
          position: position('local', 300),
          bookmarks: { value: [], updatedAt: 1 },
        },
      },
    };
    const remote: SyncSnapshot = {
      version: 2,
      books: {
        book: {
          position: position('remote', 5),
          bookmarks: {
            value: [
              {
                id: 'a',
                cfi: 'x',
                href: 'h',
                chapter: 'c',
                progress: 0.1,
                createdAt: 1,
              },
            ],
            updatedAt: 900,
          },
        },
      },
    };

    const merged = mergeSnapshots(local, remote).books.book;
    expect(merged.position?.value.cfi).toBe('local');
    expect(merged.bookmarks?.value).toHaveLength(1);
  });

  it('accepts a snapshot written before the library existed', () => {
    const remote = {
      version: 1,
      books: { book: { position: position('remote', 50) } },
    } as SyncSnapshot;

    expect(mergeSnapshots(empty, remote).books.book).toBeDefined();
  });

  it('leaves a snapshot from a newer version of the reader alone', () => {
    const remote = { version: 99, books: {} } as SyncSnapshot;
    const local: SyncSnapshot = {
      version: 2,
      books: { book: { position: position('local', 1) } },
    };

    expect(mergeSnapshots(local, remote)).toBe(local);
  });

  it('prefers the newer library entry, tombstone or not', () => {
    const local: SyncSnapshot = {
      version: 2,
      books: {},
      library: { book: entry({ title: 'Old name', updatedAt: 10 }) },
    };
    const remote: SyncSnapshot = {
      version: 2,
      books: {},
      library: { book: entry({ title: 'New name', updatedAt: 20 }) },
    };

    expect(mergeSnapshots(local, remote).library?.book.title).toBe('New name');
  });
});

// The upload half of a sync is where deletion and re-adding fight, so it is
// driven directly with the Drive and storage layers replaced.
const drive = vi.hoisted(() => ({
  readDriveJson: vi.fn(),
  writeDriveJson: vi.fn(),
  writeDriveBlob: vi.fn(),
  readDriveBlob: vi.fn(),
  deleteDriveFiles: vi.fn(),
}));
const store = vi.hoisted(() => ({ deleteBook: vi.fn() }));

vi.mock('./googleDrive', () => ({
  ...drive,
  DriveAuthError: class extends Error {},
}));

vi.mock('./storage', async importActual => {
  const actual = await importActual<typeof import('./storage')>();
  return { ...actual, deleteBook: store.deleteBook, saveCover: vi.fn() };
});

const book = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'book',
    blob: new Blob(['x']),
    cover: null,
    fileName: 'golden.epub',
    fileType: 'application/epub+zip',
    lastModified: 1,
    title: 'Golden Son',
    creator: 'Pierce Brown',
    updatedAt: 5_000,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

describe('syncWithDrive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    drive.writeDriveBlob.mockResolvedValue(['new-slice']);
    drive.writeDriveJson.mockResolvedValue(undefined);
    drive.deleteDriveFiles.mockResolvedValue(undefined);
  });

  const pushed = () =>
    drive.writeDriveJson.mock.calls.at(-1)?.[1] as SyncSnapshot;

  it('uploads a book the account has never seen', async () => {
    const { syncWithDrive } = await import('./syncState');
    drive.readDriveJson.mockResolvedValue(null);

    const result = await syncWithDrive([book()]);

    expect(result.uploaded).toEqual(['book']);
    expect(pushed().library?.book.slices).toEqual(['new-slice']);
  });

  it('does not upload a book the account already holds', async () => {
    const { syncWithDrive } = await import('./syncState');
    drive.readDriveJson.mockResolvedValue({
      version: 2,
      books: {},
      library: { book: entry() },
    });

    const result = await syncWithDrive([book()]);

    expect(result.uploaded).toEqual([]);
    expect(drive.writeDriveBlob).not.toHaveBeenCalled();
  });

  it('removes a local copy older than the deletion', async () => {
    const { syncWithDrive } = await import('./syncState');
    drive.readDriveJson.mockResolvedValue({
      version: 2,
      books: {},
      library: {
        book: entry({ slices: [], deletedAt: 9_000, updatedAt: 9_000 }),
      },
    });

    const result = await syncWithDrive([book({ updatedAt: 5_000 })]);

    expect(store.deleteBook).toHaveBeenCalledWith('book');
    expect(result.removed).toEqual(['book']);
  });

  it('keeps a book added back after it was deleted, and clears the tombstone', async () => {
    const { syncWithDrive } = await import('./syncState');
    drive.readDriveJson.mockResolvedValue({
      version: 2,
      books: {},
      library: {
        book: entry({ slices: [], deletedAt: 9_000, updatedAt: 9_000 }),
      },
    });

    // Added back after the deletion, so this copy is the newer fact.
    const result = await syncWithDrive([book({ updatedAt: 12_000 })]);

    expect(store.deleteBook).not.toHaveBeenCalled();
    expect(result.uploaded).toEqual(['book']);
    expect(pushed().library?.book.deletedAt).toBeUndefined();
    expect(pushed().library?.book.slices).toEqual(['new-slice']);
  });

  it('carries a hand edit up to the account', async () => {
    const { syncWithDrive } = await import('./syncState');
    drive.readDriveJson.mockResolvedValue({
      version: 2,
      books: {},
      library: { book: entry({ title: 'Old name', updatedAt: 1_000 }) },
    });

    await syncWithDrive([book({ title: 'Golden Son', editedAt: 4_000 })]);

    expect(pushed().library?.book.title).toBe('Golden Son');
    expect(pushed().library?.book.updatedAt).toBe(4_000);
  });

  it('writes nothing when there is nothing to say', async () => {
    const { syncWithDrive } = await import('./syncState');
    const remote = { version: 2, books: {}, library: { book: entry() } };
    drive.readDriveJson.mockResolvedValue(remote);

    const result = await syncWithDrive([book()]);

    expect(result.pushed).toBe(false);
    expect(drive.writeDriveJson).not.toHaveBeenCalled();
  });
});
