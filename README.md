# ふじさわレンズ

「ふだんは街を知る。災害時は必要な情報にすぐたどり着く。」

神奈川県藤沢市を対象にした、軽量な静的ホームページです。

- **避難先を探す**：災害の種類（洪水・地震・津波など）を選び、指定緊急避難場所／指定避難所を探します。現在地から近い順（直線距離、端末内で計算）、または施設名・住所・地区名で探せます。Google マップは利用者がリンクを押したときだけ開きます。
- **避難所の混雑状況**：まず藤沢市の公式の開設・混雑状況へ案内します。そのうえで、ログイン不要の匿名「利用者報告」を共有できます（小さなサーバーレスAPIが必要。未設定なら「準備中」と表示）。
- **藤沢の環境変化**：土地利用・土地被覆、海水浴場の水質、大気環境の公開データを、出典・対象期間・限界つきで表示します。

ログイン・会員登録なし。広告・解析タグ・外部フォント・外部画像・地図の埋め込みなし。Cookie 不使用。

> 当サイトは非公式です。公式発表の代わりではありません。災害時は藤沢市・気象庁などの最新情報と現地の状況を優先してください。

実装状況・既知の限界は [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)、出典・ライセンスは [DATA_SOURCES.md](DATA_SOURCES.md) を参照してください。

## 構成

```
site/                    公開する静的サイト（このフォルダをそのまま配信する）
  index.html             ホーム（災害時の入口を最上部に配置）
  shelters.html          避難先を探す
  crowding.html          混雑状況（公式情報への案内＋利用者報告）
  environment.html       藤沢の環境変化
  sources.html           出典・データの扱い
  privacy.html           プライバシー・注意事項
  offline.html           オフライン時の代替ページ
  sw.js                  Service Worker（オフライン参照用。PWAインストール案内はしない）
  config.js              公開設定（混雑APIのURL。秘密情報なし）
  assets/css, assets/js  CSS と最小限の JavaScript（ES modules、ビルド不要）
  data/shelters.json     正規化した避難先データ
  data/status.json       トップページ用の更新状況
  data/environment/      軽量化した環境データ（集計済み JSON・小さな画像）
scripts/                 データ取込・検証・計測・ローカルサーバー
  fetch-shelters.mjs     避難先データの取込（国土地理院）＋藤沢市ページとの照合
  lib/shelters-core.mjs  正規化・照合・検証の純粋関数
  build-worker-ids.mjs   Worker の施設ID許可リストを生成
  build-status.mjs       data/status.json を生成
  env/                   環境データの取得・前処理（README_ENV.md 参照）
  dev-server.mjs         ローカル確認用サーバー（依存なし）
  measure-size.mjs       通信量の計測（Playwright）
  check-links.mjs        リンク確認
  write-config.mjs       環境変数から site/config.js を生成
data-manual/notices.json 公式告知（休止など）の手動反映
reports/                 取込時の照合レポート
worker/                  混雑共有API（Cloudflare Workers + D1）
tests/unit, tests/browser 自動テスト
```

必要なもの：Node.js 20 以上（依存パッケージなし）。ブラウザテストと通信量計測には Playwright（Chromium）が必要です。環境データの再作成には Python 3 が必要です（`scripts/env/run_all.sh` が `.cache/env/venv` に numpy・rasterio・shapely・pyshp・pdfplumber を入れます）。

## ローカルで起動

```sh
npm run dev        # http://127.0.0.1:8787/ 混雑共有は「準備中」表示
npm run dev:api    # メモリ保存の混雑APIも起動（検証用。再起動で消え、画面にもその旨を表示）
```

`site/` は静的ファイルだけなので、任意の静的サーバーでも表示できます（Service Worker は `http://localhost` か HTTPS でのみ動作）。

## テスト

```sh
npm test               # 単体テスト（距離計算・絞り込み・取込/照合/検証・API・クライアント・公開データの検証）
npm run test:browser   # ブラウザテスト（Playwright/Chromium。モバイル幅・コンソールエラー・外部読込・GPS拒否/非対応/タイムアウト・オフライン・混雑投稿など）
npm run measure        # 通信量の計測
npm run check:links    # リンク確認（外部URLにアクセスする）
```

