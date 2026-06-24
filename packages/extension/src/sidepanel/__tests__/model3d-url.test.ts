/**
 * Unit tests for extracting the EasyEDA uuid from the converter's model3dUrl.
 */
import { describe, it, expect } from 'vitest';
import { uuidFromModelUrl } from '../model3d-url.js';

describe('uuidFromModelUrl', () => {
  it('pulls the uuid from the canonical /components/{uuid}/3d url', () => {
    expect(
      uuidFromModelUrl('https://easyeda.com/api/v2/components/7de5db90ab974d88b4eb22e148e2ee81/3d'),
    ).toBe('7de5db90ab974d88b4eb22e148e2ee81');
  });

  it('accepts a bare uuid', () => {
    expect(uuidFromModelUrl('7de5db90ab974d88b4eb22e148e2ee81')).toBe(
      '7de5db90ab974d88b4eb22e148e2ee81',
    );
  });

  it('finds an embedded hex run as a fallback', () => {
    expect(uuidFromModelUrl('https://modules.easyeda.com/3dmodel/abcdef0123456789')).toBe(
      'abcdef0123456789',
    );
  });

  it('returns null for null / empty / non-hex input', () => {
    expect(uuidFromModelUrl(null)).toBeNull();
    expect(uuidFromModelUrl(undefined)).toBeNull();
    expect(uuidFromModelUrl('')).toBeNull();
    expect(uuidFromModelUrl('no-hex-here-xyz')).toBeNull();
  });
});
