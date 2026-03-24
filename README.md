# RVC Sound Cutter

ブラウザ上で音声を読み込み、無音区間ベースで分割しながら確認、採用、不採用、カット、分割、書き出しができる React + Vite 製のツールです。

## 主な機能

- 音声ファイルのドラッグ&ドロップ読み込み
- 無音区間を元にしたセグメント分割
- セグメントごとの再生、採用、不採用
- 波形ドラッグによる範囲選択
- 選択範囲のカット、選択範囲のみ残す、カーソル位置分割
- 採用セグメントの結合ダウンロード、個別ダウンロード

## 技術スタック

- React 18
- Vite 5
- Cloudflare Pages でそのまま配信できる静的フロントエンド構成

## ローカル起動

```bash
npm install
npm run dev
```

開発サーバー起動後に表示された URL をブラウザで開いてください。

本番ビルド確認:

```bash
npm run build
npm run preview
```

## Cloudflare Pages へのデプロイ

このリポジトリは Cloudflare Pages の Git 連携デプロイを前提にしています。

### Pages 側の設定値

- Framework preset: `Vite`
- Production branch: `main`
- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: 空欄のままでOK

### デプロイ手順

1. GitHub にこのリポジトリを push する
2. Cloudflare Dashboard を開く
3. `Workers & Pages` -> `Create application` -> `Pages` -> `Connect to Git`
4. `Aero123421/RVC-soundCutter` を選ぶ
5. 上の設定値を入力して `Save and Deploy`

初回デプロイ後は、`main` ブランチへの push で自動再デプロイされます。

### 参考

- Cloudflare Pages Git integration:
  https://developers.cloudflare.com/pages/get-started/git-integration/
- Cloudflare Pages Vite guide:
  https://developers.cloudflare.com/pages/framework-guides/deploy-a-vite3-project/

## リポジトリ構成

```text
.
|-- index.html
|-- main.jsx
|-- src/entry.jsx
|-- package.json
|-- vite.config.js
`-- README.md
```

## 補足

- `dist/` はビルド成果物なので Git 管理しません
- `node_modules/` も Git 管理しません
- Cloudflare Pages 上では `npm install` と `npm run build` が自動実行されます
