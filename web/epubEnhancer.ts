import {
  READER_PALETTES,
  type ReaderFont,
  type ReaderSettings,
} from './readerSettings';

const STYLE_ID = 'bionic-reader-overrides';
const PROCESSED_ATTRIBUTE = 'data-bionic-processed';
const EMPHASIS_ATTRIBUTE = 'data-bionic-emphasis';
const TOKEN_SETTINGS_ATTRIBUTE = 'data-bionic-tokens';
const PAGE_FLOOR_CLASS = 'br-page-floor';
export const BIONIC_CFI_IGNORE_CLASS = 'br-cfi-ignore';
const SKIP_SELECTOR = [
  'script',
  'style',
  'noscript',
  'svg',
  'math',
  'ruby',
  'rt',
  'rp',
  'pre',
  'code',
  'kbd',
  'samp',
  'textarea',
  'input',
  'select',
  'option',
  '[aria-hidden="true"]',
  `[${PROCESSED_ATTRIBUTE}]`,
].join(',');

const FONT_STACKS: Record<ReaderFont, string | null> = {
  book: null,
  serif: 'Charter, "Bitstream Charter", "Iowan Old Style", Georgia, serif',
  sans: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  accessible: 'Atkinson Hyperlegible, Verdana, Tahoma, sans-serif',
};

type WordPart = { text: string; word: boolean };

function getBody(document: Document) {
  return (document.body ??
    document.querySelector('body')) as HTMLElement | null;
}

function createHtmlElement<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tagName: K,
) {
  const namespace = document.documentElement.namespaceURI;
  return (
    namespace
      ? document.createElementNS(namespace, tagName)
      : document.createElement(tagName)
  ) as HTMLElementTagNameMap[K];
}

function segmentText(text: string): WordPart[] {
  if ('Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    return Array.from(segmenter.segment(text), part => ({
      text: part.segment,
      word: part.isWordLike ?? false,
    }));
  }

  const parts: WordPart[] = [];
  const expression = /[\p{L}\p{N}]+(?:[\u2019'\-][\p{L}\p{N}]+)*/gu;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = expression.exec(text))) {
    if (match.index > cursor) {
      parts.push({ text: text.slice(cursor, match.index), word: false });
    }
    parts.push({ text: match[0], word: true });
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), word: false });
  }

  return parts;
}

function splitGraphemes(word: string) {
  if ('Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter(undefined, {
      granularity: 'grapheme',
    });
    return Array.from(segmenter.segment(word), part => part.segment);
  }
  return Array.from(word);
}

function markOriginalEmphasis(document: Document) {
  document.querySelectorAll('b, strong').forEach(element => {
    element.classList.add('br-original-emphasis');
  });

  const window = document.defaultView;
  const body = getBody(document);
  // The computed-weight sweep needs a live view and only has to run once per
  // document. Repeating it on every re-render is a per-scroll layout tax.
  if (!window || !body || body.hasAttribute(EMPHASIS_ATTRIBUTE)) {
    return;
  }
  body.setAttribute(EMPHASIS_ATTRIBUTE, 'true');

  document
    .querySelectorAll('span, em, cite, mark, small, a')
    .forEach(element => {
      if (element.classList.contains(BIONIC_CFI_IGNORE_CLASS)) {
        return;
      }
      const weight = Number.parseInt(
        window.getComputedStyle(element).fontWeight,
        10,
      );
      const parentWeight = element.parentElement
        ? Number.parseInt(
            window.getComputedStyle(element.parentElement).fontWeight,
            10,
          )
        : 400;
      if (
        weight >= 600 &&
        (!Number.isFinite(parentWeight) || parentWeight < 600)
      ) {
        element.classList.add('br-original-emphasis');
      }
    });
}

function transformText(document: Document) {
  const body = getBody(document);
  if (!body) {
    return;
  }

  markOriginalEmphasis(document);
  if (body.hasAttribute(PROCESSED_ATTRIBUTE)) {
    return;
  }
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !node.nodeValue?.trim() || parent.closest(SKIP_SELECTOR)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  while (walker.nextNode()) {
    nodes.push(walker.currentNode as Text);
  }

  let wordIndex = 0;
  for (const node of nodes) {
    const fragment = document.createDocumentFragment();
    for (const part of segmentText(node.nodeValue ?? '')) {
      if (!part.word) {
        fragment.append(document.createTextNode(part.text));
        continue;
      }

      const start = createHtmlElement(document, 'span');
      const end = createHtmlElement(document, 'span');
      start.className = `br-token ${BIONIC_CFI_IGNORE_CLASS}`;
      end.className = `br-token-end ${BIONIC_CFI_IGNORE_CLASS}`;
      start.dataset.brWord = part.text;
      start.dataset.brIndex = String(wordIndex);
      fragment.append(start, end);
      wordIndex += 1;
    }
    node.replaceWith(fragment);
  }

  body.setAttribute(PROCESSED_ATTRIBUTE, 'true');
}

