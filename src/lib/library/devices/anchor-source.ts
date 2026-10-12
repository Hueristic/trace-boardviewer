/**
 * The source of board anchors for one scan: the port that matching reads its board records from.
 *
 * The default implementation (`fileNameAnchorSource`) derives one anchor per distinct (board code, revision) of the scanned boardview
 * files, so it needs no database and its ids are stable across scans. A richer implementation, for example one backed by the Library
 * database, implements the same two methods and is injected through `CatalogueInput.anchorSource` and the device bridge's `anchorSource`
 * option. The two methods are the whole contract:
 *   anchorsFor(scan)   the anchors matching uses for this scan. Input anchors are always kept; the source adds its own (an id that is
 *                      already present is not added twice).
 *   describe(anchorId) display metadata of one anchor (board code and revision), or undefined when the source does not know it.
 *
 * Presence (boardview and BIOS) is never a property of the source: it is computed from the scanned files that matching linked to the
 * board, so an anchor source cannot make a board look present.
 */
import type { IndexedFile } from './catalogue';
import type { BoardAnchor } from './match';

export interface AnchorScan {
  /** The indexed files of the scan (identity already read, collisions marked). */
  readonly files: readonly IndexedFile[];
  /** The anchors derived from the boardview files of this scan (the default source's output). */
  readonly derived: readonly BoardAnchor[];
}

export interface BoardMetadata {
  boardCode?: string;
  revision?: string;
}

export interface BoardAnchorSource {
  anchorsFor(scan: AnchorScan): Promise<readonly BoardAnchor[]>;
  describe(anchorId: string): Promise<BoardMetadata | undefined>;
}

/** One anchor per distinct (board code, revision) of the boardview files. The id is a pure function of those two values. */
export function deriveBoardAnchors(files: readonly IndexedFile[]): BoardAnchor[] {
  const byId = new Map<string, BoardAnchor>();
  for (const file of files) {
    const code = file.identity.boardCode;
    if (file.identity.role !== 'boardview' || file.collision === true || code === undefined) continue;
    const revision = file.identity.revision;
    const id = `board:${code.toUpperCase()}|${revision?.normalized ?? ''}`;
    if (!byId.has(id)) byId.set(id, { id, boardCode: code, revision, aliases: [] });
  }
  return [...byId.values()];
}

/**
 * The default source: file-name anchors. `describe` answers from the anchors of the most recent `anchorsFor` call, so a boardId
 * resolved by a scan keeps its code and revision until the next scan replaces them.
 */
export function createFileNameAnchorSource(): BoardAnchorSource {
  const known = new Map<string, BoardMetadata>();
  return {
    async anchorsFor(scan) {
      known.clear();
      for (const anchor of scan.derived) known.set(anchor.id, { boardCode: anchor.boardCode, revision: anchor.revision?.normalized });
      return scan.derived;
    },
    async describe(anchorId) {
      return known.get(anchorId);
    },
  };
}

export const fileNameAnchorSource: BoardAnchorSource = createFileNameAnchorSource();
