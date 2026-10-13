/**
 * The document that travels between devices.
 *
 * Every entry carries the moment it was written, and a merge simply keeps the
 * newer side. That is enough for one reader on several devices, which is what
 * this is for; it is not a general purpose replication scheme.
 */

import {
  DriveAuthError,
  readDriveBlob,
  readDriveJson,
  writeDriveBlob,
  writeDriveJson,
} from './googleDrive';
import {
  applyRemoteSettings,
  getSettingsUpdatedAt,
  loadReaderSettings,
  normalizeSettings,
  type ReaderSettings,
} from './readerSettings';
import {
  applyRemoteEntry,
  getEntryUpdatedAt,
  getStoredEntry,
  listStoredBookKeys,
  saveDownloadedBook,
  storedBookToFile,
  type SavedBookmark,
  type SavedPosition,
  type StoredBook,
} from './storage';

const STATE_FILE = 'reading-state.json';
const SNAPSHOT_VERSION = 2;
// Books past this size are left on the device rather than quietly eating the
// account's storage.
const MAX_BOOK_SIZE = 80 * 1024 * 1024;

type Timed<T> = { value: T; updatedAt: number };

type BookState = {
  position?: Timed<SavedPosition>;
  bookmarks?: Timed<SavedBookmark[]>;
};

/** A book held in Drive, as the slices it was uploaded in. */
export type LibraryEntry = {
  title: string;
  creator: string;
  fileName: string;
  fileType: string;
  size: number;
  lastModified: number;
  slices: string[];
  updatedAt: number;
};

export type SyncSnapshot = {
  version: number;
  settings?: Timed<ReaderSettings>;
  books: Record<string, BookState>;
  library?: Record<string, LibraryEntry>;
};

function newer<T>(left?: Timed<T>, right?: Timed<T>) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return right.updatedAt > left.updatedAt ? right : left;
}

export function collectSnapshot(): SyncSnapshot {
  const books: Record<string, BookState> = {};

  for (const bookKey of listStoredBookKeys()) {
    const position = getStoredEntry<SavedPosition>('position', bookKey);
    const bookmarks = getStoredEntry<SavedBookmark[]>('bookmarks', bookKey);
    const state: BookState = {};

    if (position) {
      state.position = {
        value: position,
        updatedAt:
          getEntryUpdatedAt('position', bookKey) || position.updatedAt || 0,
      };
    }
    if (bookmarks) {
      state.bookmarks = {
        value: bookmarks,
        updatedAt: getEntryUpdatedAt('bookmarks', bookKey),
      };
    }
    if (state.position || state.bookmarks) {
      books[bookKey] = state;
    }
  }

  const settingsUpdatedAt = getSettingsUpdatedAt();
  return {
    version: SNAPSHOT_VERSION,
    books,
    ...(settingsUpdatedAt
      ? {
          settings: {
            value: loadReaderSettings(),
            updatedAt: settingsUpdatedAt,
          },
        }
      : {}),
  };
}

export function mergeSnapshots(
  local: SyncSnapshot,
  remote: SyncSnapshot | null,
): SyncSnapshot {
  // An older snapshot simply has no library yet; a newer one is left alone.
  if (!remote || remote.version > SNAPSHOT_VERSION) {
    return local;
  }

  const books: Record<string, BookState> = {};
  for (const bookKey of new Set([
    ...Object.keys(local.books ?? {}),
    ...Object.keys(remote.books ?? {}),
  ])) {
    const mine = local.books?.[bookKey] ?? {};
    const theirs = remote.books?.[bookKey] ?? {};
    const merged: BookState = {};
    const position = newer(mine.position, theirs.position);
    const bookmarks = newer(mine.bookmarks, theirs.bookmarks);
    if (position) {
      merged.position = position;
    }
    if (bookmarks) {
      merged.bookmarks = bookmarks;
    }
    books[bookKey] = merged;
  }

  const library: Record<string, LibraryEntry> = {};
  for (const bookKey of new Set([
    ...Object.keys(local.library ?? {}),
    ...Object.keys(remote.library ?? {}),
  ])) {
    const mine = local.library?.[bookKey];
    const theirs = remote.library?.[bookKey];
    const entry =
      !mine || (theirs && theirs.updatedAt > mine.updatedAt) ? theirs : mine;
    if (entry) {
      library[bookKey] = entry;
    }
  }

  const settings = newer(local.settings, remote.settings);
  return {
    version: SNAPSHOT_VERSION,
    books,
    ...(Object.keys(library).length > 0 ? { library } : {}),
    ...(settings ? { settings } : {}),
  };
}

