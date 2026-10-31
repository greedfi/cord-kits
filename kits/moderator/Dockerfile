FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY config.schema.json config.example.json ./

RUN mkdir -p /app/data && chown -R node:node /app
USER node

CMD ["node", "src/index.js"]
