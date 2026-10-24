import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { routes } from '@between-pages/contracts';

export interface AppOptions {
  logger?: boolean;
}

// Builds the app without listening so tests and the OpenAPI generator use the exact
// route registration that production serves.
export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Between Pages API', version: '0.0.1' },
    },
    transform: jsonSchemaTransform,
    // Emits schemas that carry .meta({ id }) as components, so $refs resolve.
    transformObject: jsonSchemaTransformObject,
  });

  app.route({
    method: routes.health.method,
    url: routes.health.path,
    schema: { summary: routes.health.summary, response: { 200: routes.health.response } },
    handler: () => ({ status: 'ok' as const }),
  });

  await app.ready();
  return app;
}
