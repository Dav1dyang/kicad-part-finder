/**
 * Tests for the pure, DOM-free seams of the Document Picture-in-Picture float
 * helper. These run in the Node test environment (no jsdom): `isPipSupported`
 * takes an injectable window-like object, and `copyStyles` takes injectable
 * document-like stubs, so neither needs a real browser DOM.
 */
import { describe, it, expect, vi } from 'vitest';
import { isPipSupported, copyStyles, PIP_WINDOW_SIZE } from '../float.js';

describe('isPipSupported', () => {
  it('is true when documentPictureInPicture.requestWindow is a function', () => {
    const win = { documentPictureInPicture: { requestWindow: () => {} } };
    expect(isPipSupported(win)).toBe(true);
  });

  it('is false when documentPictureInPicture is absent', () => {
    expect(isPipSupported({})).toBe(false);
  });

  it('is false when documentPictureInPicture exists but requestWindow is missing', () => {
    expect(isPipSupported({ documentPictureInPicture: {} })).toBe(false);
  });

  it('is false when documentPictureInPicture is null', () => {
    expect(isPipSupported({ documentPictureInPicture: null })).toBe(false);
  });

  it('does not throw on undefined / non-object inputs', () => {
    expect(isPipSupported(undefined)).toBe(false);
    expect(isPipSupported(null)).toBe(false);
    expect(isPipSupported(42)).toBe(false);
  });
});

describe('PIP_WINDOW_SIZE', () => {
  it('matches the spec (460×760)', () => {
    expect(PIP_WINDOW_SIZE).toEqual({ width: 460, height: 760 });
  });
});

describe('copyStyles', () => {
  /** Minimal stub of the source document: a head whose query returns N nodes. */
  function fakeSourceDoc(nodeCount: number, adopted?: unknown[]) {
    const nodes = Array.from({ length: nodeCount }, (_, i) => ({
      cloneNode: vi.fn(() => ({ cloned: i })),
    }));
    const doc: Record<string, unknown> = {
      querySelectorAll: vi.fn(() => nodes),
    };
    if (adopted) doc.adoptedStyleSheets = adopted;
    return { doc, nodes };
  }

  /** Minimal stub of the PiP document: a head that records appended nodes. */
  function fakePipDoc(supportsAdopted: boolean) {
    const appended: unknown[] = [];
    const doc: Record<string, unknown> = {
      head: { appendChild: (n: unknown) => appended.push(n) },
    };
    if (supportsAdopted) doc.adoptedStyleSheets = [];
    return { doc, appended };
  }

  it('clones every <style>/<link> node into the PiP head', () => {
    const { doc: src, nodes } = fakeSourceDoc(3);
    const { doc: pip, appended } = fakePipDoc(false);

    copyStyles(src as unknown as Document, pip as unknown as Document);

    expect((src.querySelectorAll as any)).toHaveBeenCalledWith('style, link[rel="stylesheet"]');
    for (const n of nodes) expect(n.cloneNode).toHaveBeenCalledWith(true);
    expect(appended).toHaveLength(3);
  });

  it('adopts constructed stylesheets when both documents support them', () => {
    const sheetA = { a: 1 };
    const sheetB = { b: 2 };
    const { doc: src } = fakeSourceDoc(0, [sheetA, sheetB]);
    const { doc: pip } = fakePipDoc(true);

    copyStyles(src as unknown as Document, pip as unknown as Document);

    expect((pip as { adoptedStyleSheets: unknown[] }).adoptedStyleSheets).toEqual([
      sheetA,
      sheetB,
    ]);
  });

  it('skips adopted sheets when the PiP document does not support them (no throw)', () => {
    const { doc: src } = fakeSourceDoc(1, [{ a: 1 }]);
    const { doc: pip, appended } = fakePipDoc(false);

    expect(() =>
      copyStyles(src as unknown as Document, pip as unknown as Document),
    ).not.toThrow();
    // The <style>/<link> clone path still ran.
    expect(appended).toHaveLength(1);
  });

  it('continues past a node that fails to clone', () => {
    const good = { cloneNode: vi.fn(() => ({ ok: true })) };
    const bad = {
      cloneNode: vi.fn(() => {
        throw new Error('uncloneable');
      }),
    };
    const src = { querySelectorAll: () => [bad, good] };
    const { doc: pip, appended } = fakePipDoc(false);

    expect(() =>
      copyStyles(src as unknown as Document, pip as unknown as Document),
    ).not.toThrow();
    // The good node still made it across despite the bad one throwing.
    expect(appended).toHaveLength(1);
  });
});
