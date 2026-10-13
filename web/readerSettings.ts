import { getUpdatedAt, markUpdated } from './storage';

export type ReaderTheme = 'paper' | 'light' | 'dark';
export type ReaderFont = 'book' | 'serif' | 'sans' | 'accessible';
export type PageNumberDisplay = 'number' | 'number-total' | 'hidden';
export type TextAlignment =
  | 'publisher'
  | 'left'
  | 'center'
  | 'right'
  | 'justify';

export type ReaderSettings = {
  bionicEnabled: boolean;
  fixation: number;
  frequency: number;
  boldWeight: 600 | 700 | 800 | 900;
  remainderOpacity: number;
  underlineOriginalBold: boolean;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  wordSpacing: number;
  paragraphSpacing: number;
  contentWidth: number;
  font: ReaderFont;
  textAlign: TextAlignment;
  hyphenation: boolean;
  ligatures: boolean;
  pageNumberDisplay: PageNumberDisplay;
  pageFrame: boolean;
  paperTexture: boolean;
  paperColor: string;
  // A hex colour, or 'auto' to follow the page colour.
  textColor: string;
  theme: ReaderTheme;
};

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  bionicEnabled: true,
  fixation: 0.5,
  frequency: 1,
  boldWeight: 700,
  remainderOpacity: 0.82,
  underlineOriginalBold: true,
  fontSize: 19,
  lineHeight: 1.68,
  letterSpacing: 0,
  wordSpacing: 0,
  paragraphSpacing: 1,
  contentWidth: 720,
  font: 'book',
  textAlign: 'publisher',
  hyphenation: false,
  ligatures: true,
  pageNumberDisplay: 'number',
  pageFrame: true,
  paperTexture: true,
  paperColor: '#fbfaf7',
  textColor: 'auto',
  theme: 'paper',
};

export const READER_PALETTES = {
  paper: {
    app: '#e9ece8',
    surface: '#f7f7f4',
    page: '#fbfaf7',
    text: '#292c2a',
    muted: '#68706b',
    border: '#d5dad5',
    accent: '#2f705e',
    accentSoft: '#dfece6',
  },
  light: {
    app: '#edf0f2',
    surface: '#ffffff',
    page: '#ffffff',
    text: '#202422',
    muted: '#68706d',
    border: '#d8ddda',
    accent: '#286c61',
    accentSoft: '#dcece8',
  },
  dark: {
    app: '#111412',
    surface: '#191d1b',
    page: '#1d211f',
    text: '#edf1ec',
    muted: '#9ba59e',
    border: '#343b37',
    accent: '#72b9a4',
    accentSoft: '#263f37',
  },
} as const;

const SETTINGS_KEY = 'bionic-reader:settings:v2';

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const finiteNumber = (value: unknown, fallback: number) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

