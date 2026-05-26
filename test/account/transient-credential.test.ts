import { describe, it, expect } from 'vitest';
import { buildTransientCredential } from '@/lib/account/transient-credential.ts';

describe('buildTransientCredential', () => {
  it('携带原 token 并生成 19 位数字指纹(以 7 开头)', () => {
    const c = buildTransientCredential('sess-abc');
    expect(c.token).toBe('sess-abc');
    expect(c.deviceId).toMatch(/^7\d{18}$/);
    expect(c.webId).toMatch(/^7\d{18}$/);
  });

  it('每次生成的指纹相互独立', () => {
    const a = buildTransientCredential('t');
    const b = buildTransientCredential('t');
    expect(a.deviceId).not.toBe(b.deviceId);
    expect(a.webId).not.toBe(b.webId);
  });
});
