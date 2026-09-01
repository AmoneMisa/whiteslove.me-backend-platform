FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY test ./test

ENV NODE_ENV=production

CMD ["node", "src/index.mjs"]
