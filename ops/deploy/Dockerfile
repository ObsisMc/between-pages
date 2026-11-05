# API, worker and migrations (production-deployment D6): one image, a different command each.
# Node runs the TypeScript directly, as in development.
FROM node:26.12.1-alpine3.24
# Here and not in an env file: nothing else sets it, and without it login rate limits stay off.
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/collab/package.json packages/collab/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci --omit=dev --ignore-scripts
COPY apps/api apps/api
COPY packages packages
USER node
CMD ["node", "apps/api/src/server.ts"]
