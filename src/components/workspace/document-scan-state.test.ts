import { describe, expect, it } from 'vitest';
import { documentScanState } from './document-scan-state';

describe('document card scan state', () => {
  it('a document with its own text layer is text, whatever the OCR state', () => {
    expect(documentScanState(true, 0)).toBe('text');
    expect(documentScanState(true, 214)).toBe('text');
    expect(documentScanState(null, 0)).toBe('text');
    expect(documentScanState(undefined, 0)).toBe('text');
  });

  it('a scan with no recognized words asks for recognition', () => {
    expect(documentScanState(false, 0)).toBe('scan-needs-recognition');
  });

  it('a scan with recognized words is indexed, not "no text": the card lists its candidates', () => {
    expect(documentScanState(false, 1)).toBe('scan-recognized');
    expect(documentScanState(false, 214)).toBe('scan-recognized');
  });
});
