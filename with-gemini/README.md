# with-gemini — GAS 議事録自動 push（Gemini API 整形あり）

Gemini Notes が生成した Docs を Gemini API で再整形し、概要・ネクストアクション・議論の流れを構造化してから GitHub に push する。

→ AI整形が不要（コストゼロ優先）の場合は [`../no-gemini/`](../no-gemini/) を使う。

## セットアップ手順

### 1. このディレクトリを作業リポジトリにコピーする

```bash
cp -r with-gemini/ /path/to/your/repo/gas/meeting-notes
cd /path/to/your/repo/gas/meeting-notes
```

### 2. 定数を書き換える

`src/Code.ts` の冒頭「★ カスタマイズ箇所」を書き換える：

```typescript
const GITHUB_OWNER = 'YOUR_GITHUB_OWNER';  // GitHubのオーナー名
const GITHUB_REPO  = 'YOUR_GITHUB_REPO';   // リポジトリ名
const GITHUB_BRANCH = 'main';              // push先ブランチ
const TARGET_DIR   = 'docs/meeting-notes'; // 議事録の保存先ディレクトリ
const DEFAULT_CALENDAR_IDS = 'YOUR_CALENDAR_ID@group.calendar.google.com';
```

### 3. プロンプトをカスタマイズする（任意）

`src/prompt.ts` の末尾に自社・チームの情報を追記すると生成精度が上がる：

- 会社名・チーム名
- プロダクト名・略称（音声認識の誤変換対策）
- 組織構造・役職の略称
- よく出る固有名詞

### 4. Bot カレンダーを用意する

`../no-gemini/README.md` の手順3と同じ。

### 5. GAS プロジェクトを作成して push する

```bash
pnpm install

# 会議参加者のアカウントでログイン（★重要: Gemini Notes Docs は参加者のみ閲覧可）
pnpm exec clasp login

# GAS プロジェクト新規作成
pnpm exec clasp create --title "Meeting Notes Sync" --type standalone

# .clasp.json の "rootDir": "" を "rootDir": "./dist" に書き換える

pnpm push
```

### 6. GAS エディタで setupScript を実行する

`https://script.google.com/d/<scriptId>/edit` を開く：

1. 関数セレクタで `setupScript` を選択 → ▶ 実行
2. OAuth 承認ダイアログ →「許可」
3. ログに「トリガー設定: syncMeetingNotes を15分おきに実行」が出れば成功

### 7. スクリプトプロパティを設定する

GAS エディタ → プロジェクトの設定 → スクリプトプロパティ：

**GITHUB_TOKEN（GitHub Fine-grained PAT）**
1. GitHub → Settings → Developer settings → Fine-grained personal access tokens → Generate
2. Repository access: 対象リポジトリのみ / Permissions: **Contents → Read and write**
3. `GITHUB_TOKEN` に貼り付け

**GEMINI_API_KEY**
1. [Google AI Studio](https://aistudio.google.com/apikey) で API Key を発行
2. `GEMINI_API_KEY` に貼り付け

### 8. 会議予定に Bot カレンダーを招待する

会議予定のゲストに以下の2アカウントを追加：

- `YOUR_CALENDAR_ID@group.calendar.google.com`
- GAS owner のメールアドレス

### 9. 動作確認

GAS エディタで `syncMeetingNotes` を手動実行し、ログを確認：

```
情報  Processing event: <会議名> (eventId=..., docId=...)
情報    Got 2 tabs
情報    Pushed: docs/meeting-notes/YYMMDD_HHMM_<会議名>.md
```

## 出力ファイル形式

```markdown
<!-- eventId:xxx -->

# 会議タイトル

> 日時: 2026-05-26 20:30
> カレンダーURL: https://...

---

## 議事録（AI生成）
（Gemini API が生成した整形済み議事録）
- 概要・参加者テーブル
- 意思決定・ネクストアクション
- 主要な議論の流れ
- 簡易逐語録

---

## 概要（タブ1）
（Gemini Notes の自動要約・原文）

---

## 文字起こし（タブ2以降）
（話者別の全文文字起こし・原文）
```

## トラブルシューティング

| ログ | 原因 | 対処 |
|---|---|---|
| `Got 0 events` | Bot カレンダーへの招待未承認 / 予定が24時間以上前 | 招待を承認 / 手動で再実行 |
| `Skip (no docs attachments)` | Gemini Notes がまだ生成されていない | 会議終了後5〜10分待って再実行 |
| `GitHub API 404` | GITHUB_TOKEN が placeholder のまま | スクリプトプロパティに実 PAT を貼る |
| `Specified permissions are not sufficient` | appsscript.json にスコープ不足 | `pnpm push` 後に setupScript 再実行 |
| Docs が空 | GAS owner が会議に参加していない | GAS owner を会議のゲストに追加 |
| Gemini 生成がスキップされる | GEMINI_API_KEY が未設定 | スクリプトプロパティに API Key を貼る |
