import { describe, it, expect } from 'vitest';
import { maskPhone } from '@/lib/account/mask.ts';

describe('maskPhone', () => {
  it('打码 11 位手机号中间 4 位', () => {
    expect(maskPhone('15009760064')).toBe('150****0064');
  });
  it('过短的号码原样返回', () => {
    expect(maskPhone('123')).toBe('123');
  });
  it('空值返回空串', () => {
    expect(maskPhone('')).toBe('');
  });
});
