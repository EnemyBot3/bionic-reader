/**
 * Google Drive sync, with no backend of any kind.
 *
 * Reading state lives in the caller's own Drive, inside the hidden
 * appDataFolder that only this app can see. Sign-in gives us an access token;
 * the token is the identity, so there is nothing to store on our side.
 *
 * Google's browser flow issues no refresh token, so the token lasts about an
 * hour and a new one needs a real click. Everything here is written to fail
 * softly back to "needs a click" instead of blocking the reader.
 */

const ENV_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as
  | string
  | undefined;
const CLIENT_ID_KEY = 'bionic-reader:drive-client-id';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const CLIENT_SRC = 'https://accounts.google.com/gsi/client';
const TOKEN_KEY = 'bionic-reader:drive-token';
const CONNECTED_KEY = 'bionic-reader:drive-connected';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
// Tokens are refused a little before they expire so a sync cannot die midway.
const EXPIRY_MARGIN = 60_000;

type TokenResponse = {
  access_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
};

/**
 * Google's sign-in errors are codes. Each one points at a single step of the
 * setup, so say which, rather than passing the code on.
 */
function explainSignIn(code: string | undefined, fallback: string) {
  switch (code) {
    case 'access_denied':
    case 'admin_policy_enforced':
      return 'That account is not on the test user list yet, or consent was declined.';
    case 'invalid_client':
    case 'unauthorized_client':
      return 'Google does not recognise that client ID.';
    case 'invalid_request':
    case 'idpiframe_initialization_failed':
      return `This address is not an authorised origin on the client: ${window.location.origin}`;
    case 'popup_closed':
    case 'popup_closed_by_user':
      return 'The Google window closed before sign-in finished.';
    case 'popup_failed_to_open':
      return 'The browser blocked the Google window.';
    default:
      return fallback;
  }
}

type TokenClient = { requestAccessToken: () => void };

type GoogleOAuth = {
  initTokenClient: (config: {
    client_id: string;
    scope: string;
    prompt?: string;
    callback: (response: TokenResponse) => void;
    error_callback?: (error: { type?: string; message?: string }) => void;
  }) => TokenClient;
  revoke: (token: string, done?: () => void) => void;
};

type GoogleNamespace = { accounts?: { oauth2?: GoogleOAuth } };

declare global {
  interface Window {
    google?: GoogleNamespace;
  }
}

/** Thrown when Drive needs the user to sign in again. */
export class DriveAuthError extends Error {
  constructor(message = 'Google Drive needs you to sign in again.') {
    super(message);
    this.name = 'DriveAuthError';
  }
}

type StoredToken = { value: string; expiresAt: number };

let clientPromise: Promise<GoogleOAuth> | null = null;

/**
 * The OAuth client the reader signs in with. It belongs to whoever runs the
 * app, so it is set up in the app itself; a build-time variable still works
 * for anyone who would rather bake it in.
 */
export function getDriveClientId() {
  try {
    return window.localStorage.getItem(CLIENT_ID_KEY) || ENV_CLIENT_ID || '';
  } catch {
    return ENV_CLIENT_ID || '';
  }
}

export function setDriveClientId(clientId: string) {
  try {
    window.localStorage.setItem(CLIENT_ID_KEY, clientId.trim());
  } catch {
    // Without storage the reader simply asks again next time.
  }
}

/**
 * What Google must have in the client's authorised JavaScript origins, and
 * whether Google will accept it at all.
 *
 * Google's rules: origins must be https, hosts cannot be raw IP addresses,
 * and localhost is the only exemption from both. A LAN address such as
 * http://10.0.0.5:5173 therefore cannot be registered, however convenient it
 * is for reaching a dev server from a phone.
 */
