import { describe, expect, it } from 'vitest';
import { componentFiles, countMarkers, findLiterals, scanComponents, scanMarkers } from '../../scripts/i18n-lint.mjs';

/**
 * The i18n lint gate. Interface text comes from the catalogs (electron/locales/<language>/<namespace>.json, docs/I18N.md):
 *  1. no user-visible English string literal in src/components/** (JSX text, text-bearing props such as `aria-label`, `title`,
 *     `placeholder`, and any string that reads like interface text) except the legacy ones allow-listed below;
 *  2. no new `// i18n: pending` marker: the markers exist only in the allow-listed files and never beyond the listed count.
 * Both lists are exact, in both directions. Adding a literal or a marker fails; translating one fails until its number is
 * lowered here, so the numbers only ever go down and reach zero when the English-only workspace has been translated.
 * The scanner is scripts/i18n-lint.mjs (`node scripts/i18n-lint.mjs --verbose` prints every finding).
 */

/**
 * Legacy English literals per component file. Each of these files keeps local English tables (`const T = {...}`) or inline
 * texts, marked `// i18n: pending`, from before the catalogs covered the workspace; the backlog translates them.
 * Do not add to this list. `schematic-render.ts` has no marker: its title-block labels are drawn on the schematic canvas in English.
 */
const LEGACY_LITERALS: Readonly<Record<string, number>> = {
  'src/components/schematic-render.ts': 10,
  'src/components/workspace/Shell.tsx': 1,
};

/**
 * `i18n: pending` markers per source file: English texts of the main process (native dialogs and errors), of the controller
 * and of the format readers, and the component tables above. A comment that merely mentions the marker counts, too.
 */
const PENDING_MARKERS: Readonly<Record<string, number>> = {
  'electron/documents.cjs': 12,
  'electron/identity.cjs': 5,
  'electron/store.cjs': 14,
  'electron/workspace.cjs': 1,
  'src/app/api.ts': 1,
  'src/app/controller.ts': 1,
  'src/components/viewer-contracts.ts': 1,
  'src/lib/formats/bdv.ts': 1,
  'src/lib/formats/brd.ts': 1,
  'src/lib/formats/bvr.ts': 1,
  'src/lib/formats/fz.ts': 1,
  'src/lib/formats/recognizers.ts': 1,
  'src/lib/formats/samsung-cad.ts': 1,
  'src/lib/formats/xzz.ts': 2,
  'src/lib/workspace.ts': 1,
};

const sum = (record: Readonly<Record<string, number>>): number => Object.values(record).reduce((total, count) => total + count, 0);

/** Compares observed counts per file with an allow-list in both directions; returns one line per difference. */
function differences(what: string, observed: Readonly<Record<string, number>>, allowed: Readonly<Record<string, number>>): string[] {
  const problems: string[] = [];
  for (const file of [...new Set([...Object.keys(observed), ...Object.keys(allowed)])].sort()) {
    const have = observed[file] ?? 0;
    const may = allowed[file] ?? 0;
    if (have > may) problems.push(`${file}: ${have} ${what}, ${may ? `${may} allowed` : 'none allowed'} (new text belongs in the catalogs: docs/I18N.md)`);
    else if (have < may) problems.push(`${file}: ${have} ${what}, ${may} listed: lower its entry to ${have}${have ? '' : ' (remove it)'}`);
  }
  return problems;
}
function expectNoProblems(problems: readonly string[], title: string): void {
  expect(problems.length, `${title} (${problems.length}):\n${problems.map(problem => `  - ${problem}`).join('\n')}`).toBe(0);
}

describe(`i18n lint gate: ${sum(PENDING_MARKERS)} pending markers in ${Object.keys(PENDING_MARKERS).length} files, ${sum(LEGACY_LITERALS)} legacy literals in ${Object.keys(LEGACY_LITERALS).length} component files`, () => {
  it('src/components has no user-visible English literal outside the allow-list', () => {
    const scan = scanComponents() as Record<string, Array<{ line: number; kind: string; text: string }>>;
    const observed = Object.fromEntries(Object.entries(scan).map(([file, findings]) => [file, findings.length]));
    const problems = differences('English literals', observed, LEGACY_LITERALS);
    // Name the first findings of a file that grew, to find the new text quickly.
    for (const file of Object.keys(observed)) {
      if ((observed[file] ?? 0) > (LEGACY_LITERALS[file] ?? 0)) {
        const lines = scan[file].slice(0, 8).map(finding => `      ${file}:${finding.line} ${finding.kind} ${JSON.stringify(finding.text).slice(0, 80)}`);
        problems.push(`first findings of ${file}:\n${lines.join('\n')}`);
      }
    }
    expectNoProblems(problems, 'English literals in src/components differ from the allow-list');
  });

  it('`i18n: pending` markers appear only in the allow-listed files and never beyond the listed counts', () => {
    expectNoProblems(differences('markers', scanMarkers() as Record<string, number>, PENDING_MARKERS), '`i18n: pending` markers differ from the allow-list');
  });

  it('every allow-listed file exists', () => {
    const components = new Set(componentFiles() as string[]);
    expectNoProblems(Object.keys(LEGACY_LITERALS).filter(file => !components.has(file)).map(file => `${file} is not a component source`), 'stale literal allow-list entries');
  });
});