export function normalizeSettings(
  value: Partial<ReaderSettings>,
): ReaderSettings {
  const fontOptions: ReaderFont[] = ['book', 'serif', 'sans', 'accessible'];
  const alignOptions: TextAlignment[] = [
    'publisher',
    'left',
    'center',
    'right',
    'justify',
  ];
  const themeOptions: ReaderTheme[] = ['paper', 'light', 'dark'];
  const pageNumberOptions: PageNumberDisplay[] = [
    'number',
    'number-total',
    'hidden',
  ];
  const weight = Number(value.boldWeight);
  const hexColor = (value: unknown, fallback: string) =>
    typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
      ? value.toLowerCase()
      : fallback;
  const paperColor = hexColor(
    value.paperColor,
    DEFAULT_READER_SETTINGS.paperColor,
  );
  const textColor =
    value.textColor === 'auto'
      ? 'auto'
      : hexColor(value.textColor, DEFAULT_READER_SETTINGS.textColor);

  return {
    bionicEnabled: value.bionicEnabled ?? DEFAULT_READER_SETTINGS.bionicEnabled,
    fixation: clamp(
      finiteNumber(value.fixation, DEFAULT_READER_SETTINGS.fixation),
      0.1,
      1,
    ),
    frequency: Math.round(
      clamp(
        finiteNumber(value.frequency, DEFAULT_READER_SETTINGS.frequency),
        1,
        20,
      ),
    ),
    boldWeight: ([600, 700, 800, 900].includes(weight)
      ? weight
      : 700) as ReaderSettings['boldWeight'],
    remainderOpacity: clamp(
      finiteNumber(
        value.remainderOpacity,
        DEFAULT_READER_SETTINGS.remainderOpacity,
      ),
      0.1,
      1,
    ),
    underlineOriginalBold:
      value.underlineOriginalBold ??
      DEFAULT_READER_SETTINGS.underlineOriginalBold,
    fontSize: clamp(
      finiteNumber(value.fontSize, DEFAULT_READER_SETTINGS.fontSize),
      10,
      72,
    ),
    lineHeight: clamp(
      finiteNumber(value.lineHeight, DEFAULT_READER_SETTINGS.lineHeight),
      1,
      4,
    ),
    letterSpacing: clamp(
      finiteNumber(value.letterSpacing, DEFAULT_READER_SETTINGS.letterSpacing),
      -2,
      8,
    ),
    wordSpacing: clamp(
      finiteNumber(value.wordSpacing, DEFAULT_READER_SETTINGS.wordSpacing),
      -2,
      24,
    ),
    paragraphSpacing: clamp(
      finiteNumber(
        value.paragraphSpacing,
        DEFAULT_READER_SETTINGS.paragraphSpacing,
      ),
      0,
      6,
    ),
    contentWidth: clamp(
      finiteNumber(value.contentWidth, DEFAULT_READER_SETTINGS.contentWidth),
      280,
      1600,
    ),
    font: fontOptions.includes(value.font as ReaderFont)
      ? (value.font as ReaderFont)
      : DEFAULT_READER_SETTINGS.font,
    textAlign: alignOptions.includes(value.textAlign as TextAlignment)
      ? (value.textAlign as TextAlignment)
      : DEFAULT_READER_SETTINGS.textAlign,
    hyphenation: value.hyphenation ?? DEFAULT_READER_SETTINGS.hyphenation,
    ligatures: value.ligatures ?? DEFAULT_READER_SETTINGS.ligatures,
    pageNumberDisplay: pageNumberOptions.includes(
      value.pageNumberDisplay as PageNumberDisplay,
    )
      ? (value.pageNumberDisplay as PageNumberDisplay)
      : DEFAULT_READER_SETTINGS.pageNumberDisplay,
    pageFrame: value.pageFrame ?? DEFAULT_READER_SETTINGS.pageFrame,
    paperTexture: value.paperTexture ?? DEFAULT_READER_SETTINGS.paperTexture,
    paperColor,
    textColor,
    theme: themeOptions.includes(value.theme as ReaderTheme)
      ? (value.theme as ReaderTheme)
      : DEFAULT_READER_SETTINGS.theme,
  };
}

export function loadReaderSettings(): ReaderSettings {
  try {
    const stored = window.localStorage.getItem(SETTINGS_KEY);
    return stored
      ? normalizeSettings(JSON.parse(stored) as Partial<ReaderSettings>)
      : DEFAULT_READER_SETTINGS;
  } catch {
    return DEFAULT_READER_SETTINGS;
  }
}

export function saveReaderSettings(settings: ReaderSettings) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Reading still works when storage is blocked.
  }
}

/**
 * Only a deliberate edit counts as a change. Persisting the defaults at startup
 * must not make a brand new device look newer than the rest of the account.
 */
export function markSettingsEdited() {
  markUpdated(SETTINGS_KEY);
}

export function getSettingsUpdatedAt() {
  return getUpdatedAt(SETTINGS_KEY);
}

export function applyRemoteSettings(
  settings: ReaderSettings,
  updatedAt: number,
) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    markUpdated(SETTINGS_KEY, updatedAt);
  } catch {
    // The next sync tries again.
  }
}