export function describeDriveOrigin() {
  const { protocol, hostname, port } = window.location;
  const loopback =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost');
  const rawAddress =
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[');

  return {
    origin: window.location.origin,
    accepted: loopback || (protocol === 'https:' && !rawAddress),
    // The same machine can always reach the reader this way instead.
    localhost: `http://localhost${port ? `:${port}` : ''}`,
    loopback,
  };
}

export function getDriveOrigin() {
  return window.location.origin;
}

export function isDriveConfigured() {
  return Boolean(getDriveClientId());
}

function readStoredToken(): StoredToken | null {
  try {
    const raw = window.localStorage.getItem(TOKEN_KEY);
    if (!raw) {
      return null;
    }
    const token = JSON.parse(raw) as StoredToken;
    return token.expiresAt - EXPIRY_MARGIN > Date.now() ? token : null;
  } catch {
    return null;
  }
}

function storeToken(value: string, lifetimeSeconds: number) {
  try {
    window.localStorage.setItem(
      TOKEN_KEY,
      JSON.stringify({
        value,
        expiresAt: Date.now() + lifetimeSeconds * 1000,
      } satisfies StoredToken),
    );
  } catch {
    // A token that cannot be cached only costs an extra click later.
  }
}

function clearStoredToken() {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** True when a sync can run without asking the user for anything. */
export function isDriveConnected() {
  return Boolean(readStoredToken());
}

/**
 * Whether this browser has been signed in before. Tokens last about an hour,
 * so this is what lets a later visit try to resume without a click.
 */
export function wasDriveConnected() {
  try {
    return window.localStorage.getItem(CONNECTED_KEY) === 'true';
  } catch {
    return false;
  }
}

function rememberConnection(connected: boolean) {
  try {
    if (connected) {
      window.localStorage.setItem(CONNECTED_KEY, 'true');
    } else {
      window.localStorage.removeItem(CONNECTED_KEY);
    }
  } catch {
    // The reader just asks again next time.
  }
}

function loadClient() {
  clientPromise ??= new Promise<GoogleOAuth>((resolve, reject) => {
    const ready = () => {
      const oauth2 = window.google?.accounts?.oauth2;
      if (oauth2) {
        resolve(oauth2);
      } else {
        reject(new Error('Google sign-in is unavailable.'));
      }
    };

    if (window.google?.accounts?.oauth2) {
      ready();
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${CLIENT_SRC}"]`,
    );
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', ready, { once: true });
    script.addEventListener(
      'error',
      () => reject(new Error('Google sign-in could not be reached.')),
      { once: true },
    );

    if (!existing) {
      script.src = CLIENT_SRC;
      script.async = true;
      script.defer = true;
      document.head.append(script);
    }
  }).catch(error => {
    clientPromise = null;
    throw error;
  });

  return clientPromise;
}

/**
 * Ask Google for an access token. Must be called from a user gesture: the
 * browser flow has no silent renewal.
 */
/**
 * `silent` asks Google for a token without showing anything. It only succeeds
 * when the account is still signed in and has granted access before, so the
 * caller must be ready for it to fail.
 */
export async function connectDrive({ silent = false } = {}) {
  const clientId = getDriveClientId();
  if (!clientId) {
    throw new Error('Google Drive has not been set up yet.');
  }

  // Google rejects the sign-in inside its own window, which reaches us only as
  // "the window closed". Refuse here instead, where the reason is knowable.
  const { accepted, origin, localhost } = describeDriveOrigin();
  if (!accepted) {
    throw new Error(
      `Google will not sign in from ${origin}. Open the reader at ${localhost} instead.`,
    );
  }

  const oauth2 = await loadClient();
  return new Promise<void>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      // Consent is asked for once; later sign-ins reuse the existing grant.
      prompt: silent ? 'none' : '',
      callback: response => {
        if (!response.access_token) {
          reject(
            new Error(
              explainSignIn(
                response.error,
                response.error_description ?? 'Google sign-in was refused.',
              ),
            ),
          );
          return;
        }
        storeToken(response.access_token, Number(response.expires_in) || 3600);
        rememberConnection(true);
        resolve();
      },
      error_callback: error => {
        reject(
          new Error(
            explainSignIn(
              error?.type,
              error?.message ?? 'Google sign-in was cancelled.',
            ),
          ),
        );
      },
    });
    client.requestAccessToken();
  });
}

export async function disconnectDrive() {
  const token = readStoredToken();
  clearStoredToken();
  rememberConnection(false);
  fileIds.clear();
  if (!token) {
    return;
  }
  try {
    const oauth2 = await loadClient();
    await new Promise<void>(resolve => oauth2.revoke(token.value, resolve));
  } catch {
    // The local token is already gone, which is what disconnect means here.
  }
}

