export interface ServerConfig {
  port: number;
  sqlitePath: string;
  cloudExtensionEnabled: boolean;
  cloudEnforceEntitlements: boolean;
  cloudWebhookSecret: string;
  publicBaseUrl: string;
  appleTeamId: string;
  appBundleId: string;
  androidCertSha256Fingerprints: string[];
}

export function loadServerConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const parsedPort = Number(env.PORT ?? 3001);
  const fingerprints = (env.ANDROID_CERT_SHA256_FINGERPRINTS?.trim() || '')
    .split(',')
    .map((v) => v.trim().toUpperCase())
    .filter(Boolean);
  return {
    port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3001,
    sqlitePath: env.SQLITE_PATH?.trim() || './data/plinglist.db',
    cloudExtensionEnabled: env.CLOUD_EXTENSION_ENABLED === 'true',
    cloudEnforceEntitlements: env.CLOUD_ENFORCE_ENTITLEMENTS === 'true',
    cloudWebhookSecret: env.CLOUD_WEBHOOK_SECRET?.trim() || '',
    publicBaseUrl: (env.PUBLIC_BASE_URL?.trim() || 'http://localhost:8080').replace(/\/+$/, ''),
    appleTeamId: env.APPLE_TEAM_ID?.trim() || '296C735W8C',
    appBundleId: env.APP_BUNDLE_ID?.trim() || 'de.goork.plinglist',
    androidCertSha256Fingerprints: fingerprints,
  };
}
