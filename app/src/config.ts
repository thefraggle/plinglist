export const DEFAULT_SERVER_URL = 'https://api.plinglist.app';

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
