import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { officialLogoPath } from '../../src/services/design-studio/design-studio-service.js';

/** These older KAAE stage tests must supply their own client's logo explicitly. */
const bytes = readFileSync(officialLogoPath());
export const KAAE_TEST_CLIENT_LOGO = {
  bytes,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  mimeType: 'image/png' as const,
};
