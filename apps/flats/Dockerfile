FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000

# Perceptual duplicate detection uses a tiny Pillow dHash helper. Keeping Pillow
# in the backend image avoids native Node image dependencies and still catches
# the same photo after resize/JPEG recompression across OLX/BirBir/Domza/etc.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pil \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY migrations ./migrations
COPY src ./src

EXPOSE 4000
CMD ["node", "src/server.js"]
