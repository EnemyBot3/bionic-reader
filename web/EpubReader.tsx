import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type Ref,
} from 'react';
import ePub, {
  EpubCFI,
  type Book,
  type Contents,
  type Location,
  type NavItem,
  type Rendition,
} from 'epubjs';
import type Section from 'epubjs/types/section';
import type { RenditionOptions } from 'epubjs/types/rendition';
import {
  BIONIC_CFI_IGNORE_CLASS,
  applyPageFloor,
  measurePageHeight,
  enhanceDocument,
  enhanceSerializedDocument,
} from './epubEnhancer';
import type { ReaderSettings } from './readerSettings';
import { getBookKey, loadLocations, saveLocations } from './storage';

const PRELOAD_VIEWPORTS = 20;
const PRELOAD_CHARACTERS_PER_PAGE = 1400;
const RENDER_AHEAD_VIEWPORTS = 3;
// Enhanced sections are kept as strings. A 500 page book would hold the whole
// text in memory twice if this grew without a bound.
const PREPARED_SECTION_LIMIT = 16;
// Capturing an anchor walks the page, so it waits for scrolling to settle.
const ANCHOR_SETTLE_DELAY = 180;
const BLANK_CHECK_INTERVAL = 320;
const BLANK_GRACE = 480;
const BLANK_COVERAGE = 0.34;
const BLANK_RECOVERY_LIMIT = 4;

export type TocEntry = {
  id: string;
  href: string;
  label: string;
  depth: number;
};

export type BookDetails = {
  title: string;
  creator: string;
  description: string;
  language: string;
  identifier: string;
  coverUrl: string | null;
  fixedLayout: boolean;
  toc: TocEntry[];
};

export type ReadingLocation = {
  cfi: string;
  href: string;
  chapter: string;
  progress: number;
  pageNumber: string;
  totalPages: string | null;
  atStart: boolean;
  atEnd: boolean;
};

export type SearchResult = {
  cfi: string;
  excerpt: string;
  chapter: string;
};

/** Where a selection sits on screen, so a control can be put beside it. */
export type SelectionAnchor = {
  cfiRange: string;
  text: string;
  top: number;
  bottom: number;
  left: number;
};

export type EpubReaderHandle = {
  display: (target: string | number) => Promise<void>;
  /** Paint a passage, or repaint it in another colour. */
  markPassage: (cfiRange: string, colour: string) => void;
  unmarkPassage: (cfiRange: string) => void;
  clearSelection: () => void;
  previousChapter: () => Promise<void>;
  nextChapter: () => Promise<void>;
  goToProgress: (progress: number) => Promise<void>;
  search: (query: string) => Promise<SearchResult[]>;
  cancelSearch: () => void;
};

type Props = {
  file: File;
  initialCfi?: string;
  settings: ReaderSettings;
  onReady: (details: BookDetails) => void;
  onLocationChange: (location: ReadingLocation) => void;
  /** Passages to paint, re-applied whenever a section renders. */
  highlights: Array<{ cfiRange: string; colour: string }>;
  onSelect: (anchor: SelectionAnchor | null) => void;
  onLoadingChange: (loading: boolean) => void;
  onBlankChange: (blank: boolean) => void;
  onError: (message: string) => void;
};

type EpubSearchMatch = { cfi: string; excerpt: string };
type ContinuousRenditionOptions = RenditionOptions & { offset: number };
type ViewportAnchor = {
  cfi: string;
  viewportRatio: number;
  sectionIndex?: number;
  tokenIndex?: string;
};
type CaretDocument = Document & {
  caretPositionFromPoint?: (
    x: number,
    y: number,
  ) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};
type LocatedPoint = Location['start'] & { page?: string | number };
type PageListDetails = {
  firstPage?: number;
  lastPage?: number;
  totalPages?: number;
};
type ManagedView = { size: (width: number, height: number) => void };
type ContinuousManagerInternals = {
  settings?: { offset?: number };
  viewSettings?: { width?: number; height?: number };
  check?: (offsetLeft?: number, offsetTop?: number) => Promise<unknown>;
  createView?: (section: unknown, forceRight?: boolean) => ManagedView;
  fill?: () => Promise<void>;
  updateLayout?: () => void;
  bounds?: () => unknown;
  _bounds?: unknown;
  views?: { forEach: (callback: (view: ManagedView) => void) => void };
};
type RenditionInternals = Rendition & {
  manager?: ContinuousManagerInternals;
  resize: (width?: number, height?: number, epubcfi?: string) => void;
};

function flattenToc(items: NavItem[], depth = 0): TocEntry[] {
  return items.flatMap((item, index) => [
    {
      id: item.id || `${depth}-${index}-${item.href}`,
      href: item.href,
      label: item.label.trim(),
      depth,
    },
    ...flattenToc(item.subitems ?? [], depth + 1),
  ]);
}

function cleanHref(href: string) {
  return decodeURIComponent(href.split('#')[0] ?? href).replace(/^\.\//, '');
}

function chapterForHref(href: string, toc: TocEntry[]) {
  const cleanLocation = cleanHref(href);
  const exact = toc.find(entry => cleanHref(entry.href) === cleanLocation);
  if (exact) {
    return exact.label;
  }

  const partial = [...toc]
    .reverse()
    .find(
      entry =>
        cleanLocation.endsWith(cleanHref(entry.href)) ||
        cleanHref(entry.href).endsWith(cleanLocation),
    );
  return partial?.label ?? '';
}

function messageForError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/license|lcp|adept|drm|decrypt|encrypted/i.test(message)) {
    return 'This EPUB appears to be DRM-protected and cannot be opened in a browser reader.';
  }
  if (/zip|central directory|container|opf/i.test(message)) {
    return 'This file is not a valid EPUB, or its book package is damaged.';
  }
  return 'The EPUB could not be opened. It may be damaged or use an unsupported protection format.';
}

function getApproximateProgress(location: Location, spineLength: number) {
  const displayed = location.start.displayed;
  const sectionProgress = displayed?.total
    ? Math.max(0, displayed.page - 1) / displayed.total
    : 0;
  return Math.min(
    1,
    Math.max(
      0,
      (location.start.index + sectionProgress) / Math.max(1, spineLength),
    ),
  );
}

function documentSettingsKey(settings: ReaderSettings) {
  return JSON.stringify([
    settings.bionicEnabled,
    settings.fixation,
    settings.frequency,
    settings.boldWeight,
    settings.remainderOpacity,
    settings.underlineOriginalBold,
    settings.fontSize,
    settings.lineHeight,
    settings.letterSpacing,
    settings.wordSpacing,
    settings.paragraphSpacing,
    settings.contentWidth,
    settings.font,
    settings.textAlign,
    settings.hyphenation,
    settings.ligatures,
    settings.pageFrame,
    settings.paperTexture,
    settings.paperColor,
    settings.textColor,
    settings.theme,
  ]);
}

