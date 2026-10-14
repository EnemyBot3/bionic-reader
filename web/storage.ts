export type SavedPosition = {
  cfi: string;
  href: string;
  chapter: string;
  progress: number;
  updatedAt: number;
};

export type SavedBookmark = {
  id: string;
  cfi: string;
  href: string;
  chapter: string;
  progress: number;
  createdAt: number;
};

/** A passage marked in a book, with an optional note attached to it. */
export type SavedHighlight = {
  id: string;
  /** An EPUB CFI range covering the passage. */
  cfiRange: string;
  text: string;
  note: string;
  colour: HighlightColour;
  chapter: string;
  progress: number;
  createdAt: number;
};

export const HIGHLIGHT_COLOURS = ['yellow', 'green', 'blue', 'pink'] as const;

export type HighlightColour = (typeof HIGHLIGHT_COLOURS)[number];

export type StoredBook = {
  /** The book key, so a book can be found again from its file or the manifest. */
  id: string;
  blob: Blob;
  /** The publisher's cover, lifted out the first time the book was opened. */
  cover?: Blob | null;
  fileName: string;
  fileType: string;
  lastModified: number;
  title: string;
  creator: string;
  updatedAt: number;
  /** When the reader last edited the title, author or cover by hand. */
  editedAt?: number;
};

const DATABASE_NAME = 'bionic-reader-library';
const DATABASE_VERSION = 3;
const BOOK_STORE = 'books';
const COVER_STORE = 'covers';

export function getBookKey(file: File) {
  // The same book copied to a second device keeps its name and size but gets a
  // fresh filesystem timestamp, so the timestamp cannot be part of a key that
  // has to match across devices.
  return `${file.name}:${file.size}`;
}

type StoredKind = 'position' | 'bookmarks' | 'highlights';

function storageKey(kind: StoredKind, bookKey: string) {
  return `bionic-reader:${kind}:${bookKey}`;
}

// Timestamps for everything that syncs, so the newer of two devices wins.
const UPDATED_KEY = 'bionic-reader:updated:v1';

function readUpdatedMap(): Record<string, number> {
  try {
    const value = window.localStorage.getItem(UPDATED_KEY);
    return value ? (JSON.parse(value) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function markUpdated(key: string, at = Date.now()) {
  try {
    const map = readUpdatedMap();
    map[key] = at;
    window.localStorage.setItem(UPDATED_KEY, JSON.stringify(map));
  } catch {
    // Without a timestamp the entry simply loses the next merge.
  }
}

export function getUpdatedAt(key: string) {
  return readUpdatedMap()[key] ?? 0;
}

/** Every book this device holds a position or bookmarks for. */
export function listStoredBookKeys() {
  const keys = new Set<string>();
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    for (const kind of [
      'position',
      'bookmarks',
      'highlights',
    ] as StoredKind[]) {
      const prefix = `bionic-reader:${kind}:`;
      if (key?.startsWith(prefix)) {
        keys.add(key.slice(prefix.length));
      }
    }
  }
  return [...keys];
}

/**
 * Book keys used to include the file's timestamp. Adopt an older entry for the
 * same file the first time its book is opened.
 */
function adoptLegacyEntry(kind: StoredKind, bookKey: string) {
  const prefix = `${storageKey(kind, bookKey)}:`;
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key?.startsWith(prefix)) {
      continue;
    }
    const value = window.localStorage.getItem(key);
    if (value) {
      window.localStorage.setItem(storageKey(kind, bookKey), value);
      window.localStorage.removeItem(key);
      markUpdated(storageKey(kind, bookKey));
      return value;
    }
  }
  return null;
}

export function getSavedPosition(bookKey: string): SavedPosition | null {
  try {
    const key = storageKey('position', bookKey);
    const value =
      window.localStorage.getItem(key) ?? adoptLegacyEntry('position', bookKey);
    return value ? (JSON.parse(value) as SavedPosition) : null;
  } catch {
    return null;
  }
}

export function savePosition(bookKey: string, position: SavedPosition) {
  try {
    const key = storageKey('position', bookKey);
    window.localStorage.setItem(key, JSON.stringify(position));
    markUpdated(key, position.updatedAt);
  } catch {
    // Position persistence is optional.
  }
}

// Indexing a 500+ page book takes seconds, so the result is kept for the next
// session. Only the most recent book is cached to keep local storage small.
const LOCATIONS_KEY = 'bionic-reader:locations';

export function loadLocations(bookKey: string): string | null {
  try {
    const value = window.localStorage.getItem(LOCATIONS_KEY);
    if (!value) {
      return null;
    }
    const cached = JSON.parse(value) as { bookKey: string; locations: string };
    return cached.bookKey === bookKey ? cached.locations : null;
  } catch {
    return null;
  }
}

