FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV JOBS_RUNTIME_ROLE=worker

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

CMD ["node", "--experimental-transform-types", "--import", "./jobs-worker/alias-loader.mjs", "--import", "./jobs-worker/workerHealthBootstrap.ts", "./jobs-worker/worker.ts"]
