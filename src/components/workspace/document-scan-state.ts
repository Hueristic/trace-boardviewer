/**
 * What a PDF's document card says about its text. `searchable` describes only the PDF's own text layer (session.ts), while
 * recognized words (OCR) are merged into the cross-reference index. So a scan whose words were recognized is NOT "no text":
 * its card lists the exact and case-only candidates instead (docs/SUPPORT.md: a letter-case difference is a candidate, never a link).
 */
export type DocumentScanState = 'text' | 'scan-needs-recognition' | 'scan-recognized';

export function documentScanState(searchable: boolean | null | undefined, ocrWords: number): DocumentScanState {
  if (searchable !== false) return 'text';
  return ocrWords > 0 ? 'scan-recognized' : 'scan-needs-recognition';
}
