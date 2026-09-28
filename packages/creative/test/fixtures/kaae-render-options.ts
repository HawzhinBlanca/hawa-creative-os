import { getKaaeOfficialLogoDataUri } from '../../src/operations-to-svg.js';

/** Historical KAAE renderer tests supplied these exact bytes implicitly before client isolation. */
export const KAAE_TEST_LOGO = getKaaeOfficialLogoDataUri();

if (!KAAE_TEST_LOGO) throw new Error('Packaged KAAE test logo is unavailable');
