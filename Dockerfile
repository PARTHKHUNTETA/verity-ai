# VerityAI backend: one image for the API, the worker and the database setup step.
# Pick the process with PROCESS=api|worker|all|setup|setup-and-all (see deploy/entrypoint.sh).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    STORAGE_DIR=/data/storage
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# db-setup applies the SQL migrations from here.
COPY src/infrastructure/database/migrations ./src/infrastructure/database/migrations
COPY deploy/entrypoint.sh ./deploy/entrypoint.sh
# Run as the unprivileged "node" user; uploads go to a volume mounted at /data.
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || exit 1
ENTRYPOINT ["./deploy/entrypoint.sh"]
