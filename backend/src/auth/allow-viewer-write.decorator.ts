import { SetMetadata } from '@nestjs/common';

export const ALLOW_VIEWER_WRITE_KEY = 'allowViewerWrite';

/**
 * Exempts a route from WriteGuard's viewer block — for self-service account
 * actions (own 2FA setup/disable) that legacy exempted by mounting
 * `/api/account` before the `requireWrite` middleware. Every role, including
 * viewer, may act on their OWN account; nothing behind this ever touches
 * another user's row.
 */
export const AllowViewerWrite = () => SetMetadata(ALLOW_VIEWER_WRITE_KEY, true);
