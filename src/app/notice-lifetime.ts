import type { Notice } from './api';

/**
 * How long a notice stays on screen before it dismisses itself; `null` keeps it until the user closes it. A sticky notice never
 * starts a timer, whether or not the window was visible when it was raised (a start-up failure can be raised while the window is
 * still hidden, and a timer that ran meanwhile would expire unseen).
 */
export function noticeLifetimeMs(notice: Pick<Notice, 'kind' | 'sticky'>): number | null {
  if (notice.sticky) return null;
  return notice.kind === 'error' ? 7500 : 3000;
}
