import { describe, expect, it } from 'vitest';
import { noticeLifetimeMs } from './notice-lifetime';

describe('noticeLifetimeMs', () => {
  it('ordinary notices dismiss themselves: errors after 7.5 s, the others after 3 s', () => {
    expect(noticeLifetimeMs({ kind: 'error' })).toBe(7500);
    expect(noticeLifetimeMs({ kind: 'info' })).toBe(3000);
    expect(noticeLifetimeMs({ kind: 'success' })).toBe(3000);
  });

  it('a sticky notice never starts a timer, whatever its kind (a start-up or external-open failure, raised while the window is hidden or not yet shown included)', () => {
    expect(noticeLifetimeMs({ kind: 'error', sticky: true })).toBeNull();
    expect(noticeLifetimeMs({ kind: 'info', sticky: true })).toBeNull();
    expect(noticeLifetimeMs({ kind: 'error', sticky: false })).toBe(7500);
  });
});