function updateBionicTokens(document: Document, settings: ReaderSettings) {
  document.querySelectorAll<HTMLElement>('.br-token').forEach(token => {
    const word = token.dataset.brWord ?? '';
    const index = Number.parseInt(token.dataset.brIndex ?? '0', 10);
    const active = settings.bionicEnabled && index % settings.frequency === 0;
    const remainder = token.nextElementSibling;

    if (!remainder?.classList.contains('br-token-end')) {
      return;
    }

    if (!active || !word) {
      token.classList.remove('br-fixation');
      remainder.classList.remove('br-remainder');
      token.textContent = word;
      remainder.textContent = '';
      return;
    }

    const characters = splitGraphemes(word);
    const splitAt = Math.max(
      1,
      Math.min(
        characters.length,
        Math.ceil(characters.length * settings.fixation),
      ),
    );
    token.classList.add('br-fixation');
    remainder.classList.add('br-remainder');
    token.textContent = characters.slice(0, splitAt).join('');
    remainder.textContent = characters.slice(splitAt).join('');
  });
}

function buildReaderCss(settings: ReaderSettings) {
  const palette = READER_PALETTES[settings.theme];
  const paperColor = settings.pageFrame ? settings.paperColor : palette.page;
  const paperRgb = parseHexColor(paperColor);
  const paperIsDark = relativeLuminance(paperRgb) < 0.42;
  const selection = selectionPalette(paperRgb, paperIsDark);
  const automaticTextColor = settings.pageFrame
    ? paperIsDark
      ? '#edf1ec'
      : '#292c2a'
    : palette.text;
  const textColor =
    settings.textColor === 'auto' ? automaticTextColor : settings.textColor;
  // Dimming the tail of a word with opacity also dims the selection highlight
  // drawn behind it, so the emphasised and plain halves of a word highlight in
  // different shades. Mixing the colour instead keeps one selection colour.
  const remainderMix = `${Math.round(settings.remainderOpacity * 100)}%`;
  const accentColor = settings.pageFrame
    ? paperIsDark
      ? '#7cc2ad'
      : '#2f705e'
    : palette.accent;
  const font = FONT_STACKS[settings.font];
  const fontRule = font ? `font-family: ${font} !important;` : '';
  const surroundColor = settings.pageFrame ? palette.app : paperColor;
  const bodyWidth = settings.pageFrame
    ? 'calc(100% - clamp(20px, 5vw, 64px))'
    : '100%';
  const bodyMargin = settings.pageFrame ? '18px auto 28px' : '0 auto';
  // Every section paints at least a full page, so a chapter that holds a
  // single line still reads as a page instead of a sliver.
  const bodyMinimumHeight = settings.pageFrame
    ? 'max(680px, calc(var(--br-reader-height, 766px) - 46px))'
    : 'max(560px, var(--br-reader-height, 766px))';
  const pageTexture =
    settings.pageFrame && settings.paperTexture
      ? `
        repeating-linear-gradient(
          0deg,
          rgba(${paperRgb.join(', ')}, 0) 0,
          rgba(${paperIsDark ? '255, 255, 255' : '45, 39, 29'}, 0.018) 1px,
          rgba(${paperRgb.join(', ')}, 0) 2px,
          rgba(${paperRgb.join(', ')}, 0) 5px
        ),
        repeating-linear-gradient(
          90deg,
          rgba(${paperRgb.join(', ')}, 0) 0,
          rgba(${paperIsDark ? '255, 255, 255' : '45, 39, 29'}, 0.012) 1px,
          rgba(${paperRgb.join(', ')}, 0) 2px,
          rgba(${paperRgb.join(', ')}, 0) 7px
        )`
      : 'none';
  const alignmentRule =
    settings.textAlign === 'publisher'
      ? ''
      : `p, dd, blockquote { text-align: ${settings.textAlign} !important; }`;

  return `
    :root {
      color-scheme: ${paperIsDark ? 'dark' : 'light'};
      background: ${surroundColor} !important;
      color: ${textColor} !important;
      caret-color: ${selection.background};
      font-size: ${settings.fontSize}px !important;
      --br-weight: ${settings.boldWeight};
    }

    html {
      background: ${surroundColor} !important;
      color: ${textColor} !important;
    }

    body {
      box-sizing: border-box !important;
      width: ${bodyWidth} !important;
      max-inline-size: ${settings.contentWidth}px !important;
      min-height: ${bodyMinimumHeight} !important;
      margin: ${bodyMargin} !important;
      padding: clamp(36px, 6vw, 76px) clamp(24px, 6vw, 72px) clamp(60px, 9vw, 112px) !important;
      border: ${
        settings.pageFrame
          ? `1px solid rgba(${
              paperIsDark ? '255, 255, 255' : '41, 44, 42'
            }, 0.18)`
          : '0'
      } !important;
      border-radius: ${settings.pageFrame ? '2px' : '0'} !important;
      background-color: ${paperColor} !important;
      background-image: ${pageTexture} !important;
      box-shadow: ${
        settings.pageFrame
          ? '0 1px 2px rgba(23, 27, 24, 0.1), 0 8px 24px rgba(23, 27, 24, 0.08)'
          : 'none'
      } !important;
      color: ${textColor} !important;
      ${fontRule}
      font-size: 1rem !important;
      line-height: ${settings.lineHeight} !important;
      letter-spacing: ${settings.letterSpacing}px !important;
      word-spacing: ${settings.wordSpacing}px !important;
      font-variant-ligatures: ${
        settings.ligatures ? 'common-ligatures' : 'none'
      } !important;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
      overflow-wrap: break-word;
      hyphens: ${settings.hyphenation ? 'auto' : 'none'} !important;
    }

    p, li, dd, dt, blockquote, figcaption {
      line-height: inherit !important;
      letter-spacing: inherit !important;
      word-spacing: inherit !important;
    }

    p {
      margin-block: 0 ${settings.paragraphSpacing}em !important;
    }

    h1, h2, h3, h4, h5, h6 {
      letter-spacing: 0 !important;
      line-height: 1.22 !important;
      text-wrap: balance;
    }

    img, svg, video, table {
      max-inline-size: 100% !important;
      block-size: auto;
    }

    a { color: ${accentColor} !important; }
    ::selection {
      background: ${selection.background};
      color: ${selection.text};
    }

    .${PAGE_FLOOR_CLASS} {
      display: block !important;
      width: 100% !important;
      margin: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      float: none !important;
      clear: both !important;
      pointer-events: none;
    }

    .br-token, .br-token-end { display: inline; }
    .br-fixation { font-weight: var(--br-weight) !important; }
    .br-remainder {
      color: color-mix(in srgb, currentColor ${remainderMix}, ${paperColor}) !important;
    }

    .br-original-emphasis {
      font-weight: inherit !important;
      text-decoration-line: ${
        settings.underlineOriginalBold ? 'underline' : 'none'
      } !important;
      text-decoration-thickness: 0.08em !important;
      text-underline-offset: 0.16em !important;
    }

    ${alignmentRule}

    ${
      settings.pageFrame
        ? `
      @media (max-width: 600px) {
        body {
          width: calc(100% - 12px) !important;
          min-height: max(560px, calc(var(--br-reader-height, 638px) - 18px)) !important;
          margin: 6px auto 12px !important;
        }
      }`
        : ''
    }
  `;
}