/** Write anything the merge decided came from elsewhere into local storage. */
export function applySnapshot(local: SyncSnapshot, merged: SyncSnapshot) {
  let settingsChanged = false;

  if (
    merged.settings &&
    merged.settings.updatedAt > (local.settings?.updatedAt ?? 0)
  ) {
    applyRemoteSettings(
      normalizeSettings(merged.settings.value),
      merged.settings.updatedAt,
    );
    settingsChanged = true;
  }

  const books: string[] = [];
  for (const [bookKey, state] of Object.entries(merged.books ?? {})) {
    const mine = local.books?.[bookKey];
    let changed = false;

    if (
      state.position &&
      state.position.updatedAt > (mine?.position?.updatedAt ?? 0)
    ) {
      applyRemoteEntry(
        'position',
        bookKey,
        state.position.value,
        state.position.updatedAt,
      );
      changed = true;
    }
    if (
      state.bookmarks &&
      state.bookmarks.updatedAt > (mine?.bookmarks?.updatedAt ?? 0)
    ) {
      applyRemoteEntry(
        'bookmarks',
        bookKey,
        state.bookmarks.value,
        state.bookmarks.updatedAt,
      );
      changed = true;
    }
    if (changed) {
      books.push(bookKey);
    }
  }

  return { settingsChanged, books };
}

export type SyncResult = {
  settingsChanged: boolean;
  books: string[];
  uploaded: string[];
  library: Record<string, LibraryEntry>;
  pushed: boolean;
};

/**
 * One full exchange: read what Drive has, merge, write back what it is missing.
 */
export async function syncWithDrive(
  localBooks: StoredBook[] = [],
): Promise<SyncResult> {
  const local = collectSnapshot();
  const remote = await readDriveJson<SyncSnapshot>(STATE_FILE);
  const merged = mergeSnapshots(local, remote);
  const applied = applySnapshot(local, merged);

  // Anything this device has read but the account has never seen goes up.
  const library = { ...(merged.library ?? {}) };
  const uploaded: string[] = [];
  for (const book of localBooks) {
    if (library[book.id] || !book.blob || book.blob.size > MAX_BOOK_SIZE) {
      continue;
    }
    const slices = await writeDriveBlob(book.fileName, book.blob);
    library[book.id] = {
      title: book.title,
      creator: book.creator,
      fileName: book.fileName,
      fileType: book.fileType,
      size: book.blob.size,
      lastModified: book.lastModified,
      slices,
      updatedAt: Date.now(),
    };
    uploaded.push(book.id);
  }

  const complete: SyncSnapshot = {
    ...merged,
    ...(Object.keys(library).length > 0 ? { library } : {}),
  };
  const pushed = JSON.stringify(complete) !== JSON.stringify(remote);
  if (pushed) {
    await writeDriveJson(STATE_FILE, complete);
  }

  return { ...applied, uploaded, library, pushed };
}

/** Pull a book the account has but this device does not. */
export async function downloadBook(bookKey: string, entry: LibraryEntry) {
  const blob = await readDriveBlob(entry.slices, entry.fileType);
  const book = {
    id: bookKey,
    blob,
    fileName: entry.fileName,
    fileType: entry.fileType,
    lastModified: entry.lastModified,
    title: entry.title,
    creator: entry.creator,
  };
  await saveDownloadedBook(book);
  return storedBookToFile({ ...book, updatedAt: Date.now() });
}

export { DriveAuthError };
