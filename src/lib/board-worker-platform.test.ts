import { afterEach, describe, expect, it, vi } from 'vitest';
import { CANONICAL, tgzOf, writeJob } from './formats/odbpp-fixture';
import type { SourcePlatform } from './formats/source-name';

// MAC-TEST-20261011-07. The platform the renderer sends reaches the ODB++ archive name through the board worker, so an archive named
// dir\job.tgz keeps its backslash on Mac and Linux and loses its folders on win32. The board worker answers through `self`; this stands
// in for that scope and returns the board it reports.
async function boardNameOf(name: string, platform?: SourcePlatform): Promise<string> {
  const posted: Array<Record<string, unknown>> = [];
  const scope: { postMessage(message: unknown): void; onmessage: ((event: { data: unknown }) => void) | null } = {
    postMessage: message => { posted.push(message as Record<string, unknown>); },
    onmessage: null,
  };
  vi.stubGlobal('self', scope);
  await import('./board-worker');
  scope.onmessage!({ data: { name, data: tgzOf(writeJob(CANONICAL)), ...(platform ? { platform } : {}) } });
  const reply = posted.find(message => 'board' in message);
  if (!reply) throw new Error(`the board worker did not report a board: ${JSON.stringify(posted.at(-1) ?? null).slice(0, 200)}`);
  return (reply.board as { name: string }).name;
}

describe('the board worker names an ODB++ archive by the platform the renderer sent', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it('darwin keeps the backslash of the file name in the board name', async () => {
    expect(await boardNameOf('dir\\job.tgz', 'darwin')).toBe('dir\\job');
  });

  it('linux keeps the backslash of the file name in the board name', async () => {
    expect(await boardNameOf('dir\\job.tgz', 'linux')).toBe('dir\\job');
  });

  it('win32 takes the folders off the file name', async () => {
    expect(await boardNameOf('dir\\job.tgz', 'win32')).toBe('job');
  });
});
