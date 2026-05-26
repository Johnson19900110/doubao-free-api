import _ from "lodash";

import EX from "@/api/consts/exceptions.ts";

/** 豆包未返回任何内容时透出的空结果码 */
export const EMPTY_RESULT_CODE = -2009;
export const EMPTY_RESULT_MESSAGE = "doubao未返回任何内容";

/**
 * 解析豆包上游错误帧
 *
 * 错误码可能位于最外层 rawResult.code，或 event_type 2005 错误帧的 event_data 内层
 * （如限流 710022002）。命中则返回 { code, message }，否则返回 null。
 *
 * @param rawResult 解析后的 SSE data 帧
 */
export function parseUpstreamError(rawResult: any): { code: number; message: string } | null {
    if (rawResult && _.isFinite(rawResult.code) && rawResult.code !== 0)
        return { code: rawResult.code, message: rawResult.message || "" };
    if (rawResult && rawResult.event_type === 2005) {
        const info = _.attempt(() =>
            typeof rawResult.event_data === "string" ? JSON.parse(rawResult.event_data) : rawResult.event_data
        );
        if (!_.isError(info) && info && _.isFinite(info.code))
            return { code: info.code, message: info?.error_detail?.message || info.message || "" };
        return { code: EX.API_REQUEST_FAILED[0] as number, message: "doubao返回未知错误" };
    }
    return null;
}
