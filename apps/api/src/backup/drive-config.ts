import { driveEnabled, type Config } from '../config.ts';
import { GOOGLE_ENDPOINTS } from '../google/oauth.ts';
import { tokenKey } from '../google/tokens.ts';
import type { DriveConfig } from './backup.ts';

/**
 * Drive from the environment, shared by the API and the worker; null when not configured.
 * Google sends the browser back to the web app's callback page, which finishes through the API.
 */
export function driveConfig(config: Config): DriveConfig | null {
  if (!driveEnabled(config)) return null;
  return {
    client: {
      clientId: config.GOOGLE_CLIENT_ID!,
      clientSecret: config.GOOGLE_CLIENT_SECRET!,
      redirectUri: `${config.publicOrigin}/backup/google/callback`,
      endpoints: GOOGLE_ENDPOINTS,
    },
    tokenKey: tokenKey(config.GOOGLE_TOKEN_KEY!),
    testing: config.GOOGLE_DRIVE_TESTING === 'true',
  };
}
