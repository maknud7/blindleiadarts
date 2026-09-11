FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json ./
RUN npm install --no-package-lock --ignore-scripts

COPY apps/backend-v2 ./apps/backend-v2
RUN npm run backend-v2:build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8082

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-package-lock --ignore-scripts \
    && npm cache clean --force

COPY --from=build /app/apps/backend-v2/dist ./apps/backend-v2/dist

USER node
EXPOSE 8082

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:" + (process.env.PORT || "8082") + "/health").then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))'

CMD ["node", "apps/backend-v2/dist/server.js"]
