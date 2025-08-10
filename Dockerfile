FROM mcr.microsoft.com/playwright:latest

WORKDIR /usr/src/app

# 依存関係のみ先にコピーしインストール（キャッシュ用）
COPY package.json package-lock.json ./
RUN npm ci --only=production

# アプリ本体をコピー
COPY . .

# 環境変数をPlaywrightのブラウザが利用するパスに設定
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 3000

CMD ["node", "index.js"]
