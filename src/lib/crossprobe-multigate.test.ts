import { describe, expect, it } from 'vitest';
import { buildBoardIndex, buildSchematicIndex, mapBoardSelectionToSchematic } from './crossprobe';
import { loadSchematicDesign } from './schematic';
import type { Board } from './types';

/*
 * O-42 placement reasons for a reference that the schematic files place. A part with several gates on several sheets of one
 * drawing is one component, so it is neither a repeat nor a placement in another attached drawing. Two attached drawings that both
 * carry the reference keep the cross-document reason. A real repeat inside one drawing is covered by crossprobe.test.ts (repeated).
 */

// One DUAL part, gate A on sheet 1 and gate B on sheet 2 of the same drawing.
const multiGateSheets = `<?xml version="1.0" encoding="utf-8"?><eagle version="9.6.2"><drawing><schematic><libraries><library name="tiny"><symbols><symbol name="POINT"><pin name="P" x="0" y="0" length="point" direction="pas"/></symbol></symbols><devicesets><deviceset name="DUAL"><gates><gate name="A" symbol="POINT" x="0" y="0"/><gate name="B" symbol="POINT" x="0" y="0"/></gates><devices><device name="" package="TWO"><connects><connect gate="A" pin="P" pad="1"/><connect gate="B" pin="P" pad="2"/></connects></device></devices></deviceset></devicesets></library></libraries><parts><part name="U1" library="tiny" deviceset="DUAL" device="" value="DUAL"/></parts><sheets><sheet><instances><instance part="U1" gate="A" x="10" y="20"/></instances><nets><net name="SIG" class="0"><segment><pinref part="U1" gate="A" pin="P"/><wire x1="10" y1="20" x2="15" y2="20" width="0.15" layer="91"/></segment></net></nets></sheet><sheet><instances><instance part="U1" gate="B" x="40" y="20"/></instances><nets><net name="SIG" class="0"><segment><pinref part="U1" gate="B" pin="P"/><wire x1="40" y1="20" x2="45" y2="20" width="0.15" layer="91"/></segment></net></nets></sheet></sheets></schematic></drawing></eagle>`;

function makeBoard(refs: string[]): Board {
  const components: Board['components'] = [], pins: Board['pins'] = [];
  refs.forEach((ref, i) => {
    const id = `c${i}`, pinId = `${id}.1.${i}`;
    pins.push({ id: pinId, componentId: id, number: '1', name: '', net: 'N', side: 'top', radius: 0.2, shape: 'round', x: i, y: 0 });
    components.push({ id, ref, value: '', package: '', side: 'top', bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, position: { x: i, y: 0 }, rotation: 0, pinIds: [pinId], outline: [] });
  });
  return { name: 'synthetic', format: 'test', units: 'mm', components, pins, nets: [{ id: 'n0', name: 'N', pinIds: pins.map(p => p.id) }], outline: [], bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, warnings: [] };
}

const eagle = (name: string) => loadSchematicDesign({ name, data: new TextEncoder().encode(multiGateSheets) });

describe('a multi-gate part across sheets of one drawing (O-42)', () => {
  it('is one component of that drawing: no repeat and no other-drawing reason', () => {
    const board = buildBoardIndex(makeBoard(['U1']));
    const index = buildSchematicIndex([{ documentId: 'one.sch', design: eagle('one.sch') }]);
    expect(mapBoardSelectionToSchematic(board, index, { componentId: 'c0' })).toMatchObject({ status: 'unique', reasons: [] });
  });

  it('keeps the other-drawing reason when a second attached drawing carries the same reference', () => {
    const board = buildBoardIndex(makeBoard(['U1']));
    const index = buildSchematicIndex([{ documentId: 'one.sch', design: eagle('one.sch') }, { documentId: 'two.sch', design: eagle('two.sch') }]);
    expect(mapBoardSelectionToSchematic(board, index, { componentId: 'c0' })).toMatchObject({ status: 'ambiguous', reasons: ['several-schematic-documents'] });
  });
});
