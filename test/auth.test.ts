import { describe, it, expect } from 'vitest';
import { verifyKey } from '@/lib/auth.ts';

describe('verifyKey', () => {
  const keys = ['k1', 'k2'];
  it('命中放行', () => {
    expect(verifyKey('Bearer k1', keys)).toBe(true);
    expect(verifyKey('k2', keys)).toBe(true);
  });
  it('未命中拒绝', () => {
    expect(verifyKey('Bearer wrong', keys)).toBe(false);
    expect(verifyKey('', keys)).toBe(false);
    expect(verifyKey(undefined, keys)).toBe(false);
  });
  it('keys 为空时一律拒绝', () => {
    expect(verifyKey('Bearer k1', [])).toBe(false);
  });
});
