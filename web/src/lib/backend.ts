/**
 * Where the app talks to.
 *
 * Normally the answer is "same origin" — nginx serves the bundle and proxies
 * /api, so there is nothing to configure. But a static host (GitHub Pages,
 * S3, any CDN) has no /api to proxy, so the bundle needs to be told at runtime
 * which PBX it belongs to. One build, many deployments.
 *
 * Resolution order:
 *   1. ?api=https://pbx.example.com   — pinned into localStorage, so a link
 *                                       can hand someone a working app
 *   2. whatever was pinned previously
 *   3. VITE_API_BASE baked in at build time
 *   4. same origin
 *
 * ?demo=1 short-circuits all of it and runs against canned data.
 */

const API_BASE_KEY = 'softphone.apiBase';
const DEMO_KEY = 'softphone.demo';

function readQuery(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

/** Strip a trailing slash so callers can always append "/api/...". */
function normalise(base: string): string {
  return base.replace(/\/+$/, '');
}

let cachedBase: string | null = null;

export function apiBase(): string {
  if (cachedBase !== null) return cachedBase;

  const fromQuery = readQuery().get('api');
  if (fromQuery !== null) {
    const value = normalise(fromQuery.trim());
    if (value) {
      localStorage.setItem(API_BASE_KEY, value);
      cachedBase = value;
      return cachedBase;
    }
    // ?api= with an empty value means "forget the override".
    localStorage.removeItem(API_BASE_KEY);
  }

  const stored = localStorage.getItem(API_BASE_KEY);
  if (stored) {
    cachedBase = normalise(stored);
    return cachedBase;
  }

  const baked = import.meta.env.VITE_API_BASE as string | undefined;
  cachedBase = baked ? normalise(baked) : '';
  return cachedBase;
}

export function setApiBase(base: string): void {
  const value = normalise(base.trim());
  if (value) localStorage.setItem(API_BASE_KEY, value);
  else localStorage.removeItem(API_BASE_KEY);
  cachedBase = null;
}

/** True when the app is not being served by something that proxies /api. */
export function isCrossOrigin(): boolean {
  const base = apiBase();
  return base !== '' && !base.startsWith(window.location.origin);
}

export function isDemo(): boolean {
  const fromQuery = readQuery().get('demo');
  if (fromQuery !== null) {
    const on = fromQuery !== '0' && fromQuery !== 'false';
    // Persisted so a page reload inside the demo stays in the demo.
    if (on) sessionStorage.setItem(DEMO_KEY, '1');
    else sessionStorage.removeItem(DEMO_KEY);
    return on;
  }

  if (sessionStorage.getItem(DEMO_KEY) === '1') return true;

  // A build explicitly produced for a static host defaults to the demo,
  // because there is no backend for it to reach.
  return import.meta.env.VITE_DEMO === '1' && !localStorage.getItem(API_BASE_KEY);
}

export function exitDemo(): void {
  sessionStorage.removeItem(DEMO_KEY);
}