function getPageDetails(
  location: Location,
  book: Book,
  locationsReady: boolean,
) {
  const publisherPage = (location.start as LocatedPoint).page;
  if (publisherPage !== undefined && publisherPage !== -1) {
    const pageList = book.pageList as unknown as PageListDetails;
    const lastPage = Number(pageList.lastPage);
    return {
      pageNumber: String(publisherPage),
      totalPages:
        Number.isFinite(lastPage) && lastPage > 0 ? String(lastPage) : null,
    };
  }

  if (locationsReady && location.start.cfi) {
    const locationIndex = Number(
      book.locations.locationFromCfi(location.start.cfi),
    );
    if (Number.isFinite(locationIndex) && locationIndex >= 0) {
      return {
        pageNumber: String(locationIndex + 1),
        totalPages: String(Math.max(1, book.locations.length())),
      };
    }
  }

  return {
    pageNumber: String(Math.max(1, location.start.displayed?.page ?? 1)),
    totalPages: null,
  };
}

function getRenditionContents(rendition: Rendition): Contents[] {
  const value = rendition.getContents() as unknown;
  if (Array.isArray(value)) {
    return value as Contents[];
  }
  return value ? [value as Contents] : [];
}

function rangeAtPoint(document: Document, x: number, y: number) {
  const caretDocument = document as CaretDocument;
  const position = caretDocument.caretPositionFromPoint?.(x, y);
  if (position) {
    const range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    return range;
  }
  return caretDocument.caretRangeFromPoint?.(x, y) ?? null;
}

function isCloserToken(
  candidate: HTMLElement,
  closest: HTMLElement | null,
  localY: number,
  centerX: number,
) {
  const rect = candidate.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  if (!closest) {
    return true;
  }

  const closestRect = closest.getBoundingClientRect();
  const verticalDistance = Math.abs(rect.top - localY);
  const closestVerticalDistance = Math.abs(closestRect.top - localY);
  if (Math.abs(verticalDistance - closestVerticalDistance) > 1) {
    return verticalDistance < closestVerticalDistance;
  }
  return (
    Math.abs(rect.left + rect.width / 2 - centerX) <
    Math.abs(closestRect.left + closestRect.width / 2 - centerX)
  );
}

function findTokenNearY(
  document: Document,
  localY: number,
  frameWidth: number,
) {
  const tokens = document.querySelectorAll<HTMLElement>('.br-token');
  if (tokens.length === 0) {
    return null;
  }

  // Tokens follow document order, so their vertical position is monotonic.
  // Measuring every token of a long chapter costs whole frames, which is what
  // made scrolling fall behind; a binary search keeps it off the hot path.
  let low = 0;
  let high = tokens.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    const rect = tokens[middle].getBoundingClientRect();
    if (rect.height > 0 && rect.bottom < localY) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const centerX = frameWidth / 2;
  const first = Math.max(0, low - 40);
  const last = Math.min(tokens.length - 1, low + 40);
  let closest: HTMLElement | null = null;
  for (let index = first; index <= last; index += 1) {
    if (isCloserToken(tokens[index], closest, localY, centerX)) {
      closest = tokens[index];
    }
  }
  return closest;
}

function captureViewportAnchor(
  host: HTMLElement,
  rendition: Rendition,
): ViewportAnchor | null {
  const container = host.querySelector<HTMLElement>('.epub-container');
  if (!container) {
    return null;
  }

  const containerRect = container.getBoundingClientRect();
  const targetY = containerRect.top + containerRect.height / 2;
  const frames = Array.from(
    host.querySelectorAll<HTMLIFrameElement>('.epub-view iframe'),
  );
  const frame = frames.reduce<HTMLIFrameElement | null>(
    (closest, candidate) => {
      const rect = candidate.getBoundingClientRect();
      const distance =
        targetY < rect.top
          ? rect.top - targetY
          : targetY > rect.bottom
          ? targetY - rect.bottom
          : 0;
      if (!closest) {
        return candidate;
      }
      const closestRect = closest.getBoundingClientRect();
      const closestDistance =
        targetY < closestRect.top
          ? closestRect.top - targetY
          : targetY > closestRect.bottom
          ? targetY - closestRect.bottom
          : 0;
      return distance < closestDistance ? candidate : closest;
    },
    null,
  );
  const document = frame?.contentDocument;
  if (!frame || !document) {
    return null;
  }

  const frameRect = frame.getBoundingClientRect();
  const localY = Math.min(
    Math.max(1, targetY - frameRect.top),
    Math.max(1, frameRect.height - 1),
  );
  const xRatios = [0.5, 0.42, 0.58, 0.34, 0.66];
  const yOffsets = [0, -24, 24, -48, 48];
  let range: Range | null = null;

  for (const yOffset of yOffsets) {
    for (const xRatio of xRatios) {
      range = rangeAtPoint(
        document,
        frameRect.width * xRatio,
        Math.min(
          Math.max(1, localY + yOffset),
          Math.max(1, frameRect.height - 1),
        ),
      );
      if (range?.startContainer.nodeType === Node.TEXT_NODE) {
        break;
      }
      range = null;
    }
    if (range) {
      break;
    }
  }

  const contents = getRenditionContents(rendition).find(
    item => item.document === document,
  );
  if (!contents) {
    return null;
  }

  const rangeElement =
    range?.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range?.startContainer.parentElement;
  const pointedToken = rangeElement?.closest<HTMLElement>('.br-token');
  const token =
    pointedToken ?? findTokenNearY(document, localY, frameRect.width);
  const tokenText = token?.firstChild;
  if (token && tokenText?.nodeType === Node.TEXT_NODE) {
    const tokenRange = document.createRange();
    tokenRange.setStart(tokenText, 0);
    tokenRange.collapse(true);
    const tokenRect = token.getBoundingClientRect();

    try {
      return {
        cfi: contents.cfiFromRange(tokenRange, BIONIC_CFI_IGNORE_CLASS),
        viewportRatio: Math.min(
          1,
          Math.max(
            0,
            (frameRect.top + tokenRect.top - containerRect.top) /
              containerRect.height,
          ),
        ),
        sectionIndex: contents.sectionIndex,
        tokenIndex: token.dataset.brIndex,
      };
    } catch {
      // Fall through to a caret-based anchor for malformed book markup.
    }
  }

  if (!range) {
    return null;
  }

  try {
    const rangeRect = range.getBoundingClientRect();
    return {
      cfi: contents.cfiFromRange(range, BIONIC_CFI_IGNORE_CLASS),
      viewportRatio: Math.min(
        1,
        Math.max(
          0,
          (frameRect.top + rangeRect.top - containerRect.top) /
            containerRect.height,
        ),
      ),
      sectionIndex: contents.sectionIndex,
    };
  } catch {
    return null;
  }
}

