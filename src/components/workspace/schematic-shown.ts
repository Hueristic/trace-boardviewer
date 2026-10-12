/**
 * Which schematic the Schematic tab shows. A pick (document list, schematic picker, search row) wins over the last cross-probe, which wins over
 * the selected document, which wins over the first schematic. A stale probe must never override a fresh pick: the probe is only the default.
 */
export function shownSchematicId(picked: string | null, probe: string | null, selected: string | null, schematicIds: ReadonlySet<string>, first: string | null): string | null {
  if (picked && schematicIds.has(picked)) return picked;
  if (probe && schematicIds.has(probe)) return probe;
  if (selected && schematicIds.has(selected)) return selected;
  return first;
}
