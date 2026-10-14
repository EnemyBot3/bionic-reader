import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from 'react';
import {
  AlignJustify,
  AlignLeft,
  ArrowRight,
  AlignCenter,
  AlignRight,
  BookOpen,
  Bookmark,
  BookmarkCheck,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Cloud,
  CloudAlert,
  CloudCheck,
  CloudDownload,
  CloudOff,
  Copy,
  Ellipsis,
  ImagePlus,
  ExternalLink,
  FilePlus2,
  FileText,
  FolderOpen,
  Library,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Moon,
  PanelLeft,
  Palette,
  RotateCcw,
  ScanText,
  Search,
  Settings2,
  Sun,
  Trash2,
  Type as TypeIcon,
  X,
} from 'lucide-react';
import type {
  BookDetails,
  EpubReaderHandle,
  ReadingLocation,
  SearchResult,
  TocEntry,
} from './EpubReader';
import {
  DEFAULT_READER_SETTINGS,
  loadReaderSettings,
  markSettingsEdited,
  normalizeSettings,
  READER_PALETTES,
  saveReaderSettings,
  type PageNumberDisplay,
  type ReaderSettings,
  type ReaderTheme,
  type TextAlignment,
} from './readerSettings';
import {
  connectDrive,
  disconnectDrive,
  describeDriveOrigin,
  getDriveClientId,
  isDriveConfigured,
  isDriveConnected,
  setDriveClientId,
  wasDriveConnected,
} from './googleDrive';
import {
  deleteBookEverywhere,
  DriveAuthError,
  downloadBook,
  fetchMissingCovers,
  syncWithDrive,
  type LibraryEntry,
} from './syncState';
import {
  getBookmarks,
  getBookKey,
  getBookmarks as readBookmarks,
  getSavedPosition,
  deleteBook,
  keepStoredDataPersistent,
  listBooks,
  listCovers,
  loadBook,
  saveBook,
  removeLocalCopy,
  saveBookmarks,
  updateBook,
  savePosition,
  storedBookToFile,
  type SavedBookmark,
  type StoredBook,
} from './storage';

type DrawerName = 'contents' | 'search' | 'settings' | null;
type DriveStatus = 'off' | 'busy' | 'ready' | 'error' | 'offline';

/** A book on this device, in the account, or both. */
type LibraryRow = {
  key: string;
  title: string;
  creator: string;
  local: boolean;
  cover: Blob | null;
};
type ContentsTab = 'toc' | 'bookmarks';

const EpubReader = lazy(async () => {
  const module = await import('./EpubReader');
  return { default: module.EpubReader };
});

const EMPTY_LOCATION: ReadingLocation = {
  cfi: '',
  href: '',
  chapter: '',
  progress: 0,
  pageNumber: '1',
  totalPages: null,
  atStart: true,
  atEnd: false,
};

