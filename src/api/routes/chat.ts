import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import chat from '@/api/controllers/chat.ts';
import logger from '@/lib/logger.ts';

export default {

    prefix: '/v1/chat',

    post: {

        '/completions': async (request: Request) => {
            request
                .validate('body.conversation_id', v => _.isUndefined(v) || _.isString(v))
                .validate('body.messages', _.isArray)
                .validate('headers.authorization', _.isString)
            // refresh_token切分
            const tokens = chat.tokenSplit(request.headers.authorization);
            // 随机挑选一个refresh_token
            const token = _.sample(tokens);
            const {model, conversation_id: convId, messages, stream, deep_think, auto_cot} = request.body;
            const assistantId = /^[a-z0-9]{24,}$/.test(model) ? model : undefined
            const useDeepThink = !!deep_think;
            const useAutoCot = !!auto_cot;
            if (stream) {
                const s = await chat.createCompletionStream(messages, token, assistantId, convId, 0, useDeepThink, useAutoCot);
                return new Response(s, {
                    type: "text/event-stream",
                    headers: {
                        "Cache-Control": "no-cache, no-transform",
                        "Connection": "keep-alive",
                        "X-Accel-Buffering": "no"
                    }
                });
            } else
                return await chat.createCompletion(messages, token, assistantId, convId, 0, useDeepThink, useAutoCot);
        }

    }

}