function requireToken() {
  const token = readStoredToken();
  if (!token) {
    throw new DriveAuthError();
  }
  return token.value;
}

async function driveFetch(url: string, init?: RequestInit) {
  const token = requireToken();
  const response = await fetch(url, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${token}` },
  });

  if (response.status === 401 || response.status === 403) {
    clearStoredToken();
    fileIds.clear();
    throw new DriveAuthError();
  }
  if (!response.ok) {
    throw new Error(`Google Drive replied ${response.status}.`);
  }
  return response;
}

// One lookup per file per session: a sync reads and writes the same document.
const fileIds = new Map<string, string>();

async function findFileId(name: string) {
  const cached = fileIds.get(name);
  if (cached) {
    return cached;
  }

  const query = new URLSearchParams({
    spaces: 'appDataFolder',
    q: `name = '${name}' and trashed = false`,
    fields: 'files(id)',
    pageSize: '1',
  });
  const response = await driveFetch(`${DRIVE_API}?${query}`);
  const body = (await response.json()) as { files?: Array<{ id: string }> };
  const id = body.files?.[0]?.id ?? null;
  if (id) {
    fileIds.set(name, id);
  }
  return id;
}

/** Read a JSON document from the app folder, or null when it does not exist. */
export async function readDriveJson<T>(name: string): Promise<T | null> {
  const id = await findFileId(name);
  if (!id) {
    return null;
  }
  const response = await driveFetch(
    `${DRIVE_API}/${id}?alt=media&spaces=appDataFolder`,
  );
  return (await response.json()) as T;
}

/**
 * Books are stored in slices.
 *
 * Drive's simple upload is documented for files of about 5 MB or less, and the
 * resumable endpoint it points at for anything larger is unreliable from a
 * browser. Slicing every book keeps one upload path that is known to work, at
 * the cost of a request per slice.
 */
const SLICE_SIZE = 4 * 1024 * 1024;

async function createFile(name: string) {
  const created = await driveFetch(`${DRIVE_API}?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: ['appDataFolder'] }),
  });
  return ((await created.json()) as { id: string }).id;
}

async function uploadContent(id: string, body: BodyInit, type: string) {
  await driveFetch(`${DRIVE_UPLOAD}/${id}?uploadType=media`, {
    method: 'PATCH',
    headers: { 'Content-Type': type },
    body,
  });
}

/** Upload a blob and return the ids of its slices, in order. */
export async function writeDriveBlob(name: string, blob: Blob) {
  const ids: string[] = [];
  try {
    for (let start = 0; start < blob.size; start += SLICE_SIZE) {
      const slice = blob.slice(start, start + SLICE_SIZE);
      const id = await createFile(`${name}.${ids.length}`);
      ids.push(id);
      await uploadContent(id, slice, 'application/octet-stream');
    }
    return ids;
  } catch (error) {
    // A half-uploaded book is worse than none: take the slices back out.
    await deleteDriveFiles(ids).catch(() => undefined);
    throw error;
  }
}

/** Reassemble a blob from the slice ids recorded for it. */
export async function readDriveBlob(ids: string[], type: string) {
  const slices: Blob[] = [];
  for (const id of ids) {
    const response = await driveFetch(`${DRIVE_API}/${id}?alt=media`);
    slices.push(await response.blob());
  }
  return new Blob(slices, { type });
}

export async function deleteDriveFiles(ids: string[]) {
  for (const id of ids) {
    try {
      await driveFetch(`${DRIVE_API}/${id}`, { method: 'DELETE' });
    } catch {
      // A slice that is already gone needs no deleting.
    }
  }
}

/** Create or replace a JSON document in the app folder. */
export async function writeDriveJson(name: string, data: unknown) {
  let id = await findFileId(name);

  if (!id) {
    // Metadata first, then content: two small requests instead of a
    // hand-rolled multipart body.
    id = await createFile(name);
    fileIds.set(name, id);
  }

  await uploadContent(id, JSON.stringify(data), 'application/json');
}