export function AppWeb() {
  const [settings, setSettings] = useState<ReaderSettings>(loadReaderSettings);
  const [file, setFile] = useState<File | null>(null);
  const [book, setBook] = useState<BookDetails | null>(null);
  const [books, setBooks] = useState<StoredBook[]>([]);
  const [library, setLibrary] = useState<Record<string, LibraryEntry>>({});
  const [covers, setCovers] = useState<Map<string, Blob>>(new Map());
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [pinningKey, setPinningKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [openAtCfi, setOpenAtCfi] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [importing, setImporting] = useState<{
    name: string;
    done: number;
    total: number;
  } | null>(null);
  const [location, setLocation] = useState<ReadingLocation>(EMPTY_LOCATION);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerName>(null);
  const [contentsTab, setContentsTab] = useState<ContentsTab>('toc');
  const [bookmarks, setBookmarks] = useState<SavedBookmark[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [draggingFile, setDraggingFile] = useState(false);
  const [fullscreen, setFullscreen] = useState(
    Boolean(document.fullscreenElement),
  );
  const [seekProgress, setSeekProgress] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const [driveStatus, setDriveStatus] = useState<DriveStatus>(() =>
    isDriveConnected() ? 'ready' : 'off',
  );
  const [driveMessage, setDriveMessage] = useState('');
  const [setupOpen, setSetupOpen] = useState(false);
  // Bumped by changes the reader made, so a sync arriving from Drive cannot
  // trigger a sync of its own.
  const [localEdits, setLocalEdits] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const readerRef = useRef<EpubReaderHandle | null>(null);
  const searchIdRef = useRef(0);
  const seekProgressRef = useRef(0);
  const seekActiveRef = useRef(false);
  const bookKeyRef = useRef('');
  const syncingRef = useRef(false);
  const driveConfigured = isDriveConfigured();

  const palette = READER_PALETTES[settings.theme];
  // The device's own books first, then whatever else the account holds.
  const libraryRows = useMemo<LibraryRow[]>(() => {
    const rows = books.map(book => ({
      key: book.id,
      title: book.title,
      creator: book.creator,
      local: true,
      cover: book.cover ?? covers.get(book.id) ?? null,
    }));
    for (const [key, entry] of Object.entries(library)) {
      if (entry.deletedAt) {
        continue;
      }
      if (!rows.some(row => row.key === key)) {
        rows.push({
          key,
          title: entry.title,
          creator: entry.creator,
          local: false,
          cover: covers.get(key) ?? null,
        });
      }
    }
    return rows;
  }, [books, covers, library]);

  const editingRow = editingKey
    ? libraryRows.find(row => row.key === editingKey) ?? null
    : null;
  const bookKey = useMemo(() => (file ? getBookKey(file) : ''), [file]);
  const initialCfi = useMemo(
    () => (bookKey ? getSavedPosition(bookKey)?.cfi : undefined),
    [bookKey],
  );
  const currentBookmark = bookmarks.find(
    item =>
      item.href === location.href &&
      Math.abs(item.progress - location.progress) < 0.004,
  );

  bookKeyRef.current = bookKey;

  const runSync = useCallback(async () => {
    if (syncingRef.current) {
      return;
    }
    if (!navigator.onLine) {
      // Nothing is lost: edits stay stamped and go up on reconnection.
      setDriveStatus('offline');
      return;
    }
    syncingRef.current = true;
    setDriveStatus('busy');

    try {
      const localBooks = await listBooks();
      const result = await syncWithDrive(localBooks);
      setLibrary(result.library);
      if (result.uploaded.length > 0 || result.removed.length > 0) {
        setBooks(await listBooks());
        setCovers(await listCovers());
      }

      const known = new Set([
        ...localBooks.filter(book => book.cover).map(book => book.id),
        ...(await listCovers()).keys(),
      ]);
      if (await fetchMissingCovers(result.library, known)) {
        setCovers(await listCovers());
      }
      if (result.settingsChanged) {
        setSettings(loadReaderSettings());
      }
      if (bookKeyRef.current && result.books.includes(bookKeyRef.current)) {
        setBookmarks(getBookmarks(bookKeyRef.current));
      }
      setDriveStatus('ready');
      setDriveMessage('');
    } catch (error) {
      if (error instanceof DriveAuthError) {
        setDriveStatus('off');
        setDriveMessage('');
      } else {
        setDriveStatus('error');
        setDriveMessage(
          error instanceof Error ? error.message : 'Sync did not finish.',
        );
      }
    } finally {
      syncingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!driveConfigured) {
      return;
    }
    if (isDriveConnected()) {
      void runSync();
      return;
    }
    // The token has expired since the last visit. Google may hand us a new one
    // without showing anything, as long as the account is still signed in.
    if (wasDriveConnected()) {
      setDriveStatus('busy');
      void connectDrive({ silent: true })
        .then(() => runSync())
        .catch(() => setDriveStatus('off'));
    }
  }, [driveConfigured, runSync]);

  useEffect(() => {
    if (!driveConfigured || localEdits === 0 || !isDriveConnected()) {
      return;
    }
    const timeout = window.setTimeout(() => void runSync(), 4000);
    return () => window.clearTimeout(timeout);
  }, [driveConfigured, localEdits, runSync]);

  useEffect(() => {
    const onReconnect = () => {
      if (isDriveConnected()) {
        void runSync();
      } else {
        // Whatever the network broke, it is no longer broken.
        setDriveStatus(current =>
          current === 'offline' || current === 'error' ? 'off' : current,
        );
      }
    };
    const onDisconnect = () => setDriveStatus('offline');

    window.addEventListener('online', onReconnect);
    window.addEventListener('offline', onDisconnect);
    return () => {
      window.removeEventListener('online', onReconnect);
      window.removeEventListener('offline', onDisconnect);
    };
  }, [runSync]);

  async function connectAndSync() {
    if (!navigator.onLine) {
      setDriveStatus('offline');
      return;
    }
    setDriveStatus('busy');
    try {
      await connectDrive();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Sign-in did not finish.';
      setDriveStatus('error');
      setDriveMessage(message);
      // The setup is done and lives in the build; a failure here is reported
      // on the control itself rather than by reopening a wizard.
      if (!file) {
        setError(message);
      }
      return;
    }
    await runSync();
  }

  async function handleDrive(event: React.MouseEvent) {
    // Shift or alt turns the same control into "manage", which keeps the
    // header down to one icon.
    if (event.shiftKey || event.altKey) {
      if (isDriveConnected()) {
        await disconnectDrive();
        setDriveStatus('off');
        setDriveMessage('');
      } else {
        setSetupOpen(true);
      }
      return;
    }

    if (!isDriveConfigured()) {
      setSetupOpen(true);
      return;
    }
    if (isDriveConnected()) {
      await runSync();
      return;
    }
    await connectAndSync();
  }

  function saveDriveClientId(clientId: string) {
    setDriveClientId(clientId);
    setSetupOpen(false);
    setDriveMessage('');
    void connectAndSync();
  }

  useEffect(() => {
    saveReaderSettings(settings);
    const themeColor = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    themeColor?.setAttribute('content', palette.surface);
    document.documentElement.style.colorScheme =
      settings.theme === 'dark' ? 'dark' : 'light';
  }, [palette.surface, settings]);

  useEffect(() => {
    void listBooks()
      .then(setBooks)
      .catch(() => setBooks([]));
    void listCovers()
      .then(setCovers)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setBookmarks(bookKey ? getBookmarks(bookKey) : []);
  }, [bookKey]);

  useEffect(() => {
    if (!bookKey || !location.cfi || loading) {
      return;
    }

    const timeout = window.setTimeout(() => {
      savePosition(bookKey, { ...location, updatedAt: Date.now() });
      setLocalEdits(count => count + 1);
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [bookKey, loading, location]);

  useEffect(() => {
    if (!seeking) {
      seekProgressRef.current = location.progress;
      setSeekProgress(location.progress);
    }
  }, [location.progress, seeking]);

  useEffect(() => {
    if (seeking && !seekActiveRef.current && !loading) {
      setSeeking(false);
    }
  }, [loading, seeking]);

  useEffect(() => {
    const onFullscreenChange = () =>
      setFullscreen(Boolean(document.fullscreenElement));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDrawer(null);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        fileInputRef.current?.click();
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'f' &&
        file
      ) {
        event.preventDefault();
        setDrawer('search');
      }
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [file]);

  useEffect(() => {
    const searchId = ++searchIdRef.current;
    if (drawer !== 'search' || searchQuery.trim().length < 2) {
      readerRef.current?.cancelSearch();
      setSearchResults([]);
      setSearching(false);
      return;
    }

    const timeout = window.setTimeout(async () => {
      setSearching(true);
      try {
        const results = await readerRef.current?.search(searchQuery);
        if (searchId === searchIdRef.current) {
          setSearchResults(results ?? []);
        }
      } finally {
        if (searchId === searchIdRef.current) {
          setSearching(false);
        }
      }
    }, 300);

    return () => {
      window.clearTimeout(timeout);
      readerRef.current?.cancelSearch();
    };
  }, [drawer, searchQuery]);

  function patchSettings(patch: Partial<ReaderSettings>) {
    setSettings(current => normalizeSettings({ ...current, ...patch }));
    markSettingsEdited();
    setLocalEdits(count => count + 1);
  }

  function resetSettings() {
    setSettings(DEFAULT_READER_SETTINGS);
    markSettingsEdited();
    setLocalEdits(count => count + 1);
  }

  function openFile(nextFile: File | null, notice?: string | null) {
    if (!nextFile) {
      return;
    }
    if (notice !== undefined) {
      setImportNotice(notice);
    }

    const name = nextFile.name.toLowerCase();
    if (name.endsWith('.pdf') || nextFile.type === 'application/pdf') {
      void importPdfFile(nextFile);
      return;
    }
    if (!name.endsWith('.epub') && nextFile.type !== 'application/epub+zip') {
      setError('Choose an EPUB or a PDF.');
      return;
    }

    setFile(nextFile);
    setBook(null);
    setLocation(EMPTY_LOCATION);
    setError(null);
    setDrawer(null);
    setSearchQuery('');
    setSearchResults([]);
    seekActiveRef.current = false;
    seekProgressRef.current = 0;
    setSeeking(false);
    setSeekProgress(0);
  }

  function closeBook() {
    setFile(null);
    setBook(null);
    setLocation(EMPTY_LOCATION);
    setDrawer(null);
    setError(null);
    setLoading(false);
    seekActiveRef.current = false;
    seekProgressRef.current = 0;
    setSeeking(false);
    setSeekProgress(0);
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    openFile(event.currentTarget.files?.[0] ?? null);
    event.currentTarget.value = '';
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDraggingFile(false);
    openFile(event.dataTransfer.files?.[0] ?? null);
  }

  function handleBookReady(details: BookDetails) {
    setBook(details);
    if (!file) {
      return;
    }
    // EPUB.js hands us a blob URL for the cover that dies with the book, so
    // take a copy now for the shelf.
    void (
      details.coverUrl
        ? fetch(details.coverUrl)
            .then(response => response.blob())
            .catch(() => null)
        : Promise.resolve(null)
    )
      .then(cover => saveBook(file, details.title, details.creator, cover))
      .then(() => keepStoredDataPersistent())
      .then(() => listBooks())
      .then(setBooks)
      .catch(() => undefined);
  }

  /**
   * PDFs are converted once, on import, and stored as the EPUB they became.
   * Everything downstream then treats them as an ordinary book.
   */
  async function importPdfFile(source: File) {
    setError(null);
    setImporting({ name: source.name, done: 0, total: 0 });
    try {
      const { importPdf } = await import('./pdfImport');
      const result = await importPdf(source, (done, total) =>
        setImporting({ name: source.name, done, total }),
      );

      await saveBook(result.file, result.title, result.creator, result.cover);
      setBooks(await listBooks());
      setLocalEdits(count => count + 1);
      setImporting(null);

      // A warning is not a failure: the book still opens, with a note.
      setImportNotice(
        result.warnings.includes('columns')
          ? 'Converted from a PDF laid out in columns, so the text may run out of order.'
          : result.warnings.includes('sparse')
          ? 'Converted from a PDF that holds very little text.'
          : 'Converted from a PDF, so the layout is approximate.',
      );
      openFile(result.file);
    } catch (error) {
      setImporting(null);
      setError(
        error instanceof Error ? error.message : 'That PDF could not be read.',
      );
    }
  }

  async function saveBookEdit(
    bookKey: string,
    patch: { title?: string; creator?: string; cover?: Blob },
  ) {
    await updateBook(bookKey, patch);
    setBooks(await listBooks());
    setLocalEdits(count => count + 1);
  }

  /** Fetch a book from the account and keep it, without opening it. */
  async function saveLocally(bookKey: string) {
    const entry = library[bookKey];
    if (!entry) {
      return;
    }
    setPinningKey(bookKey);
    try {
      await downloadBook(bookKey, entry);
      await keepStoredDataPersistent();
      setBooks(await listBooks());
      setCovers(await listCovers());
    } catch (error) {
      setError(
        error instanceof DriveAuthError
          ? 'Sign in to Google Drive to download this book.'
          : error instanceof Error
          ? error.message
          : 'That book could not be downloaded.',
      );
    } finally {
      setPinningKey(null);
    }
  }

  /** Free the space a book takes here; the account keeps it. */
  async function freeLocally(bookKey: string) {
    setPinningKey(bookKey);
    try {
      await removeLocalCopy(bookKey);
      setBooks(await listBooks());
      setCovers(await listCovers());
    } finally {
      setPinningKey(null);
    }
  }

  async function removeBook(bookKey: string) {
    setEditingKey(null);
    try {
      if (isDriveConnected() && library[bookKey]) {
        await deleteBookEverywhere(bookKey, library[bookKey]);
      } else {
        await deleteBook(bookKey);
      }
    } catch {
      // Removing it here is what matters; the account catches up next sync.
      await deleteBook(bookKey);
    }
    setBooks(await listBooks());
    setCovers(await listCovers());
    setLibrary(current => {
      const next = { ...current };
      delete next[bookKey];
      return next;
    });
  }

  /** Open a book from this device, fetching it from the account if needed. */
  async function openLibraryBook(row: LibraryRow, cfi?: string) {
    setOpenAtCfi(cfi ?? null);
    setEditingKey(null);
    setOpeningKey(row.key);
    try {
      const stored = row.local ? await loadBook(row.key) : null;
      if (stored) {
        openFile(storedBookToFile(stored), null);
        return;
      }

      const entry = library[row.key];
      if (!entry) {
        return;
      }
      openFile(await downloadBook(row.key, entry));
      setBooks(await listBooks());
      setCovers(await listCovers());
    } catch (error) {
      if (error instanceof DriveAuthError) {
        setDriveStatus('off');
      } else {
        setError(
          error instanceof Error ? error.message : 'That book did not open.',
        );
      }
    } finally {
      setOpeningKey(null);
    }
  }

  function navigate(target: string | number) {
    setDrawer(null);
    void readerRef.current?.display(target);
  }

  function toggleBookmark() {
    if (!bookKey || !location.cfi) {
      return;
    }

    const next = currentBookmark
      ? bookmarks.filter(bookmark => bookmark.id !== currentBookmark.id)
      : [
          ...bookmarks,
          {
            id: `${Date.now()}-${location.cfi}`,
            cfi: location.cfi,
            href: location.href,
            chapter: location.chapter || 'Saved location',
            progress: location.progress,
            createdAt: Date.now(),
          },
        ];
    setBookmarks(next);
    saveBookmarks(bookKey, next);
    setLocalEdits(count => count + 1);
  }

  function removeBookmark(id: string) {
    const next = bookmarks.filter(bookmark => bookmark.id !== id);
    setBookmarks(next);
    saveBookmarks(bookKey, next);
    setLocalEdits(count => count + 1);
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  }

  function startSeek() {
    seekActiveRef.current = true;
    setSeeking(true);
  }

  function changeSeek(progress: number) {
    const normalized = Math.min(1, Math.max(0, progress));
    if (!seekActiveRef.current) {
      seekActiveRef.current = true;
      setSeeking(true);
    }
    seekProgressRef.current = normalized;
    setSeekProgress(normalized);
  }

  function commitSeek(progress: number) {
    if (!seekActiveRef.current) {
      return;
    }
    const normalized = Math.min(1, Math.max(0, progress));
    seekActiveRef.current = false;
    seekProgressRef.current = normalized;
    setSeekProgress(normalized);
    void readerRef.current?.goToProgress(normalized);
  }

  return (
    <div
      className={`app-shell ${file ? 'is-reading' : 'is-library'} ${
        draggingFile ? 'is-dragging' : ''
      }`}
      data-theme={settings.theme}
      style={
        {
          '--app-bg': palette.app,
          '--surface': palette.surface,
          '--page': palette.page,
          '--reader-surround': settings.pageFrame ? palette.app : palette.page,
          '--reader-paper': settings.pageFrame
            ? settings.paperColor
            : palette.page,
          '--reader-page-width': `${settings.contentWidth}px`,
          '--text': palette.text,
          '--muted': palette.muted,
          '--border': palette.border,
          '--accent': palette.accent,
          '--accent-soft': palette.accentSoft,
        } as React.CSSProperties
      }
      onDragEnter={event => {
        event.preventDefault();
        setDraggingFile(true);
      }}
      onDragOver={event => event.preventDefault()}
      onDragLeave={event => {
        if (event.currentTarget === event.target) {
          setDraggingFile(false);
        }
      }}
      onDrop={handleDrop}
    >
      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept="application/epub+zip,.epub,application/pdf,.pdf"
        onChange={handleFileInput}
      />

      {file ? (
        <ReaderChrome
          book={book}
          fileName={file.name}
          location={location}
          loading={loading}
          restoring={restoring}
          error={error}
          driveStatus={driveStatus}
          driveMessage={driveMessage}
          onDrive={event => void handleDrive(event)}
          importNotice={importNotice}
          onDismissNotice={() => setImportNotice(null)}
          settings={settings}
          drawer={drawer}
          contentsTab={contentsTab}
          bookmarks={bookmarks}
          currentBookmark={Boolean(currentBookmark)}
          searchQuery={searchQuery}
          searchResults={searchResults}
          searching={searching}
          fullscreen={fullscreen}
          seekProgress={seekProgress}
          readerRef={readerRef}
          initialCfi={openAtCfi ?? initialCfi}
          file={file}
          onBookReady={handleBookReady}
          onLocationChange={setLocation}
          onLoadingChange={setLoading}
          onBlankChange={setRestoring}
          onError={setError}
          onDrawerChange={setDrawer}
          onContentsTabChange={setContentsTab}
          onOpenFile={() => fileInputRef.current?.click()}
          onCloseBook={closeBook}
          onNavigate={navigate}
          onToggleBookmark={toggleBookmark}
          onRemoveBookmark={removeBookmark}
          onSearchQueryChange={setSearchQuery}
          onSettingsChange={patchSettings}
          onResetSettings={resetSettings}
          onToggleFullscreen={() => void toggleFullscreen()}
          onSeekStart={startSeek}
          onSeekChange={changeSeek}
          onSeekCommit={commitSeek}
        />
      ) : (
        <LibraryView
          rows={libraryRows}
          openingKey={openingKey}
          importing={importing}
          onEditBook={row => setEditingKey(row.key)}
          error={error}
          theme={settings.theme}
          driveStatus={driveStatus}
          driveMessage={driveMessage}
          onDrive={event => void handleDrive(event)}
          onOpen={() => fileInputRef.current?.click()}
          onOpenBook={row => void openLibraryBook(row)}
          onThemeChange={theme => patchSettings({ theme })}
          onDismissError={() => setError(null)}
        />
      )}

      {editingRow ? (
        <BookPanel
          row={editingRow}
          bookmarks={readBookmarks(editingRow.key)}
          inAccount={Boolean(library[editingRow.key])}
          busy={pinningKey === editingRow.key}
          onSaveLocally={() => void saveLocally(editingRow.key)}
          onFreeLocally={() => void freeLocally(editingRow.key)}
          onSave={patch => void saveBookEdit(editingRow.key, patch)}
          onOpenBookmark={cfi => void openLibraryBook(editingRow, cfi)}
          onRemoveBookmark={id => {
            const next = readBookmarks(editingRow.key).filter(
              mark => mark.id !== id,
            );
            saveBookmarks(editingRow.key, next);
            if (editingRow.key === bookKey) {
              setBookmarks(next);
            }
            setLocalEdits(count => count + 1);
          }}
          onDelete={() => void removeBook(editingRow.key)}
          onClose={() => setEditingKey(null)}
        />
      ) : null}

      {setupOpen ? (
        <DriveSetup
          origin={describeDriveOrigin()}
          clientId={getDriveClientId()}
          error={driveStatus === 'error' ? driveMessage : ''}
          onSave={saveDriveClientId}
          onClose={() => setSetupOpen(false)}
        />
      ) : null}

      {draggingFile ? (
        <div className="drop-overlay" aria-hidden="true">
          <FilePlus2 size={30} />
          <strong>Open EPUB</strong>
        </div>
      ) : null}
    </div>
  );
}

type ReaderChromeProps = {
  book: BookDetails | null;
  fileName: string;
  location: ReadingLocation;
  loading: boolean;
  restoring: boolean;
  error: string | null;
  driveStatus: DriveStatus;
  driveMessage: string;
  onDrive: (event: React.MouseEvent<HTMLButtonElement>) => void;
  importNotice: string | null;
  onDismissNotice: () => void;
  settings: ReaderSettings;
  drawer: DrawerName;
  contentsTab: ContentsTab;
  bookmarks: SavedBookmark[];
  currentBookmark: boolean;
  searchQuery: string;
  searchResults: SearchResult[];
  searching: boolean;
  fullscreen: boolean;
  seekProgress: number;
  readerRef: React.RefObject<EpubReaderHandle | null>;
  initialCfi?: string;
  file: File;
  onBookReady: (details: BookDetails) => void;
  onLocationChange: (location: ReadingLocation) => void;
  onLoadingChange: (loading: boolean) => void;
  onBlankChange: (blank: boolean) => void;
  onError: (message: string) => void;
  onDrawerChange: (drawer: DrawerName) => void;
  onContentsTabChange: (tab: ContentsTab) => void;
  onOpenFile: () => void;
  onCloseBook: () => void;
  onNavigate: (target: string | number) => void;
  onToggleBookmark: () => void;
  onRemoveBookmark: (id: string) => void;
  onSearchQueryChange: (query: string) => void;
  onSettingsChange: (patch: Partial<ReaderSettings>) => void;
  onResetSettings: () => void;
  onToggleFullscreen: () => void;
  onSeekStart: () => void;
  onSeekChange: (progress: number) => void;
  onSeekCommit: (progress: number) => void;
};

function ReaderChrome(props: ReaderChromeProps) {
  const title = props.book?.title ?? props.fileName.replace(/\.epub$/i, '');
  // Once a page is on screen it stays on screen. Later waits are reported by a
  // small marker instead of a panel that covers the book.
  const opening = props.loading && !props.location.cfi;
  const settling = useDelayedFlag(
    props.loading && Boolean(props.location.cfi),
    400,
  );
  const pendingLabel = props.restoring
    ? 'Restoring page'
    : settling
    ? 'Turning pages'
    : '';
  const progressLabel = `${Math.round(props.seekProgress * 100)}%`;
  const chapterLabel =
    props.location.chapter || (props.loading ? 'Preparing book' : '');
  const pageLabel =
    props.settings.pageNumberDisplay === 'number-total' &&
    props.location.totalPages
      ? `${props.location.pageNumber} / ${props.location.totalPages}`
      : props.location.pageNumber;
  const showPageNumber =
    props.settings.pageNumberDisplay !== 'hidden' && Boolean(pageLabel);

  return (
    <div className="reader-app">
      <header className="reader-toolbar">
        <IconButton
          label="Contents"
          active={props.drawer === 'contents'}
          onClick={() =>
            props.onDrawerChange(
              props.drawer === 'contents' ? null : 'contents',
            )
          }
        >
          <PanelLeft size={19} />
        </IconButton>

        <button
          className="book-identity"
          type="button"
          onClick={props.onCloseBook}
          title="Close book"
        >
          <strong>{title}</strong>
          <span>{props.book?.creator ?? 'Opening EPUB'}</span>
        </button>

        <div
          className="chapter-title"
          title={[chapterLabel, showPageNumber ? `Page ${pageLabel}` : '']
            .filter(Boolean)
            .join(' · ')}
        >
          {chapterLabel ? (
            <span className="chapter-name">{chapterLabel}</span>
          ) : null}
          {chapterLabel && showPageNumber ? (
            <span className="chapter-separator" aria-hidden="true">
              ·
            </span>
          ) : null}
          {showPageNumber ? (
            <span className="page-number" aria-label={`Page ${pageLabel}`}>
              {pageLabel}
            </span>
          ) : null}
        </div>

        <div className="reader-actions">
          <DriveButton
            status={props.driveStatus}
            message={props.driveMessage}
            onActivate={props.onDrive}
          />
          <IconButton
            label="Search book"
            active={props.drawer === 'search'}
            onClick={() =>
              props.onDrawerChange(props.drawer === 'search' ? null : 'search')
            }
          >
            <Search size={18} />
          </IconButton>
          <IconButton
            label={props.currentBookmark ? 'Remove bookmark' : 'Add bookmark'}
            active={props.currentBookmark}
            disabled={!props.location.cfi}
            onClick={props.onToggleBookmark}
          >
            {props.currentBookmark ? (
              <BookmarkCheck size={18} />
            ) : (
              <Bookmark size={18} />
            )}
          </IconButton>
          <IconButton label="Open another EPUB" onClick={props.onOpenFile}>
            <FolderOpen size={18} />
          </IconButton>
          <IconButton
            label={props.fullscreen ? 'Exit full screen' : 'Enter full screen'}
            onClick={props.onToggleFullscreen}
          >
            {props.fullscreen ? (
              <Minimize2 size={18} />
            ) : (
              <Maximize2 size={18} />
            )}
          </IconButton>
          <IconButton
            label="Reading settings"
            active={props.drawer === 'settings'}
            onClick={() =>
              props.onDrawerChange(
                props.drawer === 'settings' ? null : 'settings',
              )
            }
          >
            <Settings2 size={18} />
          </IconButton>
        </div>
      </header>

      <main className="reader-main">
        <Suspense
          fallback={
            <div className="reader-state">
              <LoaderCircle className="spin" size={22} />
            </div>
          }
        >
          <EpubReader
            ref={props.readerRef}
            file={props.file}
            initialCfi={props.initialCfi}
            settings={props.settings}
            onReady={props.onBookReady}
            onLocationChange={props.onLocationChange}
            onLoadingChange={props.onLoadingChange}
            onBlankChange={props.onBlankChange}
            onError={props.onError}
          />
        </Suspense>

        {opening ? (
          <div className="reader-state" role="status">
            <LoaderCircle className="spin" size={22} />
            <span>Opening {title}</span>
          </div>
        ) : null}

        {pendingLabel && !opening ? (
          <div className="reader-pending" role="status">
            <LoaderCircle className="spin" size={14} />
            <span>{pendingLabel}</span>
          </div>
        ) : null}

        {props.error ? (
          <div className="reader-state reader-error" role="alert">
            <span>{props.error}</span>
            <button
              className="text-button"
              type="button"
              onClick={props.onCloseBook}
            >
              Close book
            </button>
          </div>
        ) : null}

        {props.book?.fixedLayout ? (
          <div className="format-notice">
            Fixed-layout EPUB: typography and bionic controls are limited.
          </div>
        ) : props.importNotice ? (
          <div className="format-notice">
            <span>{props.importNotice}</span>
            <IconButton label="Dismiss" onClick={props.onDismissNotice}>
              <X size={15} />
            </IconButton>
          </div>
        ) : null}
      </main>

      <footer className="reader-footer">
        <IconButton
          label="Previous chapter"
          onClick={() => void props.readerRef.current?.previousChapter()}
        >
          <ChevronLeft size={18} />
        </IconButton>
        <input
          className="progress-slider"
          aria-label="Reading progress"
          aria-valuetext={progressLabel}
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={props.seekProgress}
          disabled={!props.location.cfi}
          onPointerDown={props.onSeekStart}
          onChange={event =>
            props.onSeekChange(Number(event.currentTarget.value))
          }
          onPointerUp={event =>
            props.onSeekCommit(Number(event.currentTarget.value))
          }
          onPointerCancel={event =>
            props.onSeekCommit(Number(event.currentTarget.value))
          }
          onKeyDown={event => {
            if (
              [
                'ArrowLeft',
                'ArrowRight',
                'Home',
                'End',
                'PageUp',
                'PageDown',
              ].includes(event.key)
            ) {
              props.onSeekStart();
            }
          }}
          onKeyUp={event => {
            if (
              [
                'ArrowLeft',
                'ArrowRight',
                'Home',
                'End',
                'PageUp',
                'PageDown',
              ].includes(event.key)
            ) {
              props.onSeekCommit(Number(event.currentTarget.value));
            }
          }}
          onBlur={event =>
            props.onSeekCommit(Number(event.currentTarget.value))
          }
        />
        <output className="progress-label">{progressLabel}</output>
        <IconButton
          label="Next chapter"
          onClick={() => void props.readerRef.current?.nextChapter()}
        >
          <ChevronRight size={18} />
        </IconButton>
      </footer>

      {props.drawer ? (
        <button
          className="drawer-scrim"
          type="button"
          aria-label="Close panel"
          onClick={() => props.onDrawerChange(null)}
        />
      ) : null}

      {props.drawer === 'contents' ? (
        <ContentsDrawer
          book={props.book}
          currentHref={props.location.href}
          activeTab={props.contentsTab}
          bookmarks={props.bookmarks}
          onTabChange={props.onContentsTabChange}
          onNavigate={props.onNavigate}
          onRemoveBookmark={props.onRemoveBookmark}
          onClose={() => props.onDrawerChange(null)}
        />
      ) : null}

      {props.drawer === 'search' ? (
        <SearchDrawer
          query={props.searchQuery}
          results={props.searchResults}
          searching={props.searching}
          onQueryChange={props.onSearchQueryChange}
          onNavigate={props.onNavigate}
          onClose={() => props.onDrawerChange(null)}
        />
      ) : null}

      {props.drawer === 'settings' ? (
        <SettingsDrawer
          settings={props.settings}
          onChange={props.onSettingsChange}
          onReset={props.onResetSettings}
          onClose={() => props.onDrawerChange(null)}
        />
      ) : null}
    </div>
  );
}

function LibraryView({
  rows,
  openingKey,
  importing,
  onEditBook,
  error,
  theme,
  driveStatus,
  driveMessage,
  onDrive,
  onOpen,
  onOpenBook,
  onThemeChange,
  onDismissError,
}: {
  rows: LibraryRow[];
  openingKey: string | null;
  importing: { name: string; done: number; total: number } | null;
  onEditBook: (row: LibraryRow) => void;
  error: string | null;
  theme: ReaderTheme;
  driveStatus: DriveStatus;
  driveMessage: string;
  onDrive: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onOpen: () => void;
  onOpenBook: (row: LibraryRow) => void;
  onThemeChange: (theme: ReaderTheme) => void;
  onDismissError: () => void;
}) {
  const nextTheme = theme === 'dark' ? 'paper' : 'dark';
  // Covers are blobs on this device; hand them to the <img> as object URLs and
  // take them back when the shelf changes.
  const [covers, setCovers] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    const urls = new Map<string, string>();
    for (const row of rows) {
      if (row.cover) {
        urls.set(row.key, URL.createObjectURL(row.cover));
      }
    }
    setCovers(urls);
    return () => urls.forEach(url => URL.revokeObjectURL(url));
  }, [rows]);

  return (
    <div className="library-view">
      <header className="library-toolbar">
        <div className="library-bar">
          <div className="brand">
            <BookOpen size={19} />
            <strong>Bionic Reader</strong>
          </div>
          <div className="library-actions">
            <IconButton label="Open an EPUB" onClick={onOpen}>
              <FolderOpen size={18} />
            </IconButton>
            <DriveButton
              status={driveStatus}
              message={driveMessage}
              onActivate={onDrive}
            />
            <IconButton
              label={`Use ${nextTheme} theme`}
              onClick={() => onThemeChange(nextTheme)}
            >
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </IconButton>
          </div>
        </div>
      </header>

      <main className="library-main">
        {importing ? (
          <div className="import-progress" role="status">
            <LoaderCircle className="spin" size={16} />
            <span>
              {importing.total
                ? `Reading ${importing.name} · page ${importing.done} of ${importing.total}`
                : `Reading ${importing.name}`}
            </span>
          </div>
        ) : null}

        {error ? (
          <div className="library-error" role="alert">
            <span>{error}</span>
            <IconButton label="Dismiss" onClick={onDismissError}>
              <X size={17} />
            </IconButton>
          </div>
        ) : null}

        {rows.length > 0 ? (
          <section className="shelf" aria-label="Books">
            {rows.map(row => (
              <div key={row.key} className="shelf-book">
                <button
                  className="shelf-open"
                  type="button"
                  disabled={openingKey !== null}
                  onClick={() => onOpenBook(row)}
                >
                  <span className="shelf-cover">
                    {covers.has(row.key) ? (
                      <img src={covers.get(row.key)} alt="" />
                    ) : (
                      <BookOpen size={26} />
                    )}
                    {openingKey === row.key ? (
                      <span className="shelf-badge">
                        <LoaderCircle className="spin" size={15} />
                      </span>
                    ) : row.local ? null : (
                      <span className="shelf-badge" title="In your Drive">
                        <CloudDownload size={15} />
                      </span>
                    )}
                  </span>
                  <strong>{row.title}</strong>
                  <span>{row.creator}</span>
                </button>
                <button
                  className="shelf-edit"
                  type="button"
                  title="Edit book"
                  aria-label={`Edit ${row.title}`}
                  onClick={() => onEditBook(row)}
                >
                  <Ellipsis size={15} />
                </button>
              </div>
            ))}
          </section>
        ) : (
          <section className="open-book-panel" aria-labelledby="open-heading">
            <div className="library-mark">
              <Library size={28} />
            </div>
            <h1 id="open-heading">Open an EPUB</h1>
            <button className="primary-command" type="button" onClick={onOpen}>
              <FolderOpen size={18} />
              <span>Choose book</span>
            </button>
          </section>
        )}
      </main>
    </div>
  );
}

function ContentsDrawer({
  book,
  currentHref,
  activeTab,
  bookmarks,
  onTabChange,
  onNavigate,
  onRemoveBookmark,
  onClose,
}: {
  book: BookDetails | null;
  currentHref: string;
  activeTab: ContentsTab;
  bookmarks: SavedBookmark[];
  onTabChange: (tab: ContentsTab) => void;
  onNavigate: (target: string) => void;
  onRemoveBookmark: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <aside
      className="reader-drawer reader-drawer-left"
      aria-label="Book navigation"
    >
      <DrawerHeader title="Book navigation" onClose={onClose} />
      {book ? (
        <div className="book-summary">
          {book.coverUrl ? (
            <img src={book.coverUrl} alt="" />
          ) : (
            <div className="cover-fallback">
              <BookOpen size={23} />
            </div>
          )}
          <div>
            <strong>{book.title}</strong>
            <span>{book.creator}</span>
          </div>
        </div>
      ) : null}
      <div className="drawer-tabs" role="tablist" aria-label="Navigation view">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'toc'}
          onClick={() => onTabChange('toc')}
        >
          Contents
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'bookmarks'}
          onClick={() => onTabChange('bookmarks')}
        >
          Bookmarks
        </button>
      </div>

      <div className="drawer-scroll">
        {activeTab === 'toc' ? (
          book?.toc.length ? (
            <nav className="toc-list" aria-label="Table of contents">
              {book.toc.map(item => (
                <TocButton
                  key={item.id}
                  item={item}
                  active={sameSection(item.href, currentHref)}
                  onClick={() => onNavigate(item.href)}
                />
              ))}
            </nav>
          ) : (
            <EmptyPanel
              icon={<Library size={21} />}
              text="No table of contents"
            />
          )
        ) : bookmarks.length ? (
          <div className="bookmark-list">
            {[...bookmarks]
              .sort((a, b) => a.progress - b.progress)
              .map(bookmark => (
                <div className="bookmark-row" key={bookmark.id}>
                  <button
                    type="button"
                    onClick={() => onNavigate(bookmark.cfi)}
                  >
                    <strong>{bookmark.chapter}</strong>
                    <span>{Math.round(bookmark.progress * 100)}%</span>
                  </button>
                  <IconButton
                    label="Delete bookmark"
                    onClick={() => onRemoveBookmark(bookmark.id)}
                  >
                    <Trash2 size={16} />
                  </IconButton>
                </div>
              ))}
          </div>
        ) : (
          <EmptyPanel icon={<Bookmark size={21} />} text="No bookmarks yet" />
        )}
      </div>
    </aside>
  );
}

function TocButton({
  item,
  active,
  onClick,
}: {
  item: TocEntry;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="toc-item"
      data-active={active}
      style={{ '--toc-depth': Math.min(item.depth, 3) } as React.CSSProperties}
      onClick={onClick}
    >
      {item.label}
    </button>
  );
}

function SearchDrawer({
  query,
  results,
  searching,
  onQueryChange,
  onNavigate,
  onClose,
}: {
  query: string;
  results: SearchResult[];
  searching: boolean;
  onQueryChange: (query: string) => void;
  onNavigate: (target: string) => void;
  onClose: () => void;
}) {
  return (
    <aside
      className="reader-drawer reader-drawer-left"
      aria-label="Search book"
    >
      <DrawerHeader title="Search" onClose={onClose} />
      <div className="search-field">
        <Search size={17} />
        <input
          autoFocus
          type="search"
          value={query}
          placeholder="Search this book"
          aria-label="Search this book"
          onChange={event => onQueryChange(event.currentTarget.value)}
        />
        {searching ? <LoaderCircle className="spin" size={16} /> : null}
      </div>
      <div className="drawer-scroll">
        {query.trim().length < 2 ? (
          <EmptyPanel
            icon={<Search size={21} />}
            text="Enter at least two characters"
          />
        ) : results.length ? (
          <div className="search-results">
            {results.map((result, index) => (
              <button
                key={`${result.cfi}-${index}`}
                type="button"
                onClick={() => onNavigate(result.cfi)}
              >
                <strong>{result.chapter}</strong>
                <span>{result.excerpt}</span>
              </button>
            ))}
          </div>
        ) : !searching ? (
          <EmptyPanel icon={<Search size={21} />} text="No matches" />
        ) : null}
      </div>
    </aside>
  );
}

type SettingsTab = 'bionic' | 'typography' | 'page' | 'appearance';

const SETTINGS_TABS: Array<{
  id: SettingsTab;
  label: string;
  icon: ReactNode;
}> = [
  { id: 'bionic', label: 'Bionic', icon: <ScanText size={15} /> },
  { id: 'typography', label: 'Text', icon: <TypeIcon size={15} /> },
  { id: 'page', label: 'Page', icon: <FileText size={15} /> },
  { id: 'appearance', label: 'Theme', icon: <Palette size={15} /> },
];

function SettingsDrawer({
  settings,
  onChange,
  onReset,
  onClose,
}: {
  settings: ReaderSettings;
  onChange: (patch: Partial<ReaderSettings>) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('bionic');

  return (
    <aside
      className="reader-drawer reader-drawer-right settings-panel"
      aria-label="Reading settings"
    >
      <DrawerHeader
        title="Reading settings"
        onClose={onClose}
        action={
          <IconButton label="Reset settings" onClick={onReset}>
            <RotateCcw size={16} />
          </IconButton>
        }
      />
      <div className="settings-tabs" role="tablist" aria-label="Setting groups">
        {SETTINGS_TABS.map(tab => (
          <button
            id={`settings-tab-${tab.id}`}
            key={tab.id}
            type="button"
            role="tab"
            aria-controls={`settings-panel-${tab.id}`}
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>
      <div className="drawer-scroll settings-scroll">
        {activeTab === 'bionic' ? (
          <SettingsSection id="bionic" title="Bionic text">
            <ToggleRow
              label="Bionic text"
              description="Adds stronger word beginnings that act as visual anchors while you read."
              checked={settings.bionicEnabled}
              onChange={checked => onChange({ bionicEnabled: checked })}
            />
            <RangeRow
              label="Fixation"
              description="Sets how much of an emphasized word is bold. The slider shows the recommended range."
              min={0.25}
              max={0.8}
              hardMin={0.1}
              hardMax={1}
              step={0.05}
              scale={100}
              unit="%"
              precision={0}
              current={settings.fixation}
              disabled={!settings.bionicEnabled}
              onChange={fixation => onChange({ fixation })}
            />
            <RangeRow
              label="Frequency"
              description="Controls how often a word receives a bionic anchor: 1 means every word."
              min={1}
              max={5}
              hardMin={1}
              hardMax={20}
              step={1}
              precision={0}
              current={settings.frequency}
              disabled={!settings.bionicEnabled}
              onChange={frequency => onChange({ frequency })}
            />
            <SegmentedControl
              label="Weight"
              description="Chooses the font weight used for each bionic fixation."
              value={String(settings.boldWeight)}
              disabled={!settings.bionicEnabled}
              options={[
                ['600', '600'],
                ['700', '700'],
                ['800', '800'],
                ['900', '900'],
              ]}
              onChange={value =>
                onChange({
                  boldWeight: Number(value) as ReaderSettings['boldWeight'],
                })
              }
            />
            <RangeRow
              label="Text contrast"
              description="Changes the opacity of each word remainder while keeping the fixation fully visible."
              min={0.5}
              max={1}
              hardMin={0.1}
              hardMax={1}
              step={0.05}
              scale={100}
              unit="%"
              precision={0}
              current={settings.remainderOpacity}
              disabled={!settings.bionicEnabled}
              onChange={remainderOpacity => onChange({ remainderOpacity })}
            />
            <ToggleRow
              label="Underline original bold"
              description="Underlines text the publisher originally made bold so its intended emphasis is not lost."
              checked={settings.underlineOriginalBold}
              onChange={checked => onChange({ underlineOriginalBold: checked })}
            />
          </SettingsSection>
        ) : null}

        {activeTab === 'typography' ? (
          <SettingsSection id="typography" title="Typography">
            <SegmentedControl
              label="Typeface"
              description="Overrides the book font with a reading-focused typeface, or keeps a traditional book face."
              value={settings.font}
              className="font-options"
              options={[
                ['book', 'Book'],
                ['serif', 'Serif'],
                ['sans', 'Sans'],
                ['accessible', 'Accessible'],
              ]}
              onChange={font =>
                onChange({ font: font as ReaderSettings['font'] })
              }
            />
            <RangeRow
              label="Text size"
              description="Sets body text size. Use the number box for values outside the recommended slider range."
              min={14}
              max={30}
              hardMin={10}
              hardMax={72}
              step={1}
              unit="px"
              precision={0}
              current={settings.fontSize}
              onChange={fontSize => onChange({ fontSize })}
            />
            <RangeRow
              label="Line spacing"
              description="Controls the vertical distance between lines of text."
              min={1.3}
              max={2.1}
              hardMin={1}
              hardMax={4}
              step={0.05}
              precision={2}
              current={settings.lineHeight}
              onChange={lineHeight => onChange({ lineHeight })}
            />
            <RangeRow
              label="Letter spacing"
              description="Adds or removes space between individual characters."
              min={-0.2}
              max={2}
              hardMin={-2}
              hardMax={8}
              step={0.1}
              unit="px"
              precision={1}
              current={settings.letterSpacing}
              onChange={letterSpacing => onChange({ letterSpacing })}
            />
            <RangeRow
              label="Word spacing"
              description="Changes the horizontal gap between words."
              min={0}
              max={8}
              hardMin={-2}
              hardMax={24}
              step={0.5}
              unit="px"
              precision={1}
              current={settings.wordSpacing}
              onChange={wordSpacing => onChange({ wordSpacing })}
            />
            <AlignmentControl
              value={settings.textAlign}
              onChange={textAlign => onChange({ textAlign })}
            />
            <ToggleRow
              label="Hyphenation"
              description="Allows supported words to break across lines when space is tight."
              checked={settings.hyphenation}
              onChange={checked => onChange({ hyphenation: checked })}
            />
            <ToggleRow
              label="Font ligatures"
              description="Allows combined letter shapes such as fi and fl when the selected font supports them."
              checked={settings.ligatures}
              onChange={checked => onChange({ ligatures: checked })}
            />
          </SettingsSection>
        ) : null}

        {activeTab === 'page' ? (
          <SettingsSection id="page" title="Page">
            <SegmentedControl
              label="Page number"
              description="Shows a virtual EPUB page beside the chapter, optionally with the total, or hides it."
              value={settings.pageNumberDisplay}
              options={[
                ['number', 'Number'],
                ['number-total', 'Number / total'],
                ['hidden', 'Hidden'],
              ]}
              onChange={pageNumberDisplay =>
                onChange({
                  pageNumberDisplay: pageNumberDisplay as PageNumberDisplay,
                })
              }
            />
            <RangeRow
              label="Reading width"
              description="Sets the maximum width of the text column. The number box supports wider custom layouts."
              min={480}
              max={920}
              hardMin={280}
              hardMax={1600}
              step={20}
              unit="px"
              precision={0}
              current={settings.contentWidth}
              onChange={contentWidth => onChange({ contentWidth })}
            />
            <RangeRow
              label="Paragraph gap"
              description="Controls the vertical breathing room after paragraphs."
              min={0.4}
              max={2}
              hardMin={0}
              hardMax={6}
              step={0.1}
              unit="em"
              precision={1}
              current={settings.paragraphSpacing}
              onChange={paragraphSpacing => onChange({ paragraphSpacing })}
            />
          </SettingsSection>
        ) : null}

        {activeTab === 'appearance' ? (
          <SettingsSection id="appearance" title="Appearance">
            <ThemeControl
              value={settings.theme}
              onChange={theme => onChange({ theme })}
            />
            <PaperColorControl
              framed={settings.pageFrame}
              value={settings.paperColor}
              onChange={onChange}
            />
            <ToggleRow
              label="Paper texture"
              description="Adds a very subtle printed-paper grain to the page surface."
              checked={settings.paperTexture}
              disabled={!settings.pageFrame}
              onChange={paperTexture => onChange({ paperTexture })}
            />
            <TextColorControl
              value={settings.textColor}
              onChange={textColor => onChange({ textColor })}
            />
          </SettingsSection>
        ) : null}
      </div>
    </aside>
  );
}

function SettingsSection({
  id,
  title,
  children,
}: {
  id: SettingsTab;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      id={`settings-panel-${id}`}
      className="settings-section"
      role="tabpanel"
      aria-labelledby={`settings-tab-${id}`}
    >
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function SettingLabel({
  label,
  description,
}: {
  label: string;
  description: string;
}) {
  return (
    <span className="setting-label">
      <span>{label}</span>
      <span
        className="setting-help"
        tabIndex={0}
        aria-label={`${label}: ${description}`}
      >
        <CircleHelp size={13} aria-hidden="true" />
        <span className="setting-tooltip" role="tooltip">
          {description}
        </span>
      </span>
    </span>
  );
}

function RangeRow({
  label,
  description,
  min,
  max,
  hardMin,
  hardMax,
  step,
  current,
  scale = 1,
  unit = '',
  precision = 1,
  disabled = false,
  onChange,
}: {
  label: string;
  description: string;
  min: number;
  max: number;
  hardMin: number;
  hardMax: number;
  step: number;
  current: number;
  scale?: number;
  unit?: string;
  precision?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cancelBlurCommitRef = useRef(false);
  const formatValue = (value: number) => (value * scale).toFixed(precision);
  const [draft, setDraft] = useState(() => formatValue(current));

  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setDraft(formatValue(current));
    }
  }, [current, precision, scale]);

  const commitDraft = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(formatValue(current));
      return;
    }
    const normalized = Math.min(hardMax, Math.max(hardMin, parsed / scale));
    setDraft(formatValue(normalized));
    onChange(normalized);
  };
  const sliderValue = Math.min(max, Math.max(min, current));

  return (
    <div className="setting-control setting-range" data-disabled={disabled}>
      <div className="setting-range-header">
        <SettingLabel label={label} description={description} />
        <label className="setting-number">
          <span className="visually-hidden">{label} value</span>
          <input
            ref={inputRef}
            type="number"
            min={hardMin * scale}
            max={hardMax * scale}
            step={step * scale}
            value={draft}
            disabled={disabled}
            onChange={event => setDraft(event.currentTarget.value)}
            onBlur={() => {
              if (cancelBlurCommitRef.current) {
                cancelBlurCommitRef.current = false;
                return;
              }
              commitDraft();
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.currentTarget.blur();
              }
              if (event.key === 'Escape') {
                cancelBlurCommitRef.current = true;
                setDraft(formatValue(current));
                event.currentTarget.blur();
              }
            }}
          />
          {unit ? <span aria-hidden="true">{unit}</span> : null}
        </label>
      </div>
      <input
        aria-label={`${label} recommended range`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={sliderValue}
        disabled={disabled}
        onChange={event => {
          const value = Number(event.currentTarget.value);
          setDraft(formatValue(value));
          onChange(value);
        }}
      />
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="setting-control toggle-row" data-disabled={disabled}>
      <SettingLabel label={label} description={description} />
      <label className="toggle-control">
        <span className="visually-hidden">{label}</span>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={event => onChange(event.currentTarget.checked)}
        />
        <span className="toggle-track" aria-hidden="true">
          <span />
        </span>
      </label>
    </div>
  );
}

function PaperColorControl({
  framed,
  value,
  onChange,
}: {
  framed: boolean;
  value: string;
  onChange: (patch: Partial<ReaderSettings>) => void;
}) {
  const colors = [
    ['#ffffff', 'White'],
    ['#fbfaf7', 'Paper'],
    ['#f7f0df', 'Warm'],
    ['#eef2ec', 'Soft green'],
    ['#1d211f', 'Charcoal'],
  ];

  return (
    <div className="setting-control color-setting">
      <SettingLabel
        label="Page color"
        description="Sets the paper the book is printed on. Transparent drops the page frame and lets the theme show through."
      />
      <div className="color-options" role="group" aria-label="Page color">
        <button
          className="color-swatch color-swatch-none"
          type="button"
          title="Transparent"
          aria-label="Transparent"
          aria-pressed={!framed}
          onClick={() => onChange({ pageFrame: false })}
        />
        {colors.map(([color, label]) => (
          <button
            key={color}
            className="color-swatch"
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={framed && value === color}
            style={{ backgroundColor: color }}
            onClick={() => onChange({ pageFrame: true, paperColor: color })}
          />
        ))}
        <label className="color-picker" title="Custom color">
          <input
            type="color"
            aria-label="Custom page color"
            value={value}
            onChange={event =>
              onChange({
                pageFrame: true,
                paperColor: event.currentTarget.value,
              })
            }
          />
        </label>
      </div>
    </div>
  );
}

function TextColorControl({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const colors = [
    ['#1a1d1b', 'Ink'],
    ['#4a514d', 'Slate'],
    ['#4a3b2a', 'Sepia'],
    ['#edf1ec', 'Chalk'],
  ];

  return (
    <div className="setting-control color-setting">
      <SettingLabel
        label="Text color"
        description="Automatic follows the page color for safe contrast. Pick a color to set the book text yourself."
      />
      <div className="color-options" role="group" aria-label="Text color">
        <button
          className="color-swatch color-swatch-auto"
          type="button"
          title="Automatic"
          aria-label="Automatic"
          aria-pressed={value === 'auto'}
          onClick={() => onChange('auto')}
        />
        {colors.map(([color, label]) => (
          <button
            key={color}
            className="color-swatch"
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={value === color}
            style={{ backgroundColor: color }}
            onClick={() => onChange(color)}
          />
        ))}
        <label className="color-picker" title="Custom color">
          <input
            type="color"
            aria-label="Custom text color"
            value={value === 'auto' ? '#292c2a' : value}
            onChange={event => onChange(event.currentTarget.value)}
          />
        </label>
      </div>
    </div>
  );
}

function SegmentedControl({
  label,
  description,
  value,
  options,
  onChange,
  className = '',
  disabled = false,
}: {
  label: string;
  description: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className="setting-control segmented-setting" data-disabled={disabled}>
      <SettingLabel label={label} description={description} />
      <div className={`segmented-control ${className}`}>
        {options.map(([optionValue, optionLabel]) => (
          <button
            key={optionValue}
            type="button"
            aria-pressed={value === optionValue}
            disabled={disabled}
            onClick={() => onChange(optionValue)}
          >
            {optionLabel}
          </button>
        ))}
      </div>
    </div>
  );
}

function AlignmentControl({
  value,
  onChange,
}: {
  value: TextAlignment;
  onChange: (value: TextAlignment) => void;
}) {
  const options: Array<[TextAlignment, string, ReactNode]> = [
    ['publisher', 'Book alignment', <BookOpen size={16} key="book" />],
    ['left', 'Left aligned', <AlignLeft size={16} key="left" />],
    ['center', 'Centered', <AlignCenter size={16} key="center" />],
    ['right', 'Right aligned', <AlignRight size={16} key="right" />],
    ['justify', 'Justified', <AlignJustify size={16} key="justify" />],
  ];
  return (
    <div className="setting-control segmented-setting">
      <SettingLabel
        label="Alignment"
        description="Keeps the publisher's alignment or overrides paragraphs with a consistent alignment."
      />
      <div className="segmented-control icon-segments">
        {options.map(([optionValue, label, icon]) => (
          <button
            key={optionValue}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={value === optionValue}
            onClick={() => onChange(optionValue)}
          >
            {icon}
          </button>
        ))}
      </div>
    </div>
  );
}

function ThemeControl({
  value,
  onChange,
}: {
  value: ReaderTheme;
  onChange: (value: ReaderTheme) => void;
}) {
  const themes: ReaderTheme[] = ['paper', 'light', 'dark'];
  return (
    <div className="setting-control theme-setting">
      <SettingLabel
        label="Reader theme"
        description="Changes the surrounding reader chrome and the default unframed page colors."
      />
      <div className="theme-options" role="group" aria-label="Reader theme">
        {themes.map(theme => (
          <button
            key={theme}
            type="button"
            aria-pressed={value === theme}
            onClick={() => onChange(theme)}
          >
            <span
              className={`theme-swatch theme-swatch-${theme}`}
              aria-hidden="true"
            />
            <span>{theme[0].toUpperCase() + theme.slice(1)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function DrawerHeader({
  title,
  onClose,
  action,
}: {
  title: string;
  onClose: () => void;
  action?: ReactNode;
}) {
  return (
    <header className="drawer-header">
      <h2>{title}</h2>
      <div>
        {action}
        <IconButton label="Close panel" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </div>
    </header>
  );
}

function EmptyPanel({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="empty-panel">
      {icon}
      <span>{text}</span>
    </div>
  );
}

const SETUP_STEPS: Array<{ label: string; hint: string; href: string }> = [
  {
    label: 'Enable the Drive API',
    hint: 'Lets the reader keep files in your own Drive.',
    href: 'https://console.cloud.google.com/apis/library/drive.googleapis.com',
  },
  {
    label: 'Set up the sign-in screen',
    hint: 'Get started, then: any app name, your own email, audience External.',
    href: 'https://console.cloud.google.com/auth/overview',
  },
  {
    label: 'Add yourself as a test user',
    hint: 'Audience, then Test users. Only listed accounts may sign in.',
    href: 'https://console.cloud.google.com/auth/audience',
  },
];

function BookPanel({
  row,
  bookmarks,
  inAccount,
  busy,
  onSaveLocally,
  onFreeLocally,
  onSave,
  onOpenBookmark,
  onRemoveBookmark,
  onDelete,
  onClose,
}: {
  row: LibraryRow;
  bookmarks: SavedBookmark[];
  inAccount: boolean;
  busy: boolean;
  onSaveLocally: () => void;
  onFreeLocally: () => void;
  onSave: (patch: { title?: string; creator?: string; cover?: Blob }) => void;
  onOpenBookmark: (cfi: string) => void;
  onRemoveBookmark: (id: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(row.title);
  const [creator, setCreator] = useState(row.creator);
  const [confirming, setConfirming] = useState(false);
  const coverInput = useRef<HTMLInputElement | null>(null);
  // The URL is made and released by the same effect, so a remount gets a
  // fresh one rather than the handle a previous cleanup already revoked.
  const [cover, setCover] = useState<string | null>(null);

  useEffect(() => {
    if (!row.cover) {
      setCover(null);
      return;
    }
    const url = URL.createObjectURL(row.cover);
    setCover(url);
    return () => URL.revokeObjectURL(url);
  }, [row.cover]);

  function commit() {
    const patch: { title?: string; creator?: string } = {};
    if (title.trim() && title !== row.title) {
      patch.title = title.trim();
    }
    if (creator !== row.creator) {
      patch.creator = creator.trim();
    }
    if (patch.title || patch.creator !== undefined) {
      onSave(patch);
    }
  }

  return (
    <>
      <button
        className="setup-scrim"
        type="button"
        aria-label="Close"
        onClick={() => {
          commit();
          onClose();
        }}
      />
      <aside className="setup-panel book-panel" aria-label={row.title}>
        <div className="drawer-header">
          <h2>Book</h2>
          <IconButton
            label="Close"
            onClick={() => {
              commit();
              onClose();
            }}
          >
            <X size={17} />
          </IconButton>
        </div>

        <div className="setup-body">
          <div className="book-head">
            <button
              className="book-cover"
              type="button"
              title="Replace cover"
              aria-label="Replace cover"
              onClick={() => coverInput.current?.click()}
            >
              {cover ? <img src={cover} alt="" /> : <BookOpen size={24} />}
              <span className="book-cover-edit">
                <ImagePlus size={15} />
              </span>
            </button>
            <input
              ref={coverInput}
              className="visually-hidden"
              type="file"
              accept="image/*"
              onChange={event => {
                const picked = event.currentTarget.files?.[0];
                if (picked) {
                  onSave({ cover: picked });
                }
                event.currentTarget.value = '';
              }}
            />
            <div className="book-fields">
              <input
                aria-label="Title"
                placeholder="Title"
                value={title}
                onChange={event => setTitle(event.currentTarget.value)}
                onBlur={commit}
              />
              <input
                aria-label="Author"
                placeholder="Author"
                value={creator}
                onChange={event => setCreator(event.currentTarget.value)}
                onBlur={commit}
              />
            </div>
          </div>

          <div className="section-heading">
            <span>Bookmarks</span>
          </div>
          {bookmarks.length > 0 ? (
            <ul className="book-marks">
              {bookmarks
                .slice()
                .sort((first, second) => first.progress - second.progress)
                .map(mark => (
                  <li key={mark.id}>
                    <button
                      className="book-mark"
                      type="button"
                      disabled={!row.local}
                      onClick={() => onOpenBookmark(mark.cfi)}
                    >
                      <span>{mark.chapter || 'Saved location'}</span>
                      <small>{Math.round(mark.progress * 100)}%</small>
                    </button>
                    <IconButton
                      label="Remove bookmark"
                      onClick={() => onRemoveBookmark(mark.id)}
                    >
                      <Trash2 size={15} />
                    </IconButton>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="book-empty">None yet</p>
          )}

          <div className="book-actions">
            {row.local ? (
              <button
                className="book-offline"
                type="button"
                disabled={busy || !inAccount}
                title={
                  inAccount
                    ? 'Remove the copy on this device'
                    : 'Sync this book before freeing the space'
                }
                onClick={onFreeLocally}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <Check size={15} />
                )}
                <span>On this device</span>
              </button>
            ) : (
              <button
                className="book-offline"
                type="button"
                disabled={busy}
                onClick={onSaveLocally}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <CloudDownload size={15} />
                )}
                <span>Save on this device</span>
              </button>
            )}
            <button
              className="book-delete"
              type="button"
              data-confirming={confirming}
              onClick={() => (confirming ? onDelete() : setConfirming(true))}
              onBlur={() => setConfirming(false)}
            >
              <Trash2 size={15} />
              <span>{confirming ? 'Delete everywhere?' : 'Delete'}</span>
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

function DriveSetup({
  origin,
  clientId,
  error,
  onSave,
  onClose,
}: {
  origin: ReturnType<typeof describeDriveOrigin>;
  clientId: string;
  error: string;
  onSave: (clientId: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(clientId);
  const [copied, setCopied] = useState(false);
  const ready = /\.apps\.googleusercontent\.com$/.test(value.trim());

  return (
    <>
      <button
        className="setup-scrim"
        type="button"
        aria-label="Close setup"
        onClick={onClose}
      />
      <aside className="setup-panel" aria-label="Google Drive setup">
        <div className="drawer-header">
          <h2>Google Drive</h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={17} />
          </IconButton>
        </div>

        <div className="setup-body">
          {error ? (
            <p className="setup-error" role="alert">
              {error}
            </p>
          ) : null}

          <ol className="setup-steps">
            {SETUP_STEPS.map(step => (
              <li key={step.href}>
                <div>
                  <span>{step.label}</span>
                  <small>{step.hint}</small>
                </div>
                <a
                  href={step.href}
                  target="_blank"
                  rel="noreferrer"
                  title={step.label}
                  aria-label={step.label}
                >
                  <ExternalLink size={16} />
                </a>
              </li>
            ))}
            <li className="setup-origin">
              <div>
                <span>Create a Web application client</span>
                <small>Clients, then Create client. Authorised origin:</small>
                <code data-rejected={!origin.accepted}>
                  {origin.origin}
                  <button
                    type="button"
                    title={copied ? 'Copied' : 'Copy'}
                    aria-label={copied ? 'Copied' : 'Copy'}
                    onClick={() => {
                      void navigator.clipboard?.writeText(origin.origin);
                      setCopied(true);
                    }}
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </code>
                {origin.accepted ? null : (
                  <small className="setup-warning">
                    Google only accepts https, or localhost.{' '}
                    <a href={origin.localhost}>Open {origin.localhost}</a> on
                    this machine, or host it over https for other devices.
                  </small>
                )}
              </div>
              <a
                href="https://console.cloud.google.com/auth/clients"
                target="_blank"
                rel="noreferrer"
                title="Create a Web application client"
                aria-label="Create a Web application client"
              >
                <ExternalLink size={16} />
              </a>
            </li>
            <li>
              <form
                className="setup-field"
                onSubmit={event => {
                  event.preventDefault();
                  if (ready) {
                    onSave(value.trim());
                  }
                }}
              >
                <input
                  aria-label="Client ID"
                  placeholder="Paste the client ID"
                  spellCheck={false}
                  autoComplete="off"
                  value={value}
                  onChange={event => setValue(event.currentTarget.value)}
                />
                <button
                  type="submit"
                  title="Connect"
                  aria-label="Connect"
                  disabled={!ready}
                >
                  <ArrowRight size={16} />
                </button>
              </form>
            </li>
          </ol>
        </div>
      </aside>
    </>
  );
}

function DriveButton({
  status,
  message,
  onActivate,
}: {
  status: DriveStatus;
  message: string;
  onActivate: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const label =
    status === 'busy'
      ? 'Syncing'
      : status === 'offline'
      ? 'Offline · changes sync when you reconnect'
      : status === 'ready'
      ? 'Synced with Google Drive · shift-click to disconnect'
      : status === 'error'
      ? message || 'Sync failed'
      : 'Sync with Google Drive · shift-click for setup';

  return (
    <IconButton label={label} active={status === 'ready'} onClick={onActivate}>
      {status === 'busy' ? (
        <LoaderCircle className="spin" size={18} />
      ) : status === 'offline' ? (
        <CloudOff size={18} />
      ) : status === 'ready' ? (
        <CloudCheck size={18} />
      ) : status === 'error' ? (
        <CloudAlert size={18} />
      ) : (
        <Cloud size={18} />
      )}
    </IconButton>
  );
}

function IconButton({
  label,
  children,
  onClick,
  active = false,
  disabled = false,
}: {
  label: string;
  children: ReactNode;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className="icon-button"
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function useDelayedFlag(active: boolean, delay: number) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), delay);
    return () => window.clearTimeout(timer);
  }, [active, delay]);

  return visible;
}

function sameSection(first: string, second: string) {
  const clean = (value: string) =>
    decodeURIComponent(value.split('#')[0] ?? '').replace(/^\.\//, '');
  const left = clean(first);
  const right = clean(second);
  return Boolean(
    left &&
      right &&
      (left === right || left.endsWith(right) || right.endsWith(left)),
  );
}