function parseHexColor(color: string): [number, number, number] {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}

function relativeLuminance([red, green, blue]: [number, number, number]) {
  const linear = [red, green, blue].map(channel => {
    const value = channel / 255;
    return value <= 0.04045
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function selectionPalette(
  [red, green, blue]: [number, number, number],
  paperIsDark: boolean,
) {
  const normalized = [red / 255, green / 255, blue / 255];
  const maximum = Math.max(...normalized);
  const minimum = Math.min(...normalized);
  const delta = maximum - minimum;
  let hue = 0;

  if (delta > 0) {
    if (maximum === normalized[0]) {
      hue = 60 * (((normalized[1] - normalized[2]) / delta) % 6);
    } else if (maximum === normalized[1]) {
      hue = 60 * ((normalized[2] - normalized[0]) / delta + 2);
    } else {
      hue = 60 * ((normalized[0] - normalized[1]) / delta + 4);
    }
  }

  if (hue < 0) {
    hue += 360;
  }

  const lightness = (maximum + minimum) / 2;
  const saturation =
    delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  const selectionHue = saturation < 0.08 ? 158 : Math.round(hue);
  const selectionSaturation = Math.round(
    Math.max(paperIsDark ? 42 : 46, saturation * 100),
  );

  return paperIsDark
    ? {
        background: `hsl(${selectionHue} ${selectionSaturation}% 72%)`,
        text: '#17201c',
      }
    : {
        background: `hsl(${selectionHue} ${selectionSaturation}% 27%)`,
        text: '#ffffff',
      };
}

function buildFixedLayoutCss(settings: ReaderSettings) {
  const palette = READER_PALETTES[settings.theme];
  return `
    ::selection {
      background: ${palette.accentSoft};
      color: inherit;
    }
  `;
}

function tokenSettingsKey(settings: ReaderSettings) {
  return [
    settings.bionicEnabled ? 1 : 0,
    settings.fixation,
    settings.frequency,
  ].join(':');
}

function parsePixels(value: string) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * EPUB.js sizes each frame from the bottom of the body's contents, so a short
 * section collapses to a few pixels no matter how tall the page is styled.
 * A trailing spacer pads the flow up to the painted page box, which keeps
 * one-line chapters looking like pages and keeps scroll heights predictable.
 */
export function applyPageFloor(document: Document) {
  const body = getBody(document);
  const view = document.defaultView;
  if (!body || !view) {
    return;
  }

  let floor = body.querySelector<HTMLElement>(`:scope > .${PAGE_FLOOR_CLASS}`);
  if (!floor) {
    floor = createHtmlElement(document, 'div');
    floor.className = `${PAGE_FLOOR_CLASS} ${BIONIC_CFI_IGNORE_CLASS}`;
    floor.setAttribute('aria-hidden', 'true');
  }
  if (floor !== body.lastElementChild) {
    // Staying last keeps every existing CFI in the section valid.
    body.append(floor);
  }

  floor.style.height = '0px';
  const style = view.getComputedStyle(body);
  const bodyRect = body.getBoundingClientRect();
  const pageBottom =
    bodyRect.bottom -
    parsePixels(style.paddingBottom) -
    parsePixels(style.borderBottomWidth);
  const range = document.createRange();
  range.selectNodeContents(body);
  const contentBottom = range.getBoundingClientRect().bottom;

  const missing = Math.floor(pageBottom - contentBottom);
  if (missing > 1) {
    floor.style.height = `${missing}px`;
  }
}

/**
 * EPUB.js only measures to the bottom of the body's text, which drops the
 * page's bottom padding, border and margin, so long sections clip at the
 * foot of the page. Measuring the body's margin box keeps the whole page.
 */
export function measurePageHeight(document: Document) {
  const body = getBody(document);
  const view = document.defaultView;
  if (!body || !view) {
    return 0;
  }

  const range = document.createRange();
  range.selectNodeContents(body);
  const contentBottom = range.getBoundingClientRect().bottom;
  const pageBottom =
    body.getBoundingClientRect().bottom +
    parsePixels(view.getComputedStyle(body).marginBottom);
  return Math.ceil(Math.max(contentBottom, pageBottom));
}

export function enhanceDocument(
  document: Document,
  settings: ReaderSettings,
  transform = true,
) {
  if (transform) {
    transformText(document);
  }

  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = createHtmlElement(document, 'style');
    style.id = STYLE_ID;
    const head = document.head ?? document.querySelector('head');
    if (!head) {
      return;
    }
    head.append(style);
  }
  // Fixed-layout books depend on exact publisher coordinates. Only customize
  // selection there; typography and reflow rules would damage the page.
  style.textContent = transform
    ? buildReaderCss(settings)
    : buildFixedLayoutCss(settings);

  if (!transform) {
    return;
  }

  // Sections are already tokenized while they are serialized. Re-running the
  // whole token pass when the same document is re-rendered costs whole frames
  // on long chapters, which is what makes fast scrolling fall behind.
  const body = getBody(document);
  const tokenKey = tokenSettingsKey(settings);
  if (body?.getAttribute(TOKEN_SETTINGS_ATTRIBUTE) === tokenKey) {
    return;
  }
  updateBionicTokens(document, settings);
  body?.setAttribute(TOKEN_SETTINGS_ATTRIBUTE, tokenKey);
}

export function enhanceSerializedDocument(
  serialized: string,
  settings: ReaderSettings,
  transform = true,
) {
  try {
    const document = new DOMParser().parseFromString(
      serialized,
      'application/xhtml+xml',
    );
    if (document.querySelector('parsererror')) {
      return serialized;
    }
    enhanceDocument(document, settings, transform);
    return new XMLSerializer().serializeToString(document);
  } catch {
    return serialized;
  }
}
