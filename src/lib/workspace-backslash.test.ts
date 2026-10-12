import { describe, expect, it } from 'vitest';
import { relativeToBoard, resolveRelative } from './workspace';

// MAC-TEST-20261011-03. A backslash is a separator on win32 only. On darwin and linux it is a character of the file name, so a document
// named a\b.pdf is stored with its relative path and resolves beside the board after the board moved. On win32 the same name is not
// portable, and the Windows results stay as they were.
const POSIX = [
  { platform: 'darwin', board: '/Volumes/Work/Board.cad', moved: '/Volumes/Archive/2026/Board.cad', movedDirectory: '/Volumes/Archive/2026' },
  { platform: 'linux', board: '/home/tech/rev-b/Board.cad', moved: '/srv/boards/Board.cad', movedDirectory: '/srv/boards' },
];

describe.each(POSIX)('$platform: a document named a\\b.pdf keeps its relative path', ({ board, moved, movedDirectory }) => {
  const document = board.replace(/Board\.cad$/, 'a\\b.pdf');

  it('stores the relative path, with the backslash as part of the name', () => {
    expect(relativeToBoard(board, document)).toBe('a\\b.pdf');
  });

  it('resolves beside the board, and beside the board after the board moved', () => {
    expect(resolveRelative(board, 'a\\b.pdf')).toBe(document);
    expect(resolveRelative(moved, 'a\\b.pdf')).toBe(`${movedDirectory}/a\\b.pdf`);
  });

  it('still refuses a name with a control character and a parent folder', () => {
    expect(relativeToBoard(board, board.replace(/Board\.cad$/, 'a\u0001.pdf'))).toBeNull();
    expect(relativeToBoard(board, board.replace(/Board\.cad$/, '../b.pdf'))).toBeNull();
  });
});

describe('win32: a backslash separates the directories, and the Windows results do not change', () => {
  const board = 'C:\\Work\\Board.cad';

  it('a document in a subfolder keeps the slash-joined relative path', () => {
    expect(relativeToBoard(board, 'C:\\Work\\a\\b.pdf')).toBe('a/b.pdf');
  });

  it('a stored relative path with a backslash is not portable on Windows, and a slash path resolves as before', () => {
    expect(resolveRelative(board, 'a\\b.pdf')).toBeNull();
    expect(resolveRelative('D:\\Archive\\2026\\Board.cad', 'a/b.pdf')).toBe('D:\\Archive\\2026\\a\\b.pdf');
  });

  it('the Windows-only names are still refused', () => {
    expect(relativeToBoard(board, 'C:\\Work\\a:b.pdf')).toBeNull();
    expect(relativeToBoard(board, 'C:\\Work\\con.pdf')).toBeNull();
    expect(relativeToBoard(board, 'C:\\Work\\trailing.pdf ')).toBeNull();
  });
});
