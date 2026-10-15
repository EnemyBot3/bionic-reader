/**
 * Keeps the running app on the newest build.
 *
 * A new worker installs beside the old one and then waits, and while it waits
 * every reload is served the build the reader already had. So the page asks it
 * to take over at a moment where starting again costs nothing: back at the
 * shelf, or with the tab in the background.
 */
let waiting: ServiceWorker | null = null;
let reading = false;
let reloading = false;

/** True once a worker was already in charge, so the first visit never reloads. */
let wasControlled = false;

function takeOver() {
  if (!waiting) {
    return;
  }
  waiting.postMessage({ type: 'take-over' });
  waiting = null;
}

/** Hold an update back while a book is open. */
export function holdUpdateWhileReading(open: boolean) {
  reading = open;
  if (!open) {
    takeOver();
  }
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  wasControlled = Boolean(navigator.serviceWorker.controller);

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!wasControlled || reloading) {
      return;
    }
    reloading = true;
    window.location.reload();
  });

  document.addEventListener('visibilitychange', () => {
    // Not while a note is half typed.
    if (
      document.visibilityState === 'hidden' &&
      document.activeElement?.tagName !== 'TEXTAREA'
    ) {
      takeOver();
    }
  });

  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('sw.js')
      .then(registration => {
        const watch = (worker: ServiceWorker | null) => {
          if (!worker) {
            return;
          }
          const check = () => {
            if (
              worker.state === 'installed' &&
              navigator.serviceWorker.controller
            ) {
              waiting = worker;
              if (!reading) {
                takeOver();
              }
            }
          };
          worker.addEventListener('statechange', check);
          check();
        };

        watch(registration.waiting);
        registration.addEventListener('updatefound', () =>
          watch(registration.installing),
        );
      })
      .catch(() => {
        // Without a worker the reader still works, just not offline.
      });
  });
}
