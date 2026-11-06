FROM node:22-slim

RUN node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 12)) { console.error('Node >=22.12.0 is required, got ' + process.versions.node); process.exit(1) }"

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev

COPY src ./src
COPY config.schema.json config.example.json ./

RUN mkdir -p /data && chown -R node:node /app /data
ENV DATA_DIR=/data
ENV CONFIG_PATH=/data/config.json
USER node

CMD ["node", "src/index.js"]
