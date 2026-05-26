import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import accountPool from '@/lib/account/account-pool.ts';
import { assertAuth } from '@/lib/auth.ts';

export default {

    prefix: '/accounts',

    get: {

        '/status': async (request: Request) => {
            request.validate('headers.authorization', _.isString);
            assertAuth(request.headers.authorization);
            return accountPool.status();
        }

    }

}
