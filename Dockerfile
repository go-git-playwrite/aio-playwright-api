# Playwright 公式イメージ（ブラウザ＆依存込み）
FROM mcr.microsoft.com/playwright:v1.54.2-jammy

# 環境
ENV NODE_ENV=production \
    TZ=Asia/Tokyo \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# 公式イメージは既定で pwuser ユーザーが用意されている
WORKDIR /app

# 依存だけ先に入れてキャッシュを効かせる
COPY --chown=pwuser:pwuser package*.json ./
RUN npm ci --omit=dev

# アプリ本体
COPY --chown=pwuser:pwuser . .

# ポート
EXPOSE 8080

# 起動（package.json の "start": "node index.js" を想定）
CMD ["npm", "start"]