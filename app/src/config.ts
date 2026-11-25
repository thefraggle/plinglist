export const DEFAULT_SERVER_URL = 'https://api.plinglist.app';
export const OFFICIAL_APP_ORIGIN = 'https://plinglist.app';
export const UMAMI_SCRIPT_URL = 'https://telemetry.goork.de/analytics.js';
export const UMAMI_APP_WEBSITE_ID = '6d1cc9ed-af01-4760-8f34-6e2c20a80f72';
export const APTABASE_HOST = 'https://telemetry-apps.goork.de';
export const APTABASE_APP_KEY = 'A-SH-5202606573';
export const APP_VERSION = '0.1.25';

/**
 * Diagnostic telemetry is strictly limited to the official hosted plinglist.app instance.
 * Self-hosted deployments and localhost always keep telemetry disabled.
 */
export function isOfficialCloudOrigin(locationOrigin?: string): boolean {
  const origin =
    locationOrigin ??
    (typeof globalThis.window !== 'undefined' ? globalThis.window.location?.origin : undefined);
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.hostname === 'plinglist.app' || parsed.hostname === 'www.plinglist.app';
  } catch {
    return false;
  }
}

/**
 * Detects native WebView wrapper origins (Capacitor iOS/macOS/Android, Tauri desktop).
 */
export function isNativeShellOrigin(locationOrigin?: string): boolean {
  const origin =
    locationOrigin ??
    (typeof globalThis.window !== 'undefined' ? globalThis.window.location?.origin : undefined);
  if (!origin || origin === 'null') return true;
  try {
    const parsed = new URL(origin);
    if (
      parsed.protocol === 'capacitor:' ||
      parsed.protocol === 'tauri:' ||
      parsed.protocol === 'file:'
    ) {
      return true;
    }
    if (parsed.hostname === 'tauri.localhost') {
      return true;
    }
    if (parsed.hostname === 'localhost' && parsed.port === '') {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Resolves the default sync server URL. In standard web/PWA contexts, defaults to
 * same-origin so both plinglist.app and self-hosted deployments sync out of the box.
 */
export function getDefaultServerUrl(locationOrigin?: string): string {
  const origin =
    locationOrigin ??
    (typeof globalThis.window !== 'undefined' ? globalThis.window.location?.origin : undefined);
  if (
    !isNativeShellOrigin(origin) &&
    origin &&
    (origin.startsWith('http://') || origin.startsWith('https://'))
  ) {
    return normalizeServerUrl(origin);
  }
  return DEFAULT_SERVER_URL;
}

/**
 * Resolves the public origin for outgoing share/pairing links so native iOS/macOS
 * shells produce https://plinglist.app/... (or custom self-hosted URLs) instead of capacitor://localhost.
 */
export function getShareBaseOrigin(locationOrigin?: string, fallbackServerUrl?: string): string {
  const origin =
    locationOrigin ??
    (typeof globalThis.window !== 'undefined' ? globalThis.window.location?.origin : undefined);
  if (
    !isNativeShellOrigin(origin) &&
    origin &&
    (origin.startsWith('http://') || origin.startsWith('https://'))
  ) {
    return normalizeServerUrl(origin);
  }
  const candidate = fallbackServerUrl ? normalizeServerUrl(fallbackServerUrl) : '';
  if (candidate && candidate !== DEFAULT_SERVER_URL && candidate !== OFFICIAL_APP_ORIGIN) {
    return candidate;
  }
  return OFFICIAL_APP_ORIGIN;
}

export function extractSyncKeyFromInput(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (!trimmed) return '';
  try {
    if (trimmed.includes('://')) {
      const parsed = new URL(trimmed);
      const paramKey = parsed.searchParams.get('pair') ?? parsed.searchParams.get('key');
      if (paramKey?.trim()) {
        return paramKey.trim();
      }
    }
  } catch {
    // Fallback to raw trimmed string
  }
  return trimmed;
}

export function extractInviteTokenFromInput(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (!trimmed) return '';
  try {
    if (trimmed.includes('://')) {
      const parsed = new URL(trimmed);
      const paramToken = parsed.searchParams.get('join') ?? parsed.searchParams.get('token');
      if (paramToken?.trim()) {
        return paramToken.trim();
      }
      const joinPathMatch = parsed.pathname.match(/\/join\/([^/?#]+)/);
      if (joinPathMatch?.[1]) {
        return decodeURIComponent(joinPathMatch[1]).trim();
      }
    }
  } catch {
    // Fallback to raw trimmed string
  }
  return trimmed;
}

/**
 * Validates and normalizes the configurable Server URL so self-hosters can point
 * the client to their own instance while preventing malformed schemes.
 */
export function normalizeServerUrl(input?: string): string {
  const trimmed = input?.trim();
  if (!trimmed) {
    return DEFAULT_SERVER_URL;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid Server URL: ${trimmed}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Unsupported Server URL protocol: ${parsed.protocol}`);
  }

  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}
