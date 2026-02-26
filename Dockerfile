FROM node:20-slim

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src ./src

EXPOSE 3000

CMD ["npx", "tsx", "src/index.ts"]
