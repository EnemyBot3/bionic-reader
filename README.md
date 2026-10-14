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
npm test
npm run build
```

The tests cover the logic that has broken before: snapshot merging and the
deletion tombstones, the PDF structure heuristics, the EPUB writer, and the
book keys that have to match across devices. They run on every push, and a
failure stops the deployment.

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

## Offline

The reader installs itself. After the first visit a service worker holds the
whole app, so it opens with no network at all, and the manifest lets it be
added to a home screen as its own application rather than a browser tab.

Books are stored on the device as they are opened, and the browser is asked to
keep them rather than evicting them when space runs short. A book that lives
only in the account shows a download control in its panel; the same control
frees the space again afterwards, keeping the cover and the account copy.

Syncing waits for a connection rather than failing: the cloud icon says when
it is offline, and the queued changes go up when the network returns.

## PDFs

EPUB is the format this reader is built for. PDFs are accepted on a best
effort basis: a PDF describes where glyphs sit on a page and says nothing
about paragraphs or reading order, so importing one extracts its text, infers
the structure, and builds an EPUB from the result. From then on it is an
ordinary book — it reflows, syncs, and takes bookmarks.

That works well for single-column prose. Columns are detected and read one
after the other, but the reader says so, because the order can still be wrong.
A scanned PDF holds no text at all and is refused rather than imported empty.
Images, tables and footnotes are dropped.

## Reader features

- Continuous vertical EPUB reading
- Publisher structure, headings, alignment, images, links, and embedded fonts
- Adjustable bionic fixation, frequency, weight, and contrast
- Original bold emphasis represented with underlines
- Font, sizing, spacing, width, alignment, ligature, hyphenation, and theme controls
- Table of contents, full-book search, bookmarks, progress seeking, and fullscreen
- Reading settings, last position, and the most recent local EPUB persisted in browser storage
- Optional Google Drive sync of the library, reading position, bookmarks, and settings
- Best-effort PDF import, converted to EPUB on the way in
- Fixed-layout detection and clear errors for invalid or protected EPUBs

Legacy native project directories remain in the repository for history, but they are not referenced by the web package or its scripts.
