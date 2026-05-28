import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import chat from '@/api/controllers/chat.ts';
import accountPool from '@/lib/account/account-pool.ts';
import { runNonStream, classifyRelease, PreStreamError } from '@/api/controllers/account-runner.ts';
import { assertAuth } from '@/lib/auth.ts';
import config from '@/lib/config.ts';

export default {

    prefix: '/v1/chat',

    post: {

        '/completions': async (request: Request) => {
            request
                .validate('body.conversation_id', v => _.isUndefined(v) || _.isString(v))
                .validate('body.messages', _.isArray)
                .validate('headers.authorization', _.isString);
            // Authorization 作接入鉴权
            assertAuth(request.headers.authorization);

            const { model, conversation_id: convId, messages, stream, deep_think, auto_cot, platform } = request.body;
            const assistantId = /^[a-z0-9]{24,}$/.test(model) ? model : undefined;
            const useDeepThink = !!deep_think;
            const useAutoCot = !!auto_cot;
            // 端标识:仅 "mobile" 命中手机 UA,其余(含未传)均按网页版处理
            const platformSel = platform === "mobile" ? "mobile" : "web";

            if (stream) {
                // 流式:仅推流前可换号
                const maxAttempts = Math.min(config.account.pool.maxFailover, Math.max(1, accountPool.size()));
                let lastErr: any;
                for (let i = 0; i < maxAttempts; i++) {
                    const acc = await accountPool.acquire();
                    try {
                        const s = await chat.createCompletionStream(
                            messages, acc, assistantId, convId, 0, useDeepThink, useAutoCot,
                            (code: number) => accountPool.release(acc, classifyRelease(code)),
                            platformSel
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
            }

            return await runNonStream(
                accountPool,
                (acc) => chat.createCompletion(messages, acc, assistantId, convId, 0, useDeepThink, useAutoCot, platformSel),
                config.account.pool.maxFailover
            );
        }

    }

}