function restoreViewportAnchor(
  host: HTMLElement,
  rendition: Rendition,
  anchor: ViewportAnchor,
) {
  const container = host.querySelector<HTMLElement>('.epub-container');
  if (!container) {
    return null;
  }

  try {
    const sectionIndex =
      anchor.sectionIndex ?? new EpubCFI(anchor.cfi).spinePos;
    const contents = getRenditionContents(rendition).find(
      item => item.sectionIndex === sectionIndex,
    );
    const token = anchor.tokenIndex
      ? contents?.document.querySelector<HTMLElement>(
          `.br-token[data-br-index="${anchor.tokenIndex}"]`,
        )
      : null;
    const range = token
      ? null
      : contents?.range(anchor.cfi, BIONIC_CFI_IGNORE_CLASS) ??
        rendition.getRange(anchor.cfi, BIONIC_CFI_IGNORE_CLASS);
    const document =
      token?.ownerDocument ?? range?.startContainer.ownerDocument;
    if (!document) {
      return null;
    }
    const frame = Array.from(
      host.querySelectorAll<HTMLIFrameElement>('.epub-view iframe'),
    ).find(candidate => candidate.contentDocument === document);
    if (!frame) {
      return null;
    }

    const anchorRect =
      token?.getBoundingClientRect() ?? range?.getBoundingClientRect();
    if (!anchorRect) {
      return null;
    }
    const frameRect = frame.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const targetY =
      containerRect.top + containerRect.height * anchor.viewportRatio;
    const delta = frameRect.top + anchorRect.top - targetY;
    if (Number.isFinite(delta) && Math.abs(delta) > 0.5) {
      container.scrollTop += delta;
    }
    return delta;
  } catch {
    return null;
  }
}

function refreshPageFloor(document: Document) {
  applyPageFloor(document);
  // Fonts and images land after the first measurement, so settle again.
  window.setTimeout(() => applyPageFloor(document), 400);
  document.fonts?.ready
    .then(() => applyPageFloor(document))
    .catch(() => {
      // A failed font load does not invalidate the first measurement.
    });
}

function whenIdle(timeout: number) {
  return new Promise<void>(resolve => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => resolve(), { timeout });
      return;
    }
    window.setTimeout(resolve, Math.min(timeout, 400));
  });
}

/**
 * EPUB.js draws a highlight as an overlay keyed by its range. Repainting the
 * same range in a new colour means removing the old overlay first.
 */
function paintHighlight(
  rendition: Rendition | null,
  cfiRange: string,
  colour: string,
) {
  if (!rendition) {
    return;
  }
  try {
    rendition.annotations.remove(cfiRange, 'highlight');
  } catch {
    // Nothing painted there yet.
  }
  try {
    rendition.annotations.highlight(
      cfiRange,
      {},
      undefined as unknown as (event: Event) => void,
      'br-mark',
      { fill: colour, 'fill-opacity': '0.32', 'mix-blend-mode': 'multiply' },
    );
  } catch {
    // A range that no longer resolves, such as text an edit removed.
  }
}

function nextAnimationFrame() {
  return new Promise<void>(resolve =>
    window.requestAnimationFrame(() => resolve()),
  );
}

function withTimeout<T>(promise: Promise<T>, timeout: number) {
  let timer: number | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = window.setTimeout(
      () => reject(new Error('EPUB operation timed out')),
      timeout,
    );
  });

  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
  });
}

function setReaderViewportHeight(document: Document, height: number) {
  document.documentElement.style.setProperty(
    '--br-reader-height',
    `${Math.max(1, Math.floor(height))}px`,
  );
}

async function waitForSectionView(
  host: HTMLElement,
  sectionIndex: number,
  timeout = 2400,
) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const frame = host.querySelector<HTMLIFrameElement>(
      `.epub-view[ref="${sectionIndex}"] iframe`,
    );
    if (
      frame?.contentDocument?.body &&
      frame.getBoundingClientRect().height > 0
    ) {
      return true;
    }
    await nextAnimationFrame();
  }
  return false;
}

async function waitForDocumentLayout(documents: Iterable<Document>) {
  const pending = Array.from(documents).flatMap(document => {
    const fonts = document.fonts ? [document.fonts.ready] : [];
    const images = Array.from(document.images).map(image => {
      if (image.complete) {
        return Promise.resolve();
      }
      return new Promise<void>(resolve => {
        image.addEventListener('load', () => resolve(), { once: true });
        image.addEventListener('error', () => resolve(), { once: true });
      });
    });
    return [...fonts, ...images];
  });

  await Promise.race([
    Promise.allSettled(pending),
    new Promise<void>(resolve => window.setTimeout(resolve, 1800)),
  ]);
  await new Promise<void>(resolve =>
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => resolve()),
    ),
  );
}