describe('the scanner', () => {
  const scan = (source: string, file = 'Sample.tsx'): string[] => (findLiterals(source, file) as Array<{ text: string }>).map(finding => finding.text);

  it('finds JSX text, text-bearing props, English tables, template and conditional values, and strings handed to calls', () => {
    expect(scan('export const A = () => <p>Open the file</p>;')).toEqual(['Open the file']);
    expect(scan('export const A = () => <button title="Close">x</button>;')).toEqual(['Close']);
    expect(scan('export const A = () => <input aria-label={on ? \'Sound on\' : \'Sound off\'} placeholder={`Search ${n}`} />;')).toEqual(['Sound on', 'Sound off', 'Search ']);
    expect(scan('export const T = { title: "Workspace tabs", save: \'Save changes\' };')).toEqual(['Workspace tabs', 'Save changes']);
    expect(scan('export function f(notify) { notify("Copied to the clipboard"); }', 'f.ts')).toEqual(['Copied to the clipboard']);
    expect(scan('export const A = () => <button onClick={() => toast(\'Saved\')}>{t(\'common.save\')}</button>;')).toEqual(['Saved']);
    expect(scan('export const A = () => <label label="Zoom"><span>{cond ? \'Fit page\' : null}</span></label>;')).toEqual(['Zoom', 'Fit page']);
  });

  it('leaves catalog keys, identifiers, class names, key names, comparisons, brand names, units and developer errors alone', () => {
    expect(scan('export const A = () => <p title={t(\'inspector.title\')} className="imgv-row__main mono" data-testid="open-board">{t(\'common.close\')}</p>;')).toEqual([]);
    expect(scan('export const A = () => <b>TRACE</b>;')).toEqual([]);
    expect(scan('export const A = () => <small>BOARDVIEWER</small>;')).toEqual([]);
    expect(scan('export const A = () => <span>{n} mm</span>;')).toEqual([]);
    expect(scan('export const A = () => <input onKeyDown={e => { if (e.key === \'Escape\' || [\'ArrowLeft\', \'ArrowRight\'].includes(e.key)) go(); }} />;')).toEqual([]);
    expect(scan('export function f(side: string) { return side === \'top\' ? 1 : 2; }', 'f.ts')).toEqual([]);
    expect(scan('import x from "./Some Component";\nexport { y } from "./Another Module";', 'f.ts')).toEqual([]);
    expect(scan('export function f() { throw new Error("UiContext is missing"); }', 'f.ts')).toEqual([]);
    expect(scan('export function f() { console.warn("Something went wrong here"); }', 'f.ts')).toEqual([]);
    expect(scan('export const FONT = `500 12px \'IBM Plex Mono\', Consolas, monospace`;', 'f.ts')).toEqual([]);
    expect(scan('export type Mode = \'Workspace mode\' | \'Focus mode\'; export interface P { kind: \'Some text here\' }', 'f.ts')).toEqual([]);
    expect(scan('export const A = () => <div className="quick-part mono" role="tablist" aria-orientation="vertical" data-state={on ? \'on\' : \'off\'} />;')).toEqual([]);
    expect(scan('export const KEYS = { \'Shift Left\': 1 };', 'f.ts')).toEqual([]);
  });

  it('counts `i18n: pending` markers, comments that mention one included', () => {
    expect(countMarkers('// i18n: pending\nconst T = {};\n/* see `// i18n: pending` */')).toBe(2);
    expect(countMarkers('const T = { a: \'b\' };')).toBe(0);
  });

  it('exempts a file-format name and a CSS selector, and nothing more of their shape', () => {
    expect(scan('export const KIND = { png: \'PNG\', webp: \'WebP\', gcd: \'GCD\', pcbdoc: \'PcbDoc\' };', 'f.ts')).toEqual([]);
    expect(scan('export const A = () => <span>PDF</span>;')).toEqual([]);
    expect(scan('export const A = () => <img alt=\'WebP\' />;')).toEqual([]);
    expect(scan('export function f(root: Element) { return root.querySelectorAll(\'.pdfv-page canvas\'); }', 'f.ts')).toEqual([]);
    expect(scan('export function f() { return document.querySelector(\'#pdfv-root > .pdfv-page canvas\'); }', 'f.ts')).toEqual([]);
  });

  it('keeps a sentence, a bare English word and a selector followed by an English word as findings', () => {
    expect(scan('export const L = { empty: \'No files yet\' };', 'f.ts')).toEqual(['No files yet']);
    expect(scan('export const L = { retry: \'Retry\', near: \'WebPage\' };', 'f.ts')).toEqual(['Retry', 'WebPage']);
    expect(scan('export const A = () => <span>PDF file</span>;')).toEqual(['PDF file']);
    expect(scan('export function f(root: Element) { return root.querySelector(\'.pdfv-page close\'); }', 'f.ts')).toEqual(['.pdfv-page close']);
  });
});
