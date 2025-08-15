# Playwrightが必要とする全ての部品が最初から入っている公式イメージをベースにする
FROM mcr.microsoft.com/playwright:v1.54.2-jammy

# 作業ディレクトリを設定
WORKDIR /app

# まず依存パッケージだけをインストール（ビルドを高速化するため）
COPY package*.json ./

# ブラウザのダウンロードをスキップするよう環境変数を設定
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# 依存パッケージをインストール
RUN npm install

# アプリケーションのコードをコピー
COPY . .

# サーバーが使うポートを指定
EXPOSE 8080

# サーバーを起動する
CMD [ "npm", "start" ]
