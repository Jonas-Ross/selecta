import { createRequire } from 'node:module';

// Resolve relative to this module so source and dist use the same package metadata.
const packageInfo = createRequire(import.meta.url)('../package.json') as { version: string };

export const APP_VERSION = packageInfo.version;
