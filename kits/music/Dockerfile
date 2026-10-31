FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY config.schema.json config.example.json ./

RUN mkdir -p /app/data && chown -R node:node /app
USER node

CMD ["node", "src/index.js"]
