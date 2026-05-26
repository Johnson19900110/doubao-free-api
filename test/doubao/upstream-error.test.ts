import { describe, it, expect } from 'vitest';
import { parseUpstreamError, EMPTY_RESULT_CODE, EMPTY_RESULT_MESSAGE } from '@/lib/doubao/upstream-error.ts';
import { RATE_LIMIT_CODE } from '@/api/controllers/account-runner.ts';

describe('parseUpstreamError', () => {
  it('最外层非 0 code 命中', () => {
    expect(parseUpstreamError({ code: RATE_LIMIT_CODE, message: '限流' })).toEqual({
      code: RATE_LIMIT_CODE,
      message: '限流',
    });
  });

  it('code 为 0 或缺失返回 null', () => {
    expect(parseUpstreamError({ code: 0 })).toBeNull();
    expect(parseUpstreamError({})).toBeNull();
    expect(parseUpstreamError({ event_type: 2001 })).toBeNull();
  });

  it('event_type 2005 内层 code 透出(限流)', () => {
    const frame = {
      event_type: 2005,
      event_data: JSON.stringify({ code: RATE_LIMIT_CODE, error_detail: { message: '触发限流' } }),
    };
    expect(parseUpstreamError(frame)).toEqual({ code: RATE_LIMIT_CODE, message: '触发限流' });
  });

  it('event_type 2005 内层解析失败回退通用错误码', () => {
    const result = parseUpstreamError({ event_type: 2005, event_data: '不是JSON{' });
    expect(result).not.toBeNull();
    expect(result!.code).toBe(-2001); // API_REQUEST_FAILED
  });

  it('普通 2001 文本帧与 2074 图片帧不误判', () => {
    expect(parseUpstreamError({ event_type: 2001, event_data: '{"message":{"content_type":2074}}' })).toBeNull();
    expect(parseUpstreamError({ event_type: 2074 })).toBeNull();
  });

  it('空结果常量导出正确', () => {
    expect(EMPTY_RESULT_CODE).toBe(-2009);
    expect(typeof EMPTY_RESULT_MESSAGE).toBe('string');
  });
});
