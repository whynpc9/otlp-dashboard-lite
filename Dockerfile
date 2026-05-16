FROM node:22-slim AS deps
WORKDIR /app
ENV CI=true
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/otel-proto/package.json packages/otel-proto/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV DEVDASH_HOST=0.0.0.0
ENV CI=true
COPY --from=build /app /app
EXPOSE 18888 4317 4318
CMD ["node", "/app/packages/cli/dist/index.js", "serve", "--web-dist", "/app/apps/web/dist"]
