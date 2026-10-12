import { describe, expect, it, vi } from 'vitest';
import { documentsOf, extensionClassOf, osFamilyOf, primaryOf, siblingsOf } from './controller';
import { createHarness, dividerBoard, enc } from './testing';

// The picked file names (the board identity key, the schematic requests, the primary, the sidecars and the companions of a pick) follow the separators of the OS family of the renderer (navigator.platform).
describe('osFamilyOf: the renderer platform as the OS family of the file names', () => {
  it('maps the navigator platform strings to the families the readers use', () => {
    expect(osFamilyOf('Win32')).toBe('win32');
    expect(osFamilyOf('MacIntel')).toBe('darwin');
    expect(osFamilyOf('Linux x86_64')).toBe('linux');
    expect(osFamilyOf('')).toBe('other');
  });
});

const eagle = (label: string) => `<eagle version="9.7.0"><drawing><schematic><libraries/><parts/><sheets><sheet><plain><text x="1" y="1" size="1">${label}</text></plain><instances/><nets/></sheet></sheets></schematic></drawing></eagle>`;
const file = (name: string) => new File([enc(name) as Uint8Array<ArrayBuffer>], name);

/** Opens a board, then picks two schematics whose names carry a backslash; returns what the renderer on this platform sends for them. */
async function requestsOn(platform: string) {
  const h = createHarness({ browser: true });
  h.boardWorkers.replies['tiny.cad'] = dividerBoard('tiny.cad');
  h.pickQueue.push([new File([enc('GENCAD tiny') as Uint8Array<ArrayBuffer>], 'tiny.cad')]);
  await h.controller.actions.openBoard();
  await h.controller.idle();
  vi.stubGlobal('navigator', { platform });
  try {
    await h.controller.actions.attachFiles([
      new File([enc(eagle('B')) as Uint8Array<ArrayBuffer>], 'a\\b.sch'),
      new File([enc(eagle('C')) as Uint8Array<ArrayBuffer>], 'a\\c.sch'),
    ]);
    await h.controller.idle();
    const posted = h.schematicWorkers.posted;
    return {
      platforms: posted.map(request => request.platform),
      names: posted.map(request => request.name),
      companions: posted.map(request => Object.keys(request.companions ?? {})),
    };
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('a schematic request names its file by the separators of the renderer that picked it', () => {
  it('a Mac renderer sends darwin, and a backslash is part of the POSIX name', async () => {
    expect(await requestsOn('MacIntel')).toEqual({ platforms: ['darwin', 'darwin'], names: ['a\\b.sch', 'a\\c.sch'], companions: [['a\\c.sch'], ['a\\b.sch']] });
  });

  it('a Linux renderer sends linux, and a backslash is part of the POSIX name', async () => {
    expect(await requestsOn('Linux x86_64')).toEqual({ platforms: ['linux', 'linux'], names: ['a\\b.sch', 'a\\c.sch'], companions: [['a\\c.sch'], ['a\\b.sch']] });
  });

  it('a Windows renderer sends win32, and both separators split: the directory is not part of the name', async () => {
    expect(await requestsOn('Win32')).toEqual({ platforms: ['win32', 'win32'], names: ['b.sch', 'c.sch'], companions: [['c.sch'], ['b.sch']] });
  });
});

describe('the extension class of a name follows the separators of the renderer', () => {
  it('a dot in a POSIX directory name is no extension: the class is other there, none on win32', () => {
    expect(extensionClassOf('d.v2\\board', 'linux')).toBe('other');
    expect(extensionClassOf('d.v2\\board', 'win32')).toBe('none');
  });
});

// MAC-TEST-20261011-07: a board import carries the platform of the renderer, so the board names its archive by the same separators.
describe('a board import carries the platform of the renderer and names its file by it', () => {
  it.each([
    ['Win32', 'dir\\job.tgz', 'win32'],
    ['MacIntel', 'dir\\job.tgz', 'darwin'],
    ['Linux x86_64', 'dir\\job.tgz', 'linux'],
  ])('%s posts %s with platform %s', async (platform, name, expected) => {
    const h = createHarness({ browser: true });
    vi.stubGlobal('navigator', { platform });
    try {
      h.boardWorkers.replies[name] = dividerBoard(name);
      h.pickQueue.push([new File([enc('x') as Uint8Array<ArrayBuffer>], 'dir\\job.tgz')]);
      await h.controller.actions.openBoard();
      await h.controller.idle();
      expect(h.boardWorkers.posted.map(message => [message.name, message.platform])).toEqual([[name, expected]]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the primary, the sidecars and the siblings of a pick follow the separators of the renderer', () => {
  const trio = () => [file('a\\format.asc'), file('pins.asc'), file('nails.asc')];

  it('win32: a\\format.asc is the format file, and pins.asc and nails.asc are its sidecars', () => {
    const list = trio();
    const primary = primaryOf(list, 'win32')!;
    expect(primary.name).toBe('a\\format.asc');
    expect(documentsOf(list, primary, 'win32')).toEqual([]);
    expect(siblingsOf(list, primary, 'win32').map(value => value.name)).toEqual(['pins.asc', 'nails.asc']);
  });

  it('POSIX: a backslash is part of the name, so a\\format.asc is no format file and stays a document', () => {
    const list = trio();
    const primary = primaryOf(list, 'linux')!;
    expect(primary.name).toBe('pins.asc');
    expect(documentsOf(list, primary, 'linux').map(value => value.name)).toEqual(['a\\format.asc']);
    expect(siblingsOf(list, primary, 'linux').map(value => value.name)).toEqual(['nails.asc']);
  });
});
