# gas-meeting-notes-template

Google Meet + Gemini Notes の議事録を **Bot カレンダー経由で自動検出し、GitHub に Markdown で直 push** する GAS（Google Apps Script）テンプレート。

AI による再整形は行わない。Gemini Notes が生成した「概要」「文字起こし」タブをそのまま Markdown 化して push する。

## 仕組み

```
Google Meet 開催（Gemini Notes 有効）
        ↓
Gemini Notes → Google Docs 生成（全タブ: 概要 + 話者別文字起こし）
        ↓
Google Calendar の予定 attachments に Docs が自動添付される
        ↓
GAS（15分おきのトリガー）が Bot カレンダーをスキャン
        ↓
Docs API で全タブを取得 → Markdown に変換
        ↓
GitHub Git Data API で対象リポジトリに直 push
```

**冪等性**: 各ファイルに `<!-- eventId:XXX -->` を埋め込み、GitHub Code Search で既処理を判定する。同じ会議が2度 push されることはない。

## セットアップ手順

### 1. このテンプレートからリポジトリを作成

「Use this template」→「Create a new repository」でリポジトリを作る（または clone して使う）。

### 2. 定数を書き換える

`src/Code.ts` の冒頭のカスタマイズ箇所を書き換える：

```typescript
const GITHUB_OWNER = 'YOUR_GITHUB_OWNER';  // GitHubのオーナー名
const GITHUB_REPO  = 'YOUR_GITHUB_REPO';   // リポジトリ名
const GITHUB_BRANCH = 'main';              // push先ブランチ
const TARGET_DIR   = 'docs/meeting-notes'; // 議事録の保存先ディレクトリ
const DEFAULT_CALENDAR_IDS = 'YOUR_CALENDAR_ID@group.calendar.google.com'; // Bot カレンダーID
```

### 3. Bot カレンダーを用意する

議事録を自動取得させたい「Bot 用の共有カレンダー」を Google Calendar に作成する。

**カレンダー ID の確認方法:**
1. Google Calendar → 対象カレンダー → ⋮（縦点3つ）→「設定と共有」
2. 「カレンダーの統合」セクション → 「カレンダー ID」をコピー

> **Note:** Service Account で組織カレンダーとして所有する場合は、GCP Console で SA を作成し、Calendar API を有効化してから SA の認証情報で `calendars.insert` → `acl.insert` する。

### 4. GAS プロジェクトを作成して push する

```bash
# 依存パッケージのインストール
pnpm install

# Google アカウントでログイン（会議参加者のアカウントで行うこと）
pnpm exec clasp login

# GAS プロジェクトを新規作成
pnpm exec clasp create --title "Meeting Notes Sync" --type standalone
# → .clasp.json が生成される

# .clasp.json の rootDir を "./dist" に書き換える
# （エディタで開いて "rootDir": "" → "rootDir": "./dist" に変更）

# ビルドして GAS にデプロイ
pnpm push
```

> **重要:** `clasp login` は会議参加者のアカウントで行う。Gemini Notes が生成する Docs は**会議参加者のみ閲覧可**のため、GAS の OAuth オーナーが会議に参加していないと Docs を読めない。

### 5. GAS エディタで setupScript を実行する

1. GAS エディタを開く（`https://script.google.com/d/<scriptId>/edit`）
2. 関数セレクタで `setupScript` を選択 → ▶ 実行
3. OAuth 承認ダイアログが出たら「許可」
4. 実行ログに「トリガー設定: syncMeetingNotes を15分おきに実行」が出れば成功

### 6. GitHub Fine-grained PAT を設定する

1. GitHub → Settings → Developer settings → Fine-grained personal access tokens → Generate new token
2. Repository access: 対象リポジトリのみ
3. Permissions: **Contents → Read and write**
4. GAS エディタ → プロジェクトの設定（歯車アイコン）→ スクリプトプロパティ
5. `GITHUB_TOKEN` の値を生成した PAT に書き換える

### 7. 会議の予定に Bot カレンダーを招待する

Google Meet の会議予定を作るとき（または既存の予定を編集するとき）、ゲストとして以下の **2アカウント** を追加する：

| 招待先 | 理由 |
|---|---|
| `YOUR_CALENDAR_ID@group.calendar.google.com` | GAS がこのカレンダーを監視しているため |
| GAS owner のメールアドレス | Gemini Notes Docs は会議参加者のみ閲覧可のため |

### 8. 動作確認

1. Google Meet で会議を開催し、Gemini Notes を有効にする
   - Meet 画面内 → ✨（Gemini）アイコン → 「メモを取る」をオン
2. 会議終了後5〜10分待つ（Gemini Notes の生成に時間がかかる）
3. GAS エディタで `syncMeetingNotes` を手動実行
4. 実行ログで以下を確認:
   ```
   情報  Processing event: <会議名> (eventId=..., docId=...)
   情報    Got 2 tabs
   情報    Pushed: docs/meeting-notes/YYMMDD_HHMM_<会議名>.md
   ```
5. GitHub リポジトリに `.md` ファイルが入っていることを確認

## 出力ファイル形式

```
docs/meeting-notes/
└── 260526_2030_勉強会.md
```

```markdown
<!-- eventId:1b9ju7c3f53bu13j514a5ovil4 -->

# 勉強会

> 日時: 2026-05-26 20:30
> カレンダーURL: https://www.google.com/calendar/event?eid=...

---

## 概要（タブ1）
（Gemini Notes が生成した自動要約）

---

## 文字起こし（タブ2以降）
（話者別の全文文字起こし）
```

## トラブルシューティング

| ログ | 原因 | 対処 |
|---|---|---|
| `Got 0 events` | Bot カレンダーへの招待が未承認、または予定が24時間以上前 | 招待を承認する / 手動で時間範囲を広げて実行 |
| `Skip (no docs attachments)` | Gemini Notes がまだ生成されていない | 会議終了後5〜10分待ってから再実行 |
| `GitHub API 404` | GITHUB_TOKEN が placeholder のまま | スクリプトプロパティに実 PAT を貼る |
| `Specified permissions are not sufficient` | appsscript.json にスコープが足りない | `pnpm push` 後に setupScript を再実行 |
| Docs が空で取得できない | GAS owner が会議に参加していない | GAS owner を会議のゲストに追加する |

## コード変更フロー

```bash
# lint + 型チェック
pnpm lint && pnpm typecheck

# ビルドして GAS に反映
pnpm push
```

## スクリプトプロパティ一覧

| Key | 説明 | 設定方法 |
|---|---|---|
| `CALENDAR_IDS` | 監視するカレンダー ID（カンマ区切りで複数可） | setupScript が自動設定（変更は GAS UI から） |
| `GITHUB_TOKEN` | GitHub Fine-grained PAT | setupScript が placeholder を入れる → GAS UI で実値に書き換え |
| `PROCESSED_EVENT_IDS` | 処理済み eventId のキャッシュ（自動管理） | 手動変更不要 |
