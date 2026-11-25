export const DEFAULT_ANDROID_CERT_SHA256_FINGERPRINTS = [
  '63:33:40:32:C1:57:A9:03:3D:B4:DD:E7:BF:75:67:DF:00:1A:A9:4D:A8:3F:B6:F8:CE:44:7F:CF:39:B3:8B:C3',
  'D7:55:DA:48:91:8C:3E:4A:49:A2:03:DA:2D:8E:90:AD:FB:59:E0:50:AD:74:D2:BB:DC:00:BE:76:11:7E:08:21',
  'D1:D2:5A:16:0A:87:D0:B3:A6:7C:53:0A:9B:09:17:38:43:55:2F:8E:67:7A:15:52:DC:FE:10:A9:F1:5B:CE:80',
];

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
    androidCertSha256Fingerprints:
      fingerprints.length > 0 ? fingerprints : DEFAULT_ANDROID_CERT_SHA256_FINGERPRINTS,
  };
}
