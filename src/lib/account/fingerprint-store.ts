import path from 'path';
import fs from 'fs-extra';

import logger from '@/lib/logger.ts';
import { Fingerprint } from '@/lib/account/types.ts';
import { generateFingerprintId, isValidFingerprint } from '@/lib/account/fingerprint-id.ts';

/**
 * 指纹持久化存储。内存为唯一读源；新增指纹标脏，save() 落盘。
 * 文件只增不删：账号临时消失后回归可复用原指纹。
 */
export class FingerprintStore {
  private map: Record<string, Fingerprint> = {};
  private dirty = false;

  constructor(
    private readonly filePath: string,
    private readonly generateId: () => string = generateFingerprintId
  ) {}

  async load(): Promise<void> {
    try {
      if (!(await fs.pathExists(this.filePath))) return;
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        // 信任边界:逐条校验结构,丢弃残缺项(下次 getOrCreate 自动重建)
        for (const [phone, fp] of Object.entries(parsed)) {
          if (isValidFingerprint(fp)) this.map[phone] = fp;
          else logger.warn(`指纹文件存在残缺项已忽略: ${phone}`);
        }
      }
    } catch (err) {
      logger.warn('指纹文件读取失败，按空处理:', err);
      this.map = {};
    }
  }

  getOrCreate(phone: string): Fingerprint {
    if (!this.map[phone]) {
      this.map[phone] = { deviceId: this.generateId(), webId: this.generateId() };
      this.dirty = true;
    }
    return { ...this.map[phone] };
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    try {
      await fs.ensureDir(path.dirname(this.filePath));
      await fs.writeFile(this.filePath, JSON.stringify(this.map, null, 2));
      this.dirty = false;
    } catch (err) {
      logger.warn('指纹文件写入失败(内存指纹仍有效):', err);
    }
  }
}