export function saveLocations(bookKey: string, locations: string) {
  try {
    window.localStorage.setItem(
      LOCATIONS_KEY,
      JSON.stringify({ bookKey, locations }),
    );
  } catch {
    // The index is rebuilt next time when it does not fit in local storage.
  }
}

export function getBookmarks(bookKey: string): SavedBookmark[] {
  try {
    const key = storageKey('bookmarks', bookKey);
    const value =
      window.localStorage.getItem(key) ??
      adoptLegacyEntry('bookmarks', bookKey);
    return value ? (JSON.parse(value) as SavedBookmark[]) : [];
  } catch {
    return [];
  }
}

export function saveBookmarks(bookKey: string, bookmarks: SavedBookmark[]) {
  try {
    const key = storageKey('bookmarks', bookKey);
    window.localStorage.setItem(key, JSON.stringify(bookmarks));
    markUpdated(key);
  } catch {
    // Bookmarks remain available for the current session.
  }
}

export function getHighlights(bookKey: string): SavedHighlight[] {
  try {
    const key = storageKey('highlights', bookKey);
    const value =
      window.localStorage.getItem(key) ??
      adoptLegacyEntry('highlights', bookKey);
    return value ? (JSON.parse(value) as SavedHighlight[]) : [];
  } catch {
    return [];
  }
}

export function saveHighlights(bookKey: string, highlights: SavedHighlight[]) {
  try {
    const key = storageKey('highlights', bookKey);
    window.localStorage.setItem(key, JSON.stringify(highlights));
    markUpdated(key);
  } catch {
    // Highlights remain available for the current session.
  }
}

/** Write an entry that arrived from another device. */
export function applyRemoteEntry(
  kind: StoredKind,
  bookKey: string,
  value: unknown,
  updatedAt: number,
) {
  try {
    const key = storageKey(kind, bookKey);
    window.localStorage.setItem(key, JSON.stringify(value));
    markUpdated(key, updatedAt);
  } catch {
    // The next sync tries again.
  }
}

export function getStoredEntry<T>(kind: StoredKind, bookKey: string) {
  try {
    const value = window.localStorage.getItem(storageKey(kind, bookKey));
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
}

export function getEntryUpdatedAt(kind: StoredKind, bookKey: string) {
  return getUpdatedAt(storageKey(kind, bookKey));
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      // Covers for books the account holds but this device has not downloaded.
      if (!database.objectStoreNames.contains(COVER_STORE)) {
        database.createObjectStore(COVER_STORE, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(BOOK_STORE)) {
        database.createObjectStore(BOOK_STORE, { keyPath: 'id' });
        return;
      }

      // Version 1 held a single book under the key 'recent'. Re-key it so it
      // joins the library instead of being overwritten by the next book.
      const store = request.transaction?.objectStore(BOOK_STORE);
      const legacy = store?.get('recent');
      if (!legacy) {
        return;
      }
      legacy.onsuccess = () => {
        const book = legacy.result as StoredBook | undefined;
        if (!book?.blob) {
          return;
        }
        store?.delete('recent');
        store?.put({
          ...book,
          id: `${book.fileName}:${book.blob.size}`,
        } satisfies StoredBook);
      };
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('Could not open local book storage.'));
  });
}

export async function saveBook(
  file: File,
  title: string,
  creator: string,
  cover?: Blob | null,
) {
  if (!('indexedDB' in window)) {
    return;
  }

  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(BOOK_STORE, 'readwrite');
      transaction.objectStore(BOOK_STORE).put({
        id: getBookKey(file),
        blob: file,
        cover: cover ?? null,
        fileName: file.name,
        fileType: file.type || 'application/epub+zip',
        lastModified: file.lastModified,
        title,
        creator,
        updatedAt: Date.now(),
      } satisfies StoredBook);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('Could not save the book.'));
    });
  } finally {
    database.close();
  }
}

/** Store a book that arrived from another device. */
export async function saveDownloadedBook(book: Omit<StoredBook, 'updatedAt'>) {
  if (!('indexedDB' in window)) {
    return;
  }

  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(BOOK_STORE, 'readwrite');
      transaction
        .objectStore(BOOK_STORE)
        .put({ ...book, updatedAt: Date.now() } satisfies StoredBook);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('Could not save the book.'));
    });
  } finally {
    database.close();
  }
}

