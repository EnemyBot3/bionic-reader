import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppWeb } from './AppWeb';
import { registerServiceWorker } from './appUpdate';
import './styles.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element not found');
}

createRoot(root).render(
  <StrictMode>
    <AppWeb />
  </StrictMode>,
);

// Served from a cache after the first visit, so the reader opens with no
// network. Only the built app has a worker; the dev server serves live files.
if (import.meta.env.PROD) {
  registerServiceWorker();
}
