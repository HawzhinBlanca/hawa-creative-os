import { deskReviewUrl, type DeskReviewTarget } from '@hawa/contracts/desk-navigation';

/** Use explicit deployment configuration; neither provider callbacks nor Host headers choose it. */
export function officeReviewUrl(target: DeskReviewTarget, configuredBase?: string): string | undefined {
  return deskReviewUrl(configuredBase || process.env.PUBLIC_TUNNEL_URL || process.env.HAWA_PUBLIC_URL ||
    process.env.HAWA_DESK_BASE_URL, target);
}
