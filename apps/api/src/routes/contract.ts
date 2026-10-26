import type { FastifyRequest } from 'fastify';
import type { BodyOf, ParamsOf, QueryOf, RouteName } from '@between-pages/contracts';

/** A request whose params, query and body the route's contract schemas have already parsed. */
export type ContractRequest<Name extends RouteName> = FastifyRequest & {
  params: ParamsOf<Name>;
  query: QueryOf<Name>;
  body: BodyOf<Name>;
};
