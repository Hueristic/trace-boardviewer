import { describe, expect, it } from 'vitest';
import { noSandboxView } from './NoSandboxSettings';

describe('noSandboxView: the Linux "Do not ask again" section in Settings', () => {
  it('stays hidden until the answer is read, and wherever TRACE is never asked (Windows, macOS)', () => {
    expect(noSandboxView(null)).toEqual({ visible: false, saved: false, canRevoke: false });
    expect(noSandboxView({ applicable: false, saved: false })).toEqual({ visible: false, saved: false, canRevoke: false });
    expect(noSandboxView({ applicable: false, saved: true })).toEqual({ visible: false, saved: false, canRevoke: false });
  });

  it('on Linux shows the stored state, and takes back only a stored answer', () => {
    expect(noSandboxView({ applicable: true, saved: true })).toEqual({ visible: true, saved: true, canRevoke: true });
    expect(noSandboxView({ applicable: true, saved: false })).toEqual({ visible: true, saved: false, canRevoke: false });
  });
});
