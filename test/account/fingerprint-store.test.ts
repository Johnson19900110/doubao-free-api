import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { FingerprintStore } from '@/lib/account/fingerprint-store.ts';

let dir: string;
let file: string;
let seq: number;
const fakeGen = () => `7${String(seq++).padStart(18, '0')}`;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fp-'));
  file = path.join(dir, 'fingerprints.json');
  seq = 1;
});
afterEach(async () => {
  await fs.remove(dir);
});

describe('FingerprintStore', () => {
  it('新 phone 生成一对指纹', async () => {
    const store = new FingerprintStore(file, fakeGen);
    await store.load();
    const fp = store.getOrCreate('111');
    expect(fp.deviceId).toBe('7000000000000000001');
    expect(fp.webId).toBe('7000000000000000002');
  });

  it('已存在 phone 复用同一指纹', async () => {
    const store = new FingerprintStore(file, fakeGen);
    await store.load();
    const a = store.getOrCreate('111');
    const b = store.getOrCreate('111');
    expect(b).toEqual(a);
  });

  it('save 后重新 load 指纹保持不变', async () => {
    const store = new FingerprintStore(file, fakeGen);
    await store.load();
    const fp = store.getOrCreate('111');
    await store.save();

    const store2 = new FingerprintStore(file, fakeGen);
    await store2.load();
    expect(store2.getOrCreate('111')).toEqual(fp);
  });

  it('load 不存在的文件按空处理', async () => {
    const store = new FingerprintStore(file, fakeGen);
    await expect(store.load()).resolves.toBeUndefined();
  });

  it('load 丢弃结构残缺项,残缺 phone 重新生成', async () => {
    // 手工写入:一条合法 + 两条残缺
    await fs.writeFile(
      file,
      JSON.stringify({
        good: { deviceId: '7111', webId: '7222' },
        missingWebId: { deviceId: '7333' },
        notObject: 'garbage',
      })
    );
    const store = new FingerprintStore(file, fakeGen);
    await store.load();

    // 合法项原样保留
    expect(store.getOrCreate('good')).toEqual({ deviceId: '7111', webId: '7222' });
    // 残缺项被丢弃 → getOrCreate 重新生成一对
    const rebuilt = store.getOrCreate('missingWebId');
    expect(rebuilt.deviceId).toBe('7000000000000000001');
    expect(rebuilt.webId).toBe('7000000000000000002');
  });
});