function EpubReaderComponent(
  {
    file,
    initialCfi,
    settings,
    highlights,
    onReady,
    onLocationChange,
    onSelect,
    onLoadingChange,
    onBlankChange,
    onError,
  }: Props,
  ref: Ref<EpubReaderHandle>,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const documentsRef = useRef<Set<Document>>(new Set());
  const settingsRef = useRef(settings);
  const tocRef = useRef<TocEntry[]>([]);
  const fixedLayoutRef = useRef(false);
  const locationsReadyRef = useRef(false);
  const locationsPromiseRef = useRef<Promise<void> | null>(null);
  const searchRunRef = useRef(0);
  const styleRunRef = useRef(0);
  const navigationRunRef = useRef(0);
  const layoutAnchorRef = useRef<ViewportAnchor | null>(null);
  const viewportAnchorRef = useRef<ViewportAnchor | null>(null);
  const navigateRef = useRef<(target: string | number) => Promise<void>>(
    async () => undefined,
  );
  const currentCfiRef = useRef(initialCfi ?? '');
  const suppressLocationRef = useRef(true);
  const highlightsRef = useRef(highlights);
  const callbacksRef = useRef({
    onReady,
    onLocationChange,
    onSelect,
    onLoadingChange,
    onBlankChange,
    onError,
  });

  settingsRef.current = settings;
  highlightsRef.current = highlights;
  callbacksRef.current = {
    onReady,
    onLocationChange,
    onSelect,
    onLoadingChange,
    onBlankChange,
    onError,
  };

  useImperativeHandle(
    ref,
    () => ({
      async display(target) {
        await navigateRef.current(target);
      },
      markPassage(cfiRange, colour) {
        paintHighlight(renditionRef.current, cfiRange, colour);
      },
      unmarkPassage(cfiRange) {
        try {
          renditionRef.current?.annotations.remove(cfiRange, 'highlight');
        } catch {
          // Already gone, which is the state the caller wanted.
        }
      },
      clearSelection() {
        for (const document of documentsRef.current) {
          document.defaultView?.getSelection()?.removeAllRanges();
        }
      },
      async previousChapter() {
        const book = bookRef.current;
        if (!book || !currentCfiRef.current) {
          await renditionRef.current?.prev();
          return;
        }
        const index = new EpubCFI(currentCfiRef.current).spinePos;
        await navigateRef.current(Math.max(0, index - 1));
      },
      async nextChapter() {
        const book = bookRef.current;
        if (!book || !currentCfiRef.current) {
          await renditionRef.current?.next();
          return;
        }
        const index = new EpubCFI(currentCfiRef.current).spinePos;
        await navigateRef.current(
          Math.min(book.packaging.spine.length - 1, index + 1),
        );
      },
      async goToProgress(progress) {
        const book = bookRef.current;
        if (!book) {
          return;
        }

        const normalized = Math.min(1, Math.max(0, progress));
        callbacksRef.current.onLoadingChange(true);
        if (!locationsReadyRef.current && locationsPromiseRef.current) {
          await Promise.race([
            locationsPromiseRef.current.catch(() => undefined),
            new Promise<void>(resolve => window.setTimeout(resolve, 120)),
          ]);
        }
        if (locationsReadyRef.current && book.locations.length() > 0) {
          const target = book.locations.cfiFromPercentage(normalized);
          await navigateRef.current(target);
          return;
        }

        const spineLength = book.packaging.spine.length;
        await navigateRef.current(
          Math.min(spineLength - 1, Math.floor(normalized * spineLength)),
        );
      },
      async search(query) {
        const book = bookRef.current;
        const normalized = query.trim();
        if (!book || normalized.length < 2) {
          return [];
        }

        const searchRun = ++searchRunRef.current;
        const sections: Section[] = [];
        book.spine.each((section: Section) => sections.push(section));
        const results: SearchResult[] = [];

        for (const section of sections) {
          if (searchRun !== searchRunRef.current || results.length >= 100) {
            break;
          }

          try {
            await section.load(book.load.bind(book));
            const matches = section.find(
              normalized,
            ) as unknown as EpubSearchMatch[];
            const chapter =
              chapterForHref(section.href, tocRef.current) ||
              'Untitled section';
            for (const match of matches) {
              results.push({
                cfi: match.cfi,
                excerpt: match.excerpt.replace(/\s+/g, ' ').trim(),
                chapter,
              });
              if (results.length >= 100) {
                break;
              }
            }
          } finally {
            section.unload();
          }

          await new Promise<void>(resolve => window.setTimeout(resolve, 0));
        }

        return results;
      },
      cancelSearch() {
        searchRunRef.current += 1;
      },
    }),
    [],
  );

  const contentSettingsKey = documentSettingsKey(settings);
  // A stable description of the marks, so the effect below runs when the set
  // really changes rather than on every render.
  const highlightKey = highlights
    .map(mark => `${mark.cfiRange}:${mark.colour}`)
    .join('|');

  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition) {
      return;
    }
    // Sections already on screen were rendered before these arrived.
    for (const mark of highlightsRef.current) {
      paintHighlight(rendition, mark.cfiRange, mark.colour);
    }
  }, [highlightKey]);

  useLayoutEffect(() => {
    const rendition = renditionRef.current;
    const host = hostRef.current;
    const anchor =
      layoutAnchorRef.current ??
      (rendition && host
        ? captureViewportAnchor(host, rendition) ??
          (currentCfiRef.current
            ? { cfi: currentCfiRef.current, viewportRatio: 0.12 }
            : null)
        : null);
    const run = ++styleRunRef.current;
    let cancelled = false;
    let finished = false;
    let settleTimer: number | undefined;
    let maximumTimer: number | undefined;
    let correctionFrame: number | undefined;
    let anchorObserver: ResizeObserver | undefined;

    if (rendition && host && !fixedLayoutRef.current && anchor) {
      suppressLocationRef.current = true;
      layoutAnchorRef.current = anchor;
      const finish = () => {
        if (finished || cancelled || run !== styleRunRef.current || !anchor) {
          return;
        }
        finished = true;
        if (settleTimer !== undefined) {
          window.clearTimeout(settleTimer);
        }
        if (maximumTimer !== undefined) {
          window.clearTimeout(maximumTimer);
        }
        restoreViewportAnchor(host, rendition, anchor);
        anchorObserver?.disconnect();
        layoutAnchorRef.current = null;
        viewportAnchorRef.current = anchor;
        suppressLocationRef.current = false;
        void rendition.reportLocation();
      };
      const scheduleFinish = () => {
        if (settleTimer !== undefined) {
          window.clearTimeout(settleTimer);
        }
        settleTimer = window.setTimeout(finish, 180);
      };

      anchorObserver = new ResizeObserver(() => {
        if (!cancelled && run === styleRunRef.current) {
          restoreViewportAnchor(host, rendition, anchor);
          scheduleFinish();
        }
      });
      host
        .querySelectorAll<HTMLElement>('.epub-view')
        .forEach(view => anchorObserver?.observe(view));
      maximumTimer = window.setTimeout(finish, 1200);
      scheduleFinish();
    }

    for (const document of documentsRef.current) {
      if (host) {
        setReaderViewportHeight(document, host.clientHeight);
      }
      enhanceDocument(document, settings, !fixedLayoutRef.current);
      if (!fixedLayoutRef.current) {
        applyPageFloor(document);
      }
    }

    if (!rendition || !host || fixedLayoutRef.current || !anchor) {
      layoutAnchorRef.current = null;
      anchorObserver?.disconnect();
      return;
    }

    restoreViewportAnchor(host, rendition, anchor);
    correctionFrame = window.requestAnimationFrame(() => {
      if (!cancelled && run === styleRunRef.current) {
        restoreViewportAnchor(host, rendition, anchor);
      }
    });

    return () => {
      cancelled = true;
      if (settleTimer !== undefined) {
        window.clearTimeout(settleTimer);
      }
      if (maximumTimer !== undefined) {
        window.clearTimeout(maximumTimer);
      }
      if (correctionFrame !== undefined) {
        window.cancelAnimationFrame(correctionFrame);
      }
      anchorObserver?.disconnect();
    };
  }, [contentSettingsKey]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    let cancelled = false;
    let resizeSettleTimer: number | undefined;
    let resizeCorrectionFrame: number | undefined;
    let anchorCaptureFrame: number | undefined;
    let anchorSettleTimer: number | undefined;
    let blankWatchdog: number | undefined;
    let activeResizeAnchor: ViewportAnchor | null = null;
    let resizeObserver: ResizeObserver | undefined;
    let viewResizeObserver: ResizeObserver | undefined;
    let viewportResizeHandler: (() => void) | undefined;
    let scrollContainer: HTMLElement | null = null;
    let scrollAnchorHandler: (() => void) | undefined;
    let navigationChain = Promise.resolve();
    const documents = documentsRef.current;
    callbacksRef.current.onLoadingChange(true);
    locationsReadyRef.current = false;
    locationsPromiseRef.current = null;
    currentCfiRef.current = initialCfi ?? '';
    viewportAnchorRef.current = null;
    suppressLocationRef.current = true;
    documents.clear();
    host.replaceChildren();

    const openBook = async () => {
      const data = await file.arrayBuffer();
      if (cancelled) {
        return;
      }

      // ArrayBuffer input is already the EPUB archive. Forcing "epub" makes
      // EPUB.js treat the buffer as a URL and leaves its ready promise pending.
      const book = ePub(data);
      bookRef.current = book;
      await book.ready;
      if (cancelled) {
        book.destroy();
        return;
      }

      // book.ready resolves before EPUB.js has unpacked the archive's images,
      // fonts and stylesheets into blob URLs. Rendering a section before then
      // leaves its assets pointing at paths no iframe can resolve, so covers
      // and illustrations never load.
      await withTimeout(book.opened, 8000).catch(() => undefined);
      if (cancelled) {
        book.destroy();
        return;
      }

      const [metadata, navigation, coverUrl] = await Promise.all([
        book.loaded.metadata,
        book.loaded.navigation,
        book.coverUrl().catch(() => null),
      ]);
      const toc = flattenToc(navigation.toc);
      const fixedLayout =
        metadata.layout === 'pre-paginated' || metadata.layout === 'fixed';
      tocRef.current = toc;
      fixedLayoutRef.current = fixedLayout;
      host.dataset.flow = fixedLayout ? 'fixed' : 'scrolled';
      const initialTarget = initialCfi || toc[0]?.href || undefined;
      const preparedSections = new Map<
        number,
        { settingsKey: string; output: string }
      >();

      if (!fixedLayout) {
        book.spine.hooks.serialize.register(
          (serialized: string, section: Section) => {
            const settingsKey = documentSettingsKey(settingsRef.current);
            const prepared = preparedSections.get(section.index);
            if (prepared?.settingsKey === settingsKey) {
              section.output = prepared.output;
              return;
            }

            // EPUB.js hands every serialize hook the same original markup, and
            // its own hook runs first to point images and styles at the blob
            // URLs unpacked from the archive. Building on section.output keeps
            // those, so covers and illustrations still load.
            const output = enhanceSerializedDocument(
              section.output ?? serialized,
              settingsRef.current,
            );
            if (preparedSections.size >= PREPARED_SECTION_LIMIT) {
              const oldest = preparedSections.keys().next().value;
              if (oldest !== undefined) {
                preparedSections.delete(oldest);
              }
            }
            preparedSections.set(section.index, { settingsKey, output });
            section.output = output;
          },
        );

        let preparedPages = 0;
        let preparedSectionCount = 0;
        const startIndex = initialTarget
          ? book.section(initialTarget).index
          : book.section(0).index;
        const spineLength = book.packaging.spine.length;

        for (
          let index = startIndex;
          index < spineLength &&
          (preparedPages < PRELOAD_VIEWPORTS || preparedSectionCount < 2) &&
          !cancelled;
          index += 1
        ) {
          const section = book.section(index);
          if (!section) {
            continue;
          }

          try {
            await section.render(book.load.bind(book));
            const body =
              section.document?.body ??
              section.document?.querySelector<HTMLElement>('body');
            const characterCount = body?.textContent?.trim().length ?? 0;
            preparedPages += Math.max(
              1,
              Math.ceil(characterCount / PRELOAD_CHARACTERS_PER_PAGE),
            );
            preparedSectionCount += 1;
          } finally {
            section.unload();
          }
        }
      }

      const hostBounds = host.getBoundingClientRect();
      const preloadDistance = Math.max(
        window.innerHeight,
        Math.floor(hostBounds.height * RENDER_AHEAD_VIEWPORTS),
      );
      const renditionOptions: ContinuousRenditionOptions = {
        manager: 'continuous',
        flow: 'scrolled-doc',
        spread: 'none',
        width: Math.max(1, Math.floor(hostBounds.width)),
        height: Math.max(1, Math.floor(hostBounds.height)),
        offset: preloadDistance,
        ignoreClass: BIONIC_CFI_IGNORE_CLASS,
        allowScriptedContent: false,
      };
      const rendition = book.renderTo(host, renditionOptions);
      renditionRef.current = rendition;

      rendition.hooks.content.register((contents: Contents) => {
        documents.add(contents.document);
        setReaderViewportHeight(contents.document, host.clientHeight);
        enhanceDocument(
          contents.document,
          settingsRef.current,
          !fixedLayoutRef.current,
        );
        if (!fixedLayoutRef.current) {
          contents.textHeight = () => measurePageHeight(contents.document);
          refreshPageFloor(contents.document);
          // Re-measure now so the first sizing picks up the full page.
          (contents as unknown as { resizeCheck: () => void }).resizeCheck();
        }

        // A section can be torn down and rebuilt at any time, so its marks
        // are painted again each time it comes back.
        for (const mark of highlightsRef.current) {
          paintHighlight(rendition, mark.cfiRange, mark.colour);
        }
      });

      rendition.on('selected', (cfiRange: string, contents: Contents) => {
        const selection = contents.window.getSelection();
        const text = selection?.toString().trim() ?? '';
        if (!text) {
          callbacksRef.current.onSelect(null);
          return;
        }

        const frame = Array.from(
          host.querySelectorAll<HTMLIFrameElement>('.epub-view iframe'),
        ).find(candidate => candidate.contentDocument === contents.document);
        const rect = selection?.getRangeAt(0).getBoundingClientRect();
        if (!frame || !rect) {
          return;
        }

        const frameRect = frame.getBoundingClientRect();
        callbacksRef.current.onSelect({
          cfiRange,
          text,
          top: frameRect.top + rect.top,
          bottom: frameRect.top + rect.bottom,
          left: frameRect.left + rect.left + rect.width / 2,
        });
      });

      rendition.hooks.unloaded.register((view: { contents?: Contents }) => {
        if (view.contents?.document) {
          documents.delete(view.contents.document);
        }
      });

      rendition.on('relocated', (location: Location) => {
        const cfi = location.start.cfi;
        currentCfiRef.current = cfi;
        if (suppressLocationRef.current) {
          return;
        }
        const progress =
          locationsReadyRef.current && cfi
            ? book.locations.percentageFromCfi(cfi)
            : getApproximateProgress(location, book.packaging.spine.length);
        const page = getPageDetails(location, book, locationsReadyRef.current);
        callbacksRef.current.onLocationChange({
          cfi,
          href: location.start.href,
          chapter: chapterForHref(location.start.href, tocRef.current),
          progress: Number.isFinite(progress) ? progress : 0,
          ...page,
          atStart: location.atStart,
          atEnd: location.atEnd,
        });
      });

      await rendition.started;
      const manager = (rendition as RenditionInternals).manager;
      if (manager?.settings) {
        manager.settings.offset = preloadDistance;
      }

      // EPUB.js can build a view before the stage size has reached its view
      // settings. The section then reflows inside a zero width frame, one word
      // per line, and the view measures hundreds of thousands of pixels tall.
      // Scroll compensation follows it there, which is how the reader ends up
      // parked in an empty scroll region with nothing on screen. Every view is
      // given the live reader size instead.
      const createView = manager?.createView;
      if (manager && createView) {
        manager.createView = (section, forceRight) => {
          const bounds = host.getBoundingClientRect();
          if (
            !fixedLayout &&
            manager.viewSettings &&
            bounds.width > 0 &&
            bounds.height > 0
          ) {
            manager.viewSettings.width = Math.floor(bounds.width);
            manager.viewSettings.height = Math.floor(bounds.height);
          }
          return createView.call(manager, section, forceRight);
        };
      }

      navigateRef.current = target => {
        const request = ++navigationRunRef.current;
        callbacksRef.current.onLoadingChange(true);

        const navigate = async () => {
          if (cancelled || request !== navigationRunRef.current) {
            return;
          }

          const previousCfi = currentCfiRef.current;
          suppressLocationRef.current = true;
          styleRunRef.current += 1;
          layoutAnchorRef.current = null;

          try {
            const targetSection =
              typeof target === 'number'
                ? book.section(target)
                : book.section(target);
            if (!targetSection) {
              throw new Error('EPUB target does not exist');
            }
            const targetIndex = targetSection.index;
            let previousIndex = targetIndex;
            if (previousCfi) {
              try {
                previousIndex = new EpubCFI(previousCfi).spinePos;
              } catch {
                // A stale saved CFI should not prevent a fresh navigation.
              }
            }
            const displayTarget = () =>
              typeof target === 'number'
                ? rendition.display(target)
                : rendition.display(target);
            let rendered = false;
            try {
              if (
                Math.abs(targetIndex - previousIndex) >
                RENDER_AHEAD_VIEWPORTS + 1
              ) {
                rendition.clear();
              }
              await withTimeout(displayTarget(), 3500);
              rendered = await waitForSectionView(host, targetIndex);
            } catch {
              rendered = false;
            }

            if (!rendered && !cancelled) {
              rendition.clear();
              await withTimeout(displayTarget(), 4500);
              rendered = await waitForSectionView(host, targetIndex, 3200);
            }

            if (!rendered) {
              throw new Error('EPUB section did not render');
            }

            await waitForDocumentLayout(documents);
            await withTimeout(displayTarget(), 3000);
            await nextAnimationFrame();
            await nextAnimationFrame();
            rendered = await waitForSectionView(host, targetIndex, 1200);
            if (!rendered) {
              throw new Error('EPUB section was lost while aligning');
            }
          } catch {
            if (previousCfi && !cancelled) {
              try {
                rendition.clear();
                await withTimeout(rendition.display(previousCfi), 3500);
                currentCfiRef.current = previousCfi;
              } catch {
                // Keep the loading surface instead of exposing an empty view.
              }
            }
          } finally {
            if (!cancelled && request === navigationRunRef.current) {
              suppressLocationRef.current = false;
              try {
                await withTimeout(rendition.reportLocation(), 1200);
              } catch {
                // Location reporting should never hold the reader UI hostage.
              }
              viewportAnchorRef.current = captureViewportAnchor(
                host,
                rendition,
              );
              callbacksRef.current.onLoadingChange(false);
            }
          }
        };

        navigationChain = navigationChain.catch(() => undefined).then(navigate);
        return navigationChain;
      };

      callbacksRef.current.onReady({
        title: metadata.title?.trim() || file.name.replace(/\.epub$/i, ''),
        creator: metadata.creator?.trim() || 'Unknown author',
        description: metadata.description?.trim() || '',
        language: metadata.language || '',
        identifier: metadata.identifier || '',
        coverUrl,
        fixedLayout,
        toc,
      });

      try {
        await rendition.display(initialTarget);
      } catch {
        await rendition.display();
      }

      // Continuous mode prepends neighbouring spine items after the first
      // display. Re-apply saved CFIs, or align a newly opened book to the
      // beginning of its first readable section after that prepend settles.
      if (initialTarget) {
        await waitForDocumentLayout(documents);
        if (!cancelled) {
          if (initialCfi) {
            await rendition.display(initialCfi);
          } else {
            const sectionIndex = book.section(initialTarget).index;
            const container =
              host.querySelector<HTMLElement>('.epub-container');
            if (container) {
              let stablePasses = 0;
              let previousOffset = -1;
              let previousViewCount = -1;
              for (let attempt = 0; attempt < 36 && !cancelled; attempt += 1) {
                const sectionView = host.querySelector<HTMLElement>(
                  `.epub-view[ref="${sectionIndex}"]`,
                );
                if (!sectionView) {
                  break;
                }
                container.scrollTop = sectionView.offsetTop;
                await new Promise<void>(resolve =>
                  window.setTimeout(resolve, 120),
                );
                const currentView = host.querySelector<HTMLElement>(
                  `.epub-view[ref="${sectionIndex}"]`,
                );
                const viewCount = host.querySelectorAll('.epub-view').length;
                const aligned =
                  currentView &&
                  Math.abs(container.scrollTop - currentView.offsetTop) < 2;
                const stableLayout =
                  aligned &&
                  currentView.offsetTop === previousOffset &&
                  viewCount === previousViewCount;
                stablePasses = stableLayout ? stablePasses + 1 : 0;
                previousOffset = currentView?.offsetTop ?? -1;
                previousViewCount = viewCount;
                if (stablePasses >= 3) {
                  break;
                }
              }
            }
          }
        }
      }

      let renderedWidth = Math.floor(hostBounds.width);
      let renderedHeight = Math.floor(hostBounds.height);
      let renderedPixelRatio = window.devicePixelRatio;

      scrollContainer = host.querySelector<HTMLElement>('.epub-container');
      const captureStableAnchor = () => {
        if (cancelled || activeResizeAnchor || suppressLocationRef.current) {
          return;
        }
        viewportAnchorRef.current = captureViewportAnchor(host, rendition);
      };
      // Anchor capture inspects the page, so it waits for the scroll to stop
      // instead of running on every frame of a fast flick.
      const scheduleStableAnchorCapture = () => {
        if (anchorSettleTimer !== undefined) {
          window.clearTimeout(anchorSettleTimer);
        }
        anchorSettleTimer = window.setTimeout(() => {
          anchorSettleTimer = undefined;
          if (anchorCaptureFrame !== undefined) {
            window.cancelAnimationFrame(anchorCaptureFrame);
          }
          anchorCaptureFrame = window.requestAnimationFrame(() => {
            anchorCaptureFrame = undefined;
            captureStableAnchor();
          });
        }, ANCHOR_SETTLE_DELAY);
      };
      scrollAnchorHandler = scheduleStableAnchorCapture;
      scrollContainer?.addEventListener('scroll', scrollAnchorHandler, {
        passive: true,
      });

      const correctResponsiveAnchor = () => {
        if (resizeCorrectionFrame !== undefined) {
          return;
        }
        resizeCorrectionFrame = window.requestAnimationFrame(() => {
          resizeCorrectionFrame = undefined;
          if (activeResizeAnchor && !cancelled) {
            restoreViewportAnchor(host, rendition, activeResizeAnchor);
          }
        });
      };

      const finishResponsiveLayout = () => {
        if (!activeResizeAnchor || cancelled) {
          return;
        }
        if (resizeCorrectionFrame !== undefined) {
          window.cancelAnimationFrame(resizeCorrectionFrame);
          resizeCorrectionFrame = undefined;
        }
        restoreViewportAnchor(host, rendition, activeResizeAnchor);
        viewportAnchorRef.current = activeResizeAnchor;
        activeResizeAnchor = null;
        viewResizeObserver?.disconnect();
        suppressLocationRef.current = false;
        void rendition.reportLocation();
      };

      const scheduleResponsiveFinish = () => {
        if (resizeSettleTimer !== undefined) {
          window.clearTimeout(resizeSettleTimer);
        }
        // EPUB.js performs a final content-size check at 350 ms. Keep the
        // anchor active through that pass so the last line-wrap cannot drift.
        resizeSettleTimer = window.setTimeout(finishResponsiveLayout, 440);
      };

      const observeCurrentViews = () => {
        viewResizeObserver?.disconnect();
        host
          .querySelectorAll<HTMLElement>('.epub-view')
          .forEach(view => viewResizeObserver?.observe(view));
      };

      viewResizeObserver = new ResizeObserver(() => {
        if (activeResizeAnchor && !cancelled) {
          correctResponsiveAnchor();
          scheduleResponsiveFinish();
        }
      });

      const applyResponsiveLayout = () => {
        const bounds = host.getBoundingClientRect();
        const width = Math.floor(bounds.width);
        const height = Math.floor(bounds.height);
        const pixelRatio = window.devicePixelRatio;
        if (
          width > 0 &&
          height > 0 &&
          renditionRef.current &&
          (Math.abs(width - renderedWidth) > 1 ||
            Math.abs(height - renderedHeight) > 1 ||
            pixelRatio !== renderedPixelRatio)
        ) {
          activeResizeAnchor ??=
            viewportAnchorRef.current ??
            captureViewportAnchor(host, rendition) ??
            (currentCfiRef.current
              ? { cfi: currentCfiRef.current, viewportRatio: 0.12 }
              : null);
          renderedWidth = width;
          renderedHeight = height;
          renderedPixelRatio = pixelRatio;
          if (activeResizeAnchor) {
            suppressLocationRef.current = true;
          }

          for (const document of documents) {
            setReaderViewportHeight(document, height);
            if (!fixedLayout) {
              applyPageFloor(document);
            }
          }

          observeCurrentViews();
          if (fixedLayout) {
            (rendition as RenditionInternals).resize(
              width,
              height,
              activeResizeAnchor?.cfi,
            );
          } else {
            manager?.updateLayout?.();
            manager?.views?.forEach(view => view.size(width, height));
            if (manager?.bounds) {
              manager._bounds = manager.bounds();
            }
            if (manager?.settings) {
              manager.settings.offset = Math.max(
                window.innerHeight,
                height * RENDER_AHEAD_VIEWPORTS,
              );
            }
          }

          if (activeResizeAnchor) {
            correctResponsiveAnchor();
            scheduleResponsiveFinish();
          }
        }
      };

      // A blank viewport is never an acceptable resting state. Watch for one
      // and climb out of it, cheapest correction first.
      let blankSince = 0;
      let recoveryStep = 0;
      let attempts = 0;
      let recovering = false;
      let reportedBlank = false;
      const reportBlank = (blank: boolean) => {
        if (blank !== reportedBlank) {
          reportedBlank = blank;
          callbacksRef.current.onBlankChange(blank);
        }
      };

      const viewportCoverage = () => {
        const container = host.querySelector<HTMLElement>('.epub-container');
        if (!container) {
          return 1;
        }
        const containerRect = container.getBoundingClientRect();
        if (containerRect.height <= 0) {
          return 1;
        }

        let covered = 0;
        host
          .querySelectorAll<HTMLIFrameElement>('.epub-view iframe')
          .forEach(frame => {
            if (
              !frame.contentDocument?.body ||
              frame.style.visibility === 'hidden'
            ) {
              return;
            }
            const rect = frame.getBoundingClientRect();
            const top = Math.max(rect.top, containerRect.top);
            const bottom = Math.min(rect.bottom, containerRect.bottom);
            if (bottom > top) {
              covered += bottom - top;
            }
          });
        // The tail of the last section is short by nature. Reaching the end of
        // what the book has is not the same as having nothing to show.
        const atEnd =
          container.scrollTop + container.clientHeight >=
          container.scrollHeight - 2;
        if (atEnd && covered > 0) {
          return 1;
        }
        return covered / containerRect.height;
      };

      const recoverFromBlank = async (step: number) => {
        const container = host.querySelector<HTMLElement>('.epub-container');
        if (!container) {
          return;
        }

        if (step === 0) {
          // Scrolled past what is rendered: return to solid ground and let the
          // manager fill the gap.
          const limit = Math.max(
            0,
            container.scrollHeight - container.clientHeight,
          );
          const clamped = Math.min(limit, Math.max(0, container.scrollTop));
          if (clamped !== container.scrollTop) {
            container.scrollTop = clamped;
          }
          await manager?.check?.();
          return;
        }

        if (step === 1) {
          const nearest = Array.from(
            host.querySelectorAll<HTMLElement>('.epub-view'),
          ).reduce<HTMLElement | null>((best, view) => {
            if (!view.querySelector('iframe')) {
              return best;
            }
            if (!best) {
              return view;
            }
            return Math.abs(view.offsetTop - container.scrollTop) <
              Math.abs(best.offsetTop - container.scrollTop)
              ? view
              : best;
          }, null);
          if (nearest) {
            container.scrollTop = nearest.offsetTop;
            await manager?.check?.();
            return;
          }
        }

        // Nothing usable is left on screen: rebuild around the last position.
        const cfi = currentCfiRef.current;
        if (!cfi) {
          return;
        }
        const navigationRun = navigationRunRef.current;
        suppressLocationRef.current = true;
        try {
          await withTimeout(rendition.display(cfi), 4000);
        } catch {
          // The next pass tries again while the page skeleton stays up.
        } finally {
          if (navigationRun === navigationRunRef.current) {
            suppressLocationRef.current = false;
            void rendition.reportLocation();
          }
        }
      };

      blankWatchdog = window.setInterval(() => {
        if (
          cancelled ||
          recovering ||
          window.document.hidden ||
          suppressLocationRef.current
        ) {
          blankSince = 0;
          return;
        }
        if (viewportCoverage() >= BLANK_COVERAGE) {
          blankSince = 0;
          recoveryStep = 0;
          attempts = 0;
          reportBlank(false);
          return;
        }

        const now = performance.now();
        if (blankSince === 0) {
          blankSince = now;
          return;
        }
        if (now - blankSince < BLANK_GRACE) {
          return;
        }

        blankSince = 0;
        if (attempts >= BLANK_RECOVERY_LIMIT) {
          // Something outside this reader is wrong. Stop retrying rather than
          // rebuilding the view on a loop.
          return;
        }

        reportBlank(true);
        recovering = true;
        attempts += 1;
        const step = recoveryStep;
        recoveryStep = Math.min(2, recoveryStep + 1);
        void recoverFromBlank(step).finally(() => {
          recovering = false;
        });
      }, BLANK_CHECK_INTERVAL);

      resizeObserver = new ResizeObserver(() => applyResponsiveLayout());
      resizeObserver.observe(host);
      viewportResizeHandler = applyResponsiveLayout;
      window.addEventListener('resize', viewportResizeHandler);
      window.visualViewport?.addEventListener('resize', viewportResizeHandler);

      if (cancelled) {
        return;
      }
      suppressLocationRef.current = false;
      await rendition.reportLocation();
      viewportAnchorRef.current = captureViewportAnchor(host, rendition);
      for (const mark of highlightsRef.current) {
        paintHighlight(rendition, mark.cfiRange, mark.colour);
      }
      callbacksRef.current.onLoadingChange(false);

      const bookKey = getBookKey(file);
      const generateLocations = async () => {
        const cached = loadLocations(bookKey);
        if (cached) {
          try {
            book.locations.load(cached);
            if (book.locations.length() > 0) {
              locationsReadyRef.current = true;
              if (!cancelled) {
                await rendition.reportLocation();
              }
              return;
            }
          } catch {
            // A damaged cache is simply rebuilt below.
          }
        }

        // Indexing reads every section of the book. On a 500 page book that is
        // seconds of work, so it waits until the first pages are on screen.
        await whenIdle(1200);
        if (cancelled) {
          return;
        }

        try {
          await book.locations.generate(1400);
          if (!cancelled) {
            locationsReadyRef.current = true;
            saveLocations(bookKey, book.locations.save());
            await rendition.reportLocation();
          }
        } catch {
          // Approximate spine progress remains available when indexing fails.
        }
      };

      locationsPromiseRef.current = generateLocations();
      void locationsPromiseRef.current;
    };

    void openBook().catch((error: unknown) => {
      if (!cancelled) {
        suppressLocationRef.current = false;
        callbacksRef.current.onLoadingChange(false);
        callbacksRef.current.onError(messageForError(error));
      }
    });

    return () => {
      cancelled = true;
      searchRunRef.current += 1;
      styleRunRef.current += 1;
      navigationRunRef.current += 1;
      navigateRef.current = async () => undefined;
      locationsPromiseRef.current = null;
      if (resizeSettleTimer !== undefined) {
        window.clearTimeout(resizeSettleTimer);
      }
      if (resizeCorrectionFrame !== undefined) {
        window.cancelAnimationFrame(resizeCorrectionFrame);
      }
      if (anchorCaptureFrame !== undefined) {
        window.cancelAnimationFrame(anchorCaptureFrame);
      }
      if (anchorSettleTimer !== undefined) {
        window.clearTimeout(anchorSettleTimer);
      }
      if (blankWatchdog !== undefined) {
        window.clearInterval(blankWatchdog);
      }
      resizeObserver?.disconnect();
      viewResizeObserver?.disconnect();
      if (scrollAnchorHandler) {
        scrollContainer?.removeEventListener('scroll', scrollAnchorHandler);
      }
      if (viewportResizeHandler) {
        window.removeEventListener('resize', viewportResizeHandler);
        window.visualViewport?.removeEventListener(
          'resize',
          viewportResizeHandler,
        );
      }
      documents.clear();
      viewportAnchorRef.current = null;
      callbacksRef.current.onBlankChange(false);
      try {
        renditionRef.current?.destroy();
      } catch {
        // EPUB.js may already have released the rendition during a failed open.
      }
      try {
        bookRef.current?.destroy();
      } catch {
        // Nothing remains to release.
      }
      renditionRef.current = null;
      bookRef.current = null;
      host.replaceChildren();
    };
  }, [file, initialCfi]);

  return <div className="epub-host" ref={hostRef} aria-label="Book content" />;
}

export const EpubReader = forwardRef(EpubReaderComponent);