Playwright がない環境では `npm i -D playwright && npx playwright install chromium` で用意してください（このリポジトリは依存を固定していません）。

## データ更新

### 避難先

```sh
npm run data:shelters        # 取得→照合→検証→ site/data/shelters.json 等を更新
node scripts/fetch-shelters.mjs --dry-run   # 書き出さずに差分・照合結果だけ確認
```

1. 国土地理院の地理院タイル（指定緊急避難場所 `skhb01`〜`08`、指定一般避難所 `sih`。藤沢市域を覆う z10 タイル）を取得し、住所が「神奈川県藤沢市」の地物だけを抽出します。座標は国土地理院データの値のみを使い、住所から推測しません。
2. 藤沢市「指定避難所・指定緊急避難場所の指定について」の一覧表と照合し、指定内容の不一致を `cityPageCheck` に記録します（画面では「要確認」と表示）。市ページは照合専用で、内容は配信データに転載しません。
3. 表の見出し・列数が想定と違う場合（レイアウト変更）は失敗して終了します。
4. 検証エラー（施設数の急減、重複ID、市外の住所、範囲外の座標など）や、市ページで「休止」と表示されているのに `data-manual/notices.json` に反映されていない施設がある場合は、**既存の shelters.json を上書きしません**。
5. 結果と前回からの差分は `reports/shelters-check.md` に出力されます。**公開前に必ず差分を目視確認**してください。
6. 公式に休止などの告知が出た場合は `data-manual/notices.json` に追記します（出典URL・確認日・要旨。告知文の転載はしない）。
7. 更新後は `npm test` を実行し、コミットします。`lastCheckedAt`（最終確認日）は取込を実行した日になります。

自動更新はしていません。画面にも「保守担当者が取込を実行した時点の内容」と表示しています。

### 環境データ

`scripts/env/README_ENV.md` を参照してください。データごとに取得方法・更新頻度・手作業が必要な箇所が異なります。

## 混雑共有APIのデプロイ（利用者が行う作業）

構成：静的サイト（任意のホスティング）＋ Cloudflare Workers ＋ D1（SQLite）。

選定理由：静的サイトと分離でき、無料枠の範囲で小規模に運用でき、SQL で保存期間の削除が容易で、サーバー管理が不要なため。代替案（Supabase、Firebase、自前サーバー）は認証・SDK・常時稼働サーバーの管理が増えるため、初期版では採用していません。

アカウント作成・課金設定・デプロイは自動では行いません。以下を利用者が実行します。

```sh
cd worker
cp wrangler.toml.example wrangler.toml          # wrangler.toml は .gitignore 済み
npx wrangler login
npx wrangler d1 create fujisawa-lens-crowding   # 出力された database_id を wrangler.toml に記入
npx wrangler d1 execute fujisawa-lens-crowding --remote --file schema.sql
npx wrangler secret put RATE_LIMIT_SECRET       # 長いランダム文字列（例: openssl rand -hex 32）
# wrangler.toml の ALLOWED_ORIGINS を静的サイトの公開URLに変更
npx wrangler deploy
```

デプロイ後、静的サイト側の設定を更新します。

```sh
CROWDING_API_BASE=https://fujisawa-lens-crowding.<あなたのサブドメイン>.workers.dev npm run config
```

その後 `site/` を公開し直します。公開前に `privacy.html` の「サーバー基盤」の説明が実際の設定（ログ機能の有効/無効、保存期間）と一致しているか確認してください。

施設データを更新したら `node scripts/build-worker-ids.mjs` を実行して Worker を再デプロイしてください（許可IDの同期）。

### API の仕様

