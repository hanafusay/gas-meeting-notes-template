# gas-meeting-notes-template

Google Meet + Gemini Notes の議事録を **Bot カレンダー経由で自動検出し、GitHub に Markdown で直 push** する GAS（Google Apps Script）テンプレート。

## どちらを使う？

| | [`no-gemini/`](./no-gemini/) | [`with-gemini/`](./with-gemini/) |
|---|---|---|
| **AI整形** | なし（Gemini Notes の出力をそのまま） | あり（Gemini API で議事録を再生成） |
| **コスト** | 無料 | Gemini API 従量課金（月数回なら数円〜数十円程度） |
| **必要な設定** | `GITHUB_TOKEN` のみ | `GITHUB_TOKEN` + `GEMINI_API_KEY` |
| **向き不向き** | 文字起こしの生ログで十分な場合 | 整形済み議事録・ネクストアクション抽出が欲しい場合 |

→ 使いたいディレクトリを丸ごとコピーして使う。セットアップ手順は各ディレクトリの README を参照。

---

## 仕組み（共通）

```
Google Meet 開催（Gemini Notes 有効）
        ↓
Gemini Notes → Google Docs 生成（全タブ: 概要 + 話者別文字起こし）
        ↓
Google Calendar の予定 attachments に Docs が自動添付される
        ↓
GAS（15分おきのトリガー）が Bot カレンダーをスキャン
        ↓
Docs API で全タブを取得
（with-gemini: さらに Gemini API で議事録を再生成）
        ↓
GitHub Git Data API で対象リポジトリに直 push
```

**冪等性**: 各ファイルに `<!-- eventId:XXX -->` を埋め込み、同じ会議が2度 push されることはない。

---

## 会議を Bot に拾わせる方法

Google Meet の会議予定のゲストに **2アカウント** を招待するだけ：

| 招待先 | 理由 |
|---|---|
| Bot カレンダーの ID（`xxx@group.calendar.google.com`） | GAS がこのカレンダーを監視しているため |
| GAS owner のメールアドレス | Gemini Notes Docs は会議参加者のみ閲覧可のため |
