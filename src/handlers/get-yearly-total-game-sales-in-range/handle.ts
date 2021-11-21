import type { ServiceError } from '@grpc/grpc-js';
import { Metadata } from '@grpc/grpc-js';
import { Status } from '@grpc/grpc-js/build/src/constants';
import type {
  FastifyLoggerInstance,
  FastifyRequest,
  FastifyReply,
  RouteHandlerMethod,
} from 'fastify';
import { StatusCodes } from 'http-status-codes';
import isNil from 'lodash.isnil';
import type { CoreServiceClient } from '../../../proto-gen/coresrv_grpc_pb';
import type { GetYearlyTotalGameSalesInRangeReply } from '../../../proto-gen/coresrv_pb';
import { GetYearlyTotalGameSalesInRangeRequest } from '../../../proto-gen/coresrv_pb';
import { extractAuthHeader } from '../../auth/authenticate';
import validate, { ValidationError } from '../../validator/validate';
import schema from './schema';


interface RequestQuery {
  readonly startYear: number;
  readonly endYear: number;
}

function parseRequestQuery(query: unknown): RequestQuery {
  const m = new Map(Object.entries(query as Record<string, unknown>));

  return {
    startYear: m.get('startYear') as number,
    endYear: m.get('endYear') as number,
  };
}

export interface CreateHandlerDeps {
  readonly coreService: CoreServiceClient;
  readonly logger: FastifyLoggerInstance;
}

function tryExtractAuthHeader(request: FastifyRequest): [boolean, string] {
  try {
    const authHeader = request.headers.authorization;
    return [true, extractAuthHeader(authHeader)];
  } catch {
    return [false, ''];
  }
}

export function createHandler(
  deps: CreateHandlerDeps,
): RouteHandlerMethod {
  async function handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const [extracted, authToken] = tryExtractAuthHeader(request);
    if (!extracted) {
      await reply.status(StatusCodes.UNAUTHORIZED).send('missing or invalid Authorization header');
    }

    try {
      if (isNil(request.query)) {
        throw new ValidationError([{
          code: 'E_QUERY_EMPTY',
          path: '.',
        }]);
      }

      await validate(schema, request.query as Record<string, unknown>);
    } catch (error: unknown) {
      if (error instanceof ValidationError) {
        await reply.status(StatusCodes.BAD_REQUEST).send({
          error: 'E_INVALID_QUERY',
          details: error.items,
        });
        return;
      }

      await reply.status(StatusCodes.INTERNAL_SERVER_ERROR).send({
        error: 'E_INTERNAL',
        details: 'internal error occurred. please try again later.',
      });
      return;
    }

    const query = parseRequestQuery(request.query);
    const grpcRequest = new GetYearlyTotalGameSalesInRangeRequest()
      .setEndYear(query.endYear)
      .setStartYear(query.startYear);

    await new Promise<[
      ServiceError | null,
      GetYearlyTotalGameSalesInRangeReply,
    ]>(
      resolve => {
        const meta = new Metadata({ idempotentRequest: true });
        meta.set('auth', authToken);
        deps.coreService.getYearlyTotalGameSalesInRange(
          grpcRequest,
          meta,
          (grpcError, grpcResponse) => {
            resolve([grpcError, grpcResponse]);
          },
        );
      },
    )
      .then(async ([error, response]) => {
        if (!isNil(error)) {
          switch (error.code) {
            case Status.UNAUTHENTICATED:
              return await reply
                .status(StatusCodes.UNAUTHORIZED)
                .send({ message: 'authentication failed.' });
            case Status.INTERNAL:
              return await reply
                .status(StatusCodes.INTERNAL_SERVER_ERROR)
                .send({ message: 'internal error occurred. please try again later.' });
            case Status.INVALID_ARGUMENT:
              return await reply
                .status(StatusCodes.BAD_REQUEST)
                .send(error.details);
            case Status.NOT_FOUND:
              return await reply
                .status(StatusCodes.NOT_FOUND)
                .send({ message: 'game genre does not exist' });
            default:
              return await reply
                .status(StatusCodes.INTERNAL_SERVER_ERROR)
                .send({ message: 'internal error occurred. please try again later.' });
          }
        }

        const responseObject = response.toObject(false);
        return await reply
          .status(StatusCodes.OK)
          .send({ sales: responseObject.itemsList });
      });
  }

  return handle;
}
