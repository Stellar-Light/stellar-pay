# The hosted Stellar testnet sandbox seller — a single always-on process
# (the MPP challenge store is in-memory; serverless would lose challenges
# between instances).
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts && npm i --no-save tsx@4
COPY src ./src
COPY vendor ./vendor
COPY sandbox-server ./sandbox-server
COPY tsconfig.json ./
EXPOSE 8787
CMD ["npx", "tsx", "sandbox-server/server.ts"]
