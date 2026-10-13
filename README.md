# Bionic Reader

A browser-only EPUB reader built with React, Vite, and EPUB.js. Books are opened and rendered locally in the browser.

## Run locally

```sh
npm install
npm run dev
```

The development server prints the local URL. Chrome is the supported browser.

## Verify a build

```sh
npm run typecheck
npm run build
```

## Sync across devices (optional)

Books, reading position, bookmarks, and settings can follow you between devices
through your own Google Drive. There is no server and no database: the app
writes into Drive's hidden per-app folder, which only this app can read.

Every book you open is uploaded once, in 4 MB slices, and any device signed
into the same account lists it and can pull it down on demand. Books stay
cached locally after that, so a book is only fetched once per device.

The cloud icon in the header walks through the one-time setup. It links
straight to each Google Cloud page involved, says what to enter there, shows
the exact origin to authorise, and takes the client ID at the end. A failed
sign-in reopens it with the reason and the step that fixes it.

The client ID is not a secret and is not tied to a device: set it up once and
paste the same ID on every other device, or put it in `.env.local` so a build
carries it. Steps 1 to 3 are only ever done once per Google account.

Shift-clicking the icon disconnects when connected, and reopens the setup when
not. A failed sign-in reopens it too, with the reason shown.

Google issues no refresh token to browser apps, so a session lasts about an
hour, after which the next click signs back in.

Baking the client ID into a build instead is still possible: copy
`.env.example` to `.env.local` and set `VITE_GOOGLE_CLIENT_ID`.

## Reader features

- Continuous vertical EPUB reading
- Publisher structure, headings, alignment, images, links, and embedded fonts
- Adjustable bionic fixation, frequency, weight, and contrast
- Original bold emphasis represented with underlines
- Font, sizing, spacing, width, alignment, ligature, hyphenation, and theme controls
- Table of contents, full-book search, bookmarks, progress seeking, and fullscreen
- Reading settings, last position, and the most recent local EPUB persisted in browser storage
- Optional Google Drive sync of the library, reading position, bookmarks, and settings
- Fixed-layout detection and clear errors for invalid or protected EPUBs

Legacy native project directories remain in the repository for history, but they are not referenced by the web package or its scripts.
