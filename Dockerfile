FROM node:20-slim AS builder

WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --production
COPY server/src/ ./src/

FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    wget gnupg ca-certificates fonts-liberation \
    libasound2t64 libatk-bridge2.0-0 libatk1.0-0 libcups2 \
    libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 xdg-utils \
    dumb-init \
  && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY server/package.json ./

ENV NODE_ENV=production
EXPOSE 3000

USER node
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
