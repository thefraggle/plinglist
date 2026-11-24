export interface ServerConfig {
  port: number;
  sqlitePath: string;
  cloudExtensionEnabled: boolean;
  cloudEnforceEntitlements: boolean;
  cloudWebhookSecret: string;
  publicBaseUrl: string;
}

export function loadServerConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const parsedPort = Number(env.PORT ?? 3001);
  return {
    port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3001,
    sqlitePath: env.SQLITE_PATH?.trim() || './data/plinglist.db',
    cloudExtensionEnabled: env.CLOUD_EXTENSION_ENABLED === 'true',
    cloudEnforceEntitlements: env.CLOUD_ENFORCE_ENTITLEMENTS === 'true',
    cloudWebhookSecret: env.CLOUD_WEBHOOK_SECRET?.trim() || '',
    publicBaseUrl: (env.PUBLIC_BASE_URL?.trim() || 'http://localhost:8080').replace(/\/+$/, ''),
  };
}
