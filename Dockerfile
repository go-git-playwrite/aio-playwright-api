FROM mcr.microsoft.com/playwright:latest

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci --only=production

# ここでPlaywrightブラウザをインストール
RUN npx playwright install

COPY . .

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 3000

CMD ["node", "index.js"]