- `GET /api/crowding`：有効期間（初期30分）内の報告を施設ごとに集計。報告数・区分ごとの件数・最新報告時刻・対象期間・状態（`insufficient` 情報不足／`mixed` ばらつき／`leading` 過半数の区分あり）を返す。
- `POST /api/reports`：`{"facilityId":"fjs-…","level":"empty|some|crowded|unknown"}` のみ受け付ける（他の項目があれば拒否）。

### 連投・いたずら対策と限界

| 対策 | 内容 |
|---|---|
| 入力検証 | 施設IDは許可リスト（`facility-ids.json`）と形式で検証。区分は4値のみ。余計なフィールド（位置情報など）があれば拒否。本文256バイト以下、`Content-Type: application/json` 必須 |
| Origin 制限 | `ALLOWED_ORIGINS` 以外のオリジンからの投稿を拒否 |
| 同一施設の再報告 | 同じ送信元から同じ施設へは10分間再報告不可 |
| 送信元ごとの上限 | 1時間に10件まで |
| 施設ごとの上限 | 全体で1分間に30件まで（多数のIPからの集中を抑止） |
| 有効期限 | 30分より古い報告は集計しない。24時間で削除 |
| 表示 | 3件未満、または「わからない」を除いた件数が3件未満なら「情報不足」。過半数の区分がない場合は「ばらつきあり」。断定表現は使わない |
| SQL インジェクション | すべてプレースホルダ（`bind`）で実行 |
| XSS | 画面への表示は `textContent` のみ（HTML として挿入しない） |

限界：送信元の識別は IP アドレスのハッシュのみなので、IP を変えられる相手（モバイル回線の切替、VPN、多数の端末）による偽報告は防ぎきれません。同じ回線（家庭・避難所の Wi-Fi など）を共有する人は同じ送信元とみなされ、正当な報告が制限される場合があります。CAPTCHA（例：Cloudflare Turnstile）は外部スクリプトの読み込みと通信量が増えるため初期版では採用していません。

プライバシーへの影響：レート制限のため、IP アドレスを「日替わりの秘密値＋HMAC-SHA256」で不可逆化した値（先頭128bit）を最長1時間だけ D1 に保存します。生の IP は保存しません。秘密値を知る運用者は、特定のIPが報告したかを総当たりで確かめられる可能性があるため、秘密値は厳重に管理してください。Cloudflare 自体の運用ログについては Cloudflare のポリシーに従い、当サイトが制御できる範囲（Workers のログ機能）は無効を初期値にしています。

## 静的サイトの公開（利用者が行う作業）

### GitHub Pages で公開する場合

`.github/workflows/pages.yml` が、`main` ブランチへの push 時に単体テストと内部リンク確認を行い、成功したら `site/` を GitHub Pages に公開します。

1. `main` ブランチを用意し（作業ブランチをマージ）、Settings → General の Default branch を `main` にする
2. Settings → Pages → Build and deployment → Source を「GitHub Actions」にする
3. `main` に push するか、Actions タブの「Deploy site to GitHub Pages」→「Run workflow」で実行
4. 公開URL（例：`https://<ユーザー名>.github.io/fujisawa-renzu/`）は Actions の実行結果と Settings → Pages に表示される

公開ページは誰でも閲覧できます。

### その他のホスティング

`site/` フォルダをそのまま静的ホスティングに配置します（GitHub Pages、Cloudflare Pages など）。ビルド工程はありません。HTTPS で配信してください（Service Worker と位置情報に必要）。gzip/brotli 圧縮配信が有効なホスティングを推奨します。

## 通信量

計測方法：`npm run measure`。Playwright（Chromium、幅390px、Service Worker 無効）で各ページを開き、`networkidle` までに発生した同一オリジンのリクエストを記録し、各ファイルの非圧縮サイズと gzip(-9) 圧縮後サイズを合計しています（実際の転送量はホスティングの圧縮方式・HTTPヘッダで多少変わります）。外部へのリクエストがないことも同時に確認しています。

計測結果は [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md#通信量の実測) に記録しています。

## ライセンス

コード：未設定（リポジトリ所有者が決定してください）。データの出典と利用条件は [DATA_SOURCES.md](DATA_SOURCES.md) に従います。
