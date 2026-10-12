import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '../src/styles.css';
import { createMockWorkspace, useMockWorkspace } from '../src/app/mock-api';
import type { MockWorkspace } from '../src/app/mock-api';
import Shell from '../src/components/workspace/Shell';
import { configurePdfResources } from '../src/lib/pdf/worker';
import { catalogs } from '../src/lib/i18n';

/**
 * Dev harness of the whole workspace shell on the synthetic mock core (src/app/mock-api.ts).
 * URL: ?persistence=session-only  &empty=1 (no board)  &docs=0 (no documents)  &notesBlocked=1  &slowNotes=<ms>  &strict=0  &persist=1 (cameras/aliases survive a reload)  &boardKey=<key>  &cameraDelay=<ms>
 * Test hooks: window.__mock (recorded action calls, state, patch helpers) and window.__wspRenders (commit counters per panel).
 */
const params = new URLSearchParams(location.search);
// Test-only, in this harness page alone: one translated key is removed from one language's catalog in memory, so the English fallback
// (src/lib/i18n.ts lookup chain) can be observed. Nothing is written, and the product catalogs on disk are untouched.
const dropLang = params.get('dropLang'), dropKey = params.get('dropKey');
if (dropLang && dropKey && dropLang in catalogs) delete (catalogs[dropLang as keyof typeof catalogs] as Record<string, unknown>)[dropKey];
const origin = location.origin;
configurePdfResources({ workerSrc: new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).href, cMapUrl: `${origin}/pdfjs/cmaps/`, standardFontDataUrl: `${origin}/pdfjs/standard_fonts/`, wasmUrl: `${origin}/pdfjs/wasm/`, iccUrl: `${origin}/pdfjs/iccs/` });

const mock: MockWorkspace = createMockWorkspace({
  persistence: params.get('persistence') === 'session-only' ? 'session-only' : 'native',
  empty: params.get('empty') === '1', documents: params.get('docs') !== '0', notesBlocked: params.get('notesBlocked') === '1', slowNotes: Number(params.get('slowNotes') ?? 0) || undefined,
  persistWorkspace: params.get('persist') === '1', boardKey: params.get('boardKey') ?? undefined, cameraDelay: Number(params.get('cameraDelay') ?? 0) || undefined,
});
declare global { interface Window { __mock?: { calls: MockWorkspace['calls']; hooks: MockWorkspace['hooks']; actions: MockWorkspace['actions']; state(): ReturnType<MockWorkspace['getSnapshot']>; statusStore: MockWorkspace['statusStore'] } } }
window.__mock = { calls: mock.calls, hooks: mock.hooks, actions: mock.actions, state: mock.getSnapshot, statusStore: mock.statusStore };
window.__wspRenders = {};

function Harness() {
  return <Shell api={useMockWorkspace(mock)} />;
}
const tree = <Harness />;
createRoot(document.getElementById('root')!).render(params.get('strict') === '0' ? tree : <StrictMode>{tree}</StrictMode>);
