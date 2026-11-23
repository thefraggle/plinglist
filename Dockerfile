FROM node:22-alpine

WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY scripts ./scripts
COPY packages/core ./packages/core
COPY app ./app
COPY server ./server

RUN node scripts/build-app.mjs && mkdir -p /app/data && chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV PORT=3001
ENV SQLITE_PATH=/app/data/plinglist.db

EXPOSE 3001

CMD ["node", "--experimental-strip-types", "server/src/index.ts"]
