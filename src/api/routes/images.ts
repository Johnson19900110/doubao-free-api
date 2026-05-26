import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import images from '@/api/controllers/images.ts';
import accountPool from '@/lib/account/account-pool.ts';
import { runNonStream, isRateLimitCode, PreStreamError } from '@/api/controllers/account-runner.ts';
import { assertAuth } from '@/lib/auth.ts';
import config from '@/lib/config.ts';

// 定义图片生成请求体的类型（可选，增强类型提示）
interface ImageCompletionRequestBody {
    model: string;
    prompt: string;
    ratio: string;
    style: string;
    stream: boolean;
}

export default {
    // 接口前缀
    prefix: '/v1/images',

    // POST请求路由
    post: {
        /**
         * 文生图生成接口
         * 路径：/v1/images/generations
         * 请求体：{model, prompt, ratio, style, stream}
         */
        '/generations': async (request: Request) => {
            // 1. 扩展参数校验：image为可选字符串（URL/Base64）
            request
                .validate('body.model', _.isString)
                .validate('body.prompt', _.isString)
                .validate('body.ratio', (v) => _.isUndefined(v) || _.isString(v))
                .validate('body.style', (v) => _.isUndefined(v) || _.isString(v))
                .validate('body.stream', _.isBoolean)
                .validate('headers.authorization', _.isString)
                .validate('body.image', (v) => _.isUndefined(v) || _.isString(v)); // 参考图为可选字符串

            // 2. Authorization 作接入鉴权
            assertAuth(request.headers.authorization);

            // 3. 解构参数：新增image字段
            const {
                model,
                prompt,
                ratio,
                style,
                stream,
                image: referenceImage
            } = request.body as ImageCompletionRequestBody & { image?: string };

            // 4. 处理智能体ID
            const assistantId = /^[a-z0-9]{24,}$/.test(model) ? model : undefined;

            // 5. 组装参数：传递参考图
            const imageParams = {
                model,
                prompt,
                ratio,
                style,
                referenceImage // 新增参考图字段
            };

            // 6. 调用生成方法（传递referenceImage）
            if (stream) {
                // 流式:仅推流前可换号
                const maxAttempts = Math.min(config.account.pool.maxFailover, Math.max(1, accountPool.size()));
                let lastErr: any;
                for (let i = 0; i < maxAttempts; i++) {
                    const acc = await accountPool.acquire();
                    try {
                        const s = await images.createImageCompletionStream(
                            imageParams, acc, assistantId, 0,
                            (code: number) => accountPool.release(acc, isRateLimitCode(code) ? 'rateLimited' : 'success')
                        );
                        return new Response(s, {
                            type: "text/event-stream",
                            headers: {
                                "Cache-Control": "no-cache, no-transform",
                                "Connection": "keep-alive",
                                "X-Accel-Buffering": "no"
                            }
                        });
                    } catch (err) {
                        accountPool.release(acc, 'error');
                        lastErr = err;
                        if (err instanceof PreStreamError) continue; // 推流前失败,换号
                        throw err;
                    }
                }
                throw lastErr;
            } else {
                const result = await runNonStream(
                    accountPool,
                    (acc) => images.createImageCompletion(imageParams, acc, assistantId),
                    config.account.pool.maxFailover
                );
                return new Response(result);
            }
        }
    }
};