/** Apply a hand edit to a book and mark it for the next sync. */
export async function updateBook(
  bookKey: string,
  patch: Partial<Pick<StoredBook, 'title' | 'creator' | 'cover'>>,
) {
  const book = await loadBook(bookKey);
  if (!book) {
    return null;
  }

  const next: StoredBook = { ...book, ...patch, editedAt: Date.now() };
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(BOOK_STORE, 'readwrite');
      transaction.objectStore(BOOK_STORE).put(next);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('Could not save the book.'));
    });
  } finally {
    database.close();
  }
  return next;
}

/** Remove a book and its cover from this device. */
export async function deleteBook(bookKey: string) {
  if (!('indexedDB' in window)) {
    return;
  }

  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        [BOOK_STORE, COVER_STORE],
        'readwrite',
      );
      transaction.objectStore(BOOK_STORE).delete(bookKey);
      transaction.objectStore(COVER_STORE).delete(bookKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('Could not remove the book.'));
    });
  } finally {
    database.close();
  }

  // The reading state goes with it, on every device at the next sync.
  for (const kind of ['position', 'bookmarks', 'highlights'] as const) {
    try {
      window.localStorage.removeItem(`bionic-reader:${kind}:${bookKey}`);
    } catch {
      // Nothing to remove.
    }
  }
}

/**
 * Ask the browser not to evict the library when space runs short. Without it
 * a phone can quietly drop the books, and iOS clears site data that has not
 * been opened for a week.
 */
export async function keepStoredDataPersistent() {
  try {
    if (!navigator.storage?.persist || (await navigator.storage.persisted())) {
      return;
    }
    await navigator.storage.persist();
  } catch {
    // Nothing to do if the browser will not say.
  }
}

/**
 * Free the space a book takes without forgetting it: the cover stays so the
 * shelf still shows it, and the account still holds the book itself.
 */
export async function removeLocalCopy(bookKey: string) {
  const book = await loadBook(bookKey);
  if (!book) {
    return;
  }

  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        [BOOK_STORE, COVER_STORE],
        'readwrite',
      );
      if (book.cover) {
        transaction.objectStore(COVER_STORE).put({
          id: bookKey,
          cover: book.cover,
        });
      }
      transaction.objectStore(BOOK_STORE).delete(bookKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('Could not free the book.'));
    });
  } finally {
    database.close();
  }
}

export async function listBooks(): Promise<StoredBook[]> {
  if (!('indexedDB' in window)) {
    return [];
  }

  const database = await openDatabase();
  try {
    const books = await new Promise<StoredBook[]>((resolve, reject) => {
      const transaction = database.transaction(BOOK_STORE, 'readonly');
      const request = transaction.objectStore(BOOK_STORE).getAll();
      request.onsuccess = () => resolve((request.result as StoredBook[]) ?? []);
      request.onerror = () =>
        reject(request.error ?? new Error('Could not read the library.'));
    });
    return books
      .filter(book => book.blob)
      .sort((first, second) => second.updatedAt - first.updatedAt);
  } finally {
    database.close();
  }
}

export async function loadBook(bookKey: string): Promise<StoredBook | null> {
  if (!('indexedDB' in window)) {
    return null;
  }

  const database = await openDatabase();
  try {
    return await new Promise<StoredBook | null>((resolve, reject) => {
      const transaction = database.transaction(BOOK_STORE, 'readonly');
      const request = transaction.objectStore(BOOK_STORE).get(bookKey);
      request.onsuccess = () =>
        resolve((request.result as StoredBook | undefined) ?? null);
      request.onerror = () =>
        reject(request.error ?? new Error('Could not read the book.'));
    });
  } finally {
    database.close();
  }
}

export async function saveCover(bookKey: string, cover: Blob) {
  if (!('indexedDB' in window)) {
    return;
  }

  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(COVER_STORE, 'readwrite');
      transaction.objectStore(COVER_STORE).put({ id: bookKey, cover });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('Could not save the cover.'));
    });
  } finally {
    database.close();
  }
}

export async function listCovers(): Promise<Map<string, Blob>> {
  if (!('indexedDB' in window)) {
    return new Map();
  }

  const database = await openDatabase();
  try {
    const records = await new Promise<Array<{ id: string; cover: Blob }>>(
      (resolve, reject) => {
        const transaction = database.transaction(COVER_STORE, 'readonly');
        const request = transaction.objectStore(COVER_STORE).getAll();
        request.onsuccess = () =>
          resolve((request.result as Array<{ id: string; cover: Blob }>) ?? []);
        request.onerror = () =>
          reject(request.error ?? new Error('Could not read covers.'));
      },
    );
    return new Map(
      records.filter(record => record.cover).map(r => [r.id, r.cover]),
    );
  } finally {
    database.close();
  }
}

export function storedBookToFile(book: StoredBook) {
  return new File([book.blob], book.fileName, {
    type: book.fileType,
    lastModified: book.lastModified,
  });
}
