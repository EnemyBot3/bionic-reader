import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Emits a service worker that precaches this exact build.
 *
 * The asset names are content hashed, so the list has to be written at build
 * time or it rots the moment anything changes. Everything the reader needs to
 * start is cached, including the PDF chunk, so an import works on a train.
 */
function serviceWorker(): Plugin {
  return {
    name: 'bionic-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter(name => !name.endsWith('.map'))
        .map(name => `./${name}`);
      const shell = [
        './',
        './manifest.webmanifest',
        './icon-192.png',
        './icon-512.png',
        './icon-maskable-512.png',
      ];
      const cached = [...new Set([...shell, ...assets])];
      const version = `bionic-${Date.now().toString(36)}`;

      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: `// Generated at build time. Do not edit.
const VERSION = ${JSON.stringify(version)};
const ASSETS = ${JSON.stringify(cached, null, 2)};

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION).then(cache => cache.addAll(ASSETS)),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(keys.filter(key => key !== VERSION).map(key => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

// The page asks the new worker to take over once a reload costs the reader
// nothing. Without this it would wait for every tab to close.
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'take-over') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }

  // Google's sign-in and Drive must never be served from a cache.
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  // Any navigation inside the app is the one page the app is made of.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('./').then(hit => hit || fetch(request)),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(hit => {
      if (hit) {
        return hit;
      }
      return fetch(request).then(response => {
        // A chunk this build did not know about, such as a lazily added one.
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(VERSION).then(cache => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
`,
      });
    },
  };
}

export default defineConfig({
  // Relative asset paths, so a build can be served from any static host or
  // subpath without being rebuilt for it.
  base: './',
  plugins: [react(), serviceWorker()],
});
