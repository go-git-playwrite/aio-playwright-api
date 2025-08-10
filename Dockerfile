# Dockerfile（ルート直下に保存）
FROM mcr.microsoft.com/playwright:latest

# 作業ディレクトリ
WORKDIR /usr/src/app

# 依存関係を先にコピーしてインストール（キャッシュ効率）
COPY package.json package-lock.json ./
RUN npm ci --only=production

# アプリ本体をコピー
COPY . .

# 環境変数（Render側でPORTが与えられるためデフォルトは不要）
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# コンテナが外に開くポート（Renderは内部的にPORTを渡す）
EXPOSE 3000

# 起動コマンド
CMD ["node", "index.js"]