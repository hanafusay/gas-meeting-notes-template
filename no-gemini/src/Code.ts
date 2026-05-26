/**
 * Google Meet 議事録 → GitHub 自動 push GAS
 *
 * Google Meet + Gemini Notes が自動生成した議事録 Docs を、
 * 指定の Bot カレンダーに紐づいた予定の attachments から取得し、
 * Docs の内容をそのまま Markdown 化して GitHub に直接 push する。
 *
 * AI による再整形は行わない（コスト節約。Gemini Notes の出力品質で十分）。
 * 全体フロー・セットアップ手順は README.md を参照。
 * トリガー: 時間ベース（15分おき推奨）
 */

// ========================================
// ★ カスタマイズ箇所: ここだけ書き換えれば動く
// ========================================

/** push 先の GitHub オーナー名（個人 or Organization） */
const GITHUB_OWNER = 'YOUR_GITHUB_OWNER';

/** push 先の GitHub リポジトリ名 */
const GITHUB_REPO = 'YOUR_GITHUB_REPO';

/** push 先のブランチ名 */
const GITHUB_BRANCH = 'main';

/** push 先のディレクトリ（リポジトリ内のパス） */
const TARGET_DIR = 'docs/meeting-notes';

/**
 * 監視する Bot カレンダーの ID（複数ある場合はカンマ区切り）
 * カレンダーの設定画面 > 「カレンダーの統合」 > 「カレンダー ID」で確認できる
 */
const DEFAULT_CALENDAR_IDS = 'YOUR_CALENDAR_ID@group.calendar.google.com';

// ========================================
// 以下は変更不要
// ========================================

// Docs API スコープ認識用のダミー参照（これがないと OAuth に Docs スコープが含まれない）
const _DOCS_SCOPE_TRIGGER = DocumentApp;

/** スクリプトプロパティの placeholder（未設定の目印として使う） */
const PLACEHOLDER_TOKEN = '<PASTE_GITHUB_FINE_GRAINED_PAT>';

// ========================================
// セクション1: メイン処理
// ========================================

/**
 * 初回セットアップ: スクリプトプロパティと時間トリガーを案内・設定する。
 * GAS エディタから手動で実行する想定。OAuth 同意もここで走る。
 */
// biome-ignore lint/correctness/noUnusedVariables: GAS manual entrypoint
const setupScript = (): void => {
  const props = PropertiesService.getScriptProperties();

  // CALENDAR_IDS: 未設定なら初期値、既存なら維持
  if (!props.getProperty('CALENDAR_IDS')) {
    props.setProperty('CALENDAR_IDS', DEFAULT_CALENDAR_IDS);
    console.log(
      `CALENDAR_IDS をデフォルト値で設定しました: ${DEFAULT_CALENDAR_IDS}`,
    );
  } else {
    console.log(
      `CALENDAR_IDS は既存値を使用します: ${props.getProperty('CALENDAR_IDS')}`,
    );
  }

  // GITHUB_TOKEN: 未設定なら placeholder を入れる（UIで貼り替えやすくするため）
  if (!props.getProperty('GITHUB_TOKEN')) {
    props.setProperty('GITHUB_TOKEN', PLACEHOLDER_TOKEN);
    console.log(
      `GITHUB_TOKEN に placeholder を設定しました。GAS UI から実際の PAT に書き換えてください。`,
    );
  }

  // トリガー登録（既存があれば付け替え）
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'syncMeetingNotes') {
      ScriptApp.deleteTrigger(t);
    }
  }
  ScriptApp.newTrigger('syncMeetingNotes')
    .timeBased()
    .everyMinutes(15)
    .create();
  console.log('トリガー設定: syncMeetingNotes を15分おきに実行');

  // 残作業案内
  const remaining: string[] = [];
  if (props.getProperty('GITHUB_TOKEN') === PLACEHOLDER_TOKEN) {
    remaining.push(
      `GITHUB_TOKEN: ${GITHUB_OWNER}/${GITHUB_REPO} への Contents Read/Write 権限を持つ GitHub Fine-grained PAT を貼り付け`,
    );
  }

  if (remaining.length > 0) {
    console.warn(
      `セットアップ未完了です。GAS エディタ > プロジェクトの設定 > スクリプトプロパティ で以下を設定してください:\n- ${remaining.join('\n- ')}`,
    );
  } else {
    console.log('Setup complete. 全プロパティ設定済み。');
  }
};

/**
 * メインエントリポイント: 直近24時間の予定を処理する
 * GAS のトリガーから呼び出される。
 */
// biome-ignore lint/correctness/noUnusedVariables: GAS trigger entrypoint
const syncMeetingNotes = (): void => {
  const props = PropertiesService.getScriptProperties();
  const calendarIds = (props.getProperty('CALENDAR_IDS') || '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id);

  const githubToken = props.getProperty('GITHUB_TOKEN');
  if (!githubToken || githubToken === PLACEHOLDER_TOKEN) {
    console.error(
      'GITHUB_TOKEN が未設定または placeholder のままです。GAS スクリプトプロパティで実際の PAT に書き換えてください。',
    );
    return;
  }

  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  console.log(
    `syncMeetingNotes start. CALENDAR_IDS=${JSON.stringify(calendarIds)}, range=${yesterday.toISOString()}..${now.toISOString()}`,
  );

  if (calendarIds.length === 0) {
    console.warn('CALENDAR_IDS が空です。setupScript で初期化してください。');
    return;
  }

  let processed = 0;
  let skipped = 0;
  let errored = 0;

  for (const calendarId of calendarIds) {
    console.log(`Processing calendar: ${calendarId}`);
    const counts = processCalendar(calendarId, yesterday, now, githubToken);
    processed += counts.processed;
    skipped += counts.skipped;
    errored += counts.errored;
  }

  console.log(
    `syncMeetingNotes done. processed=${processed} skipped=${skipped} errored=${errored}`,
  );
};

/** 指定カレンダーの予定をすべて処理する */
const processCalendar = (
  calendarId: string,
  timeMin: Date,
  timeMax: Date,
  githubToken: string,
): { processed: number; skipped: number; errored: number } => {
  let events: GoogleAppsScript.Calendar.Schema.Events;
  try {
    events = Calendar.Events!.list(calendarId, {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      supportsAttachments: true,
    });
  } catch (e) {
    console.error(
      `Calendar.Events.list failed for ${calendarId}: ${(e as Error).message}`,
    );
    return { processed: 0, skipped: 0, errored: 1 };
  }

  if (!events || !events.items) {
    console.log(`No events returned for ${calendarId}`);
    return { processed: 0, skipped: 0, errored: 0 };
  }

  console.log(`Got ${events.items.length} events for ${calendarId}`);

  let processed = 0;
  let skipped = 0;
  let errored = 0;

  for (const event of events.items) {
    try {
      const result = processEvent(event, githubToken);
      if (result === 'processed') processed++;
      else skipped++;
    } catch (e) {
      console.error(
        `Error processing event "${event.summary}": ${(e as Error).message}`,
      );
      errored++;
    }
  }

  return { processed, skipped, errored };
};

/** 1イベントを処理する */
const processEvent = (
  event: GoogleAppsScript.Calendar.Schema.Event,
  githubToken: string,
): 'processed' | 'skipped' => {
  const eventId = event.id || '';
  const summary = event.summary || 'untitled';

  if (!eventId) {
    console.log(`Skip (no eventId): ${summary}`);
    return 'skipped';
  }

  if (isPrivateEvent(summary)) {
    console.log(`Skip (private/confidential): ${summary}`);
    return 'skipped';
  }

  const docId = extractDocIdFromEvent(event);
  if (!docId) {
    console.log(`Skip (no docs attachments): ${summary}`);
    return 'skipped';
  }

  if (isAlreadyProcessed(eventId, githubToken)) {
    console.log(`Skip (already processed): ${summary}`);
    return 'skipped';
  }

  console.log(
    `Processing event: ${summary} (eventId=${eventId}, docId=${docId})`,
  );

  const tabs = getAllDocumentTabs_(docId);
  if (!tabs || tabs.length === 0) {
    throw new Error(`Failed to fetch Docs tabs for docId=${docId}`);
  }
  console.log(`  Got ${tabs.length} tabs`);

  const eventStart = getEventStart(event);
  const basePath = buildBasePath(eventStart, summary);
  const files = buildMarkdownFiles_(
    tabs,
    summary,
    eventStart,
    basePath,
    eventId,
    event.htmlLink || '',
  );

  const cleanTitle = cleanSubject_(summary);
  const commitMessage = `chore: add meeting notes - ${cleanTitle}`;
  pushToGitHub_(githubToken, files, commitMessage);
  console.log(`  Pushed: ${basePath}.md`);

  cacheProcessedEventId(eventId);

  return 'processed';
};

// ========================================
// セクション2: 補助ロジック（event解析・既処理判定）
// ========================================

/** タイトルから機密判定 */
const isPrivateEvent = (summary: string): boolean => {
  const lower = summary.toLowerCase();
  return (
    lower.includes('private') ||
    lower.includes('confidential') ||
    lower.includes('1on1') ||
    summary.includes('面接') ||
    summary.includes('評価')
  );
};

/** attachments から先頭の Google Docs ID を取り出す */
const extractDocIdFromEvent = (
  event: GoogleAppsScript.Calendar.Schema.Event,
): string | null => {
  const attachments = event.attachments || [];
  for (const a of attachments) {
    if (a.mimeType === 'application/vnd.google-apps.document' && a.fileId) {
      return a.fileId;
    }
  }
  return null;
};

/** イベントの開始時刻を Date に変換（dateTime か date） */
const getEventStart = (event: GoogleAppsScript.Calendar.Schema.Event): Date => {
  const dt = event.start?.dateTime || event.start?.date;
  if (!dt) return new Date();
  return new Date(dt);
};

/** ファイル保存パス: TARGET_DIR/YYMMDD_HHMM_title */
const buildBasePath = (eventStart: Date, summary: string): string => {
  const tz = Session.getScriptTimeZone();
  const yymmdd = Utilities.formatDate(eventStart, tz, 'yyMMdd');
  const hhmm = Utilities.formatDate(eventStart, tz, 'HHmm');
  const sanitized = sanitizeForFileName_(summary);
  return `${TARGET_DIR}/${yymmdd}_${hhmm}_${sanitized}`;
};

/**
 * 既処理判定: GitHub Code Search で eventId を含むファイルを検索
 * + スクリプトプロパティのキャッシュで API 節約
 */
const isAlreadyProcessed = (eventId: string, githubToken: string): boolean => {
  const cache = getProcessedCache();
  if (cache.has(eventId)) return true;

  const query = `${eventId}+repo:${GITHUB_OWNER}/${GITHUB_REPO}+path:${TARGET_DIR}`;
  const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}`;
  const response = UrlFetchApp.fetch(url, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github.v3+json',
    },
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  if (status !== 200) {
    console.warn(
      `GitHub search API status=${status}: ${response.getContentText().substring(0, 200)}`,
    );
    return false;
  }

  const result = JSON.parse(response.getContentText());
  if ((result.total_count || 0) > 0) {
    cacheProcessedEventId(eventId);
    return true;
  }
  return false;
};

/** スクリプトプロパティに最近処理した eventId を最大100件キャッシュ */
const cacheProcessedEventId = (eventId: string): void => {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty('PROCESSED_EVENT_IDS') || '[]';
  let arr: string[];
  try {
    arr = JSON.parse(raw);
  } catch (_e) {
    arr = [];
  }
  if (!arr.includes(eventId)) {
    arr.push(eventId);
    if (arr.length > 100) arr = arr.slice(arr.length - 100);
    props.setProperty('PROCESSED_EVENT_IDS', JSON.stringify(arr));
  }
};

const getProcessedCache = (): Set<string> => {
  const raw =
    PropertiesService.getScriptProperties().getProperty(
      'PROCESSED_EVENT_IDS',
    ) || '[]';
  try {
    return new Set<string>(JSON.parse(raw));
  } catch (_e) {
    return new Set<string>();
  }
};

// ========================================
// セクション3: Docs API 全タブ取得
// ========================================

const getAllDocumentTabs_ = (
  docId: string,
): Array<{ title: string; text: string; index: number }> => {
  const token = ScriptApp.getOAuthToken();
  const url = `https://docs.googleapis.com/v1/documents/${docId}?includeTabsContent=true`;
  const response = UrlFetchApp.fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true,
  });

  const statusCode = response.getResponseCode();
  if (statusCode !== 200) {
    console.error(
      `Docs API error (${statusCode}): ${response.getContentText().substring(0, 300)}`,
    );
    return getTabsFallback_(docId);
  }

  const doc = JSON.parse(response.getContentText());
  const tabs = doc.tabs || [];
  if (tabs.length === 0) {
    return getTabsFallback_(docId);
  }

  const result: Array<{ title: string; text: string; index: number }> = [];
  for (const tab of tabs) {
    const tabTitle =
      tab.tabProperties?.title || `タブ${(tab.tabProperties?.index || 0) + 1}`;
    const content = tab.documentTab?.body?.content || [];
    const text = extractTextFromDocContent_(content);
    if (text.trim().length > 0) {
      result.push({
        title: tabTitle,
        text: text.trim(),
        index: tab.tabProperties?.index || 0,
      });
    }
    for (const childTab of tab.childTabs || []) {
      const childTitle =
        childTab.tabProperties?.title ||
        `${tabTitle}_子タブ${(childTab.tabProperties?.index || 0) + 1}`;
      const childContent = childTab.documentTab?.body?.content || [];
      const childText = extractTextFromDocContent_(childContent);
      if (childText.trim().length > 0) {
        result.push({
          title: childTitle,
          text: childText.trim(),
          index: childTab.tabProperties?.index || 0,
        });
      }
    }
  }
  return result;
};

// biome-ignore lint/suspicious/noExplicitAny: GAS Docs API response is loosely typed
const extractTextFromDocContent_ = (content: any[]): string => {
  const headingMap: Record<string, string> = {
    HEADING_1: '# ',
    HEADING_2: '## ',
    HEADING_3: '### ',
    HEADING_4: '#### ',
    HEADING_5: '##### ',
    HEADING_6: '###### ',
  };

  let text = '';
  let isFirstHeading = true;

  for (const element of content) {
    if (element.paragraph) {
      const style =
        element.paragraph.paragraphStyle?.namedStyleType || 'NORMAL_TEXT';
      const prefix = headingMap[style] || '';

      // biome-ignore lint/suspicious/noExplicitAny: see file-level pragma
      const paragraphText = (element.paragraph.elements || [])
        .map((el: any) => {
          if (el.textRun) {
            // Docs API は段落内の Shift+Enter 由来の soft line break を
            // U+000B (VT) で、ページ/カラム区切りを U+000C (FF) で返す。
            // そのまま Markdown に書くと GitHub レンダラーが制御文字を
            // 表示できず `��` 化する（U+FFFD 置換文字として描画される）ため、
            // 段落区切りに正規化する。
            return (el.textRun.content || '').replace(/[\v\f]/g, '\n\n');
          }
          if (el.inlineObjectElement) return '[画像]';
          return '';
        })
        .join('');

      if (paragraphText.trim().length === 0) {
        text += '\n';
        continue;
      }

      if (prefix) {
        if (!isFirstHeading) {
          text += '\n---\n\n';
        }
        text += `${prefix}${paragraphText.replace(/\n$/, '')}\n\n`;
        isFirstHeading = false;
      } else {
        text += paragraphText;
      }
    }

    if (element.table) {
      for (const row of element.table.tableRows || []) {
        // biome-ignore lint/suspicious/noExplicitAny: see file-level pragma
        const cells = (row.tableCells || [])
          .map((cell: any) => {
            const cellContent = cell.content || [];
            return extractTextFromDocContent_(cellContent).trim();
          })
          .join(' | ');
        text += `${cells}\n`;
      }
      text += '\n';
    }
  }

  return text;
};

/** DocumentApp / Drive API でフォールバック取得 */
const getTabsFallback_ = (
  docId: string,
): Array<{ title: string; text: string; index: number }> => {
  try {
    const doc = DocumentApp.openById(docId);
    const bodyText = doc.getBody().getText().trim();
    if (bodyText.length > 0) {
      return [{ title: 'メインコンテンツ', text: bodyText, index: 0 }];
    }
  } catch (e) {
    console.warn(`DocumentApp fallback failed: ${(e as Error).message}`);
  }

  const token = ScriptApp.getOAuthToken();
  const url = `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=text/plain`;
  const response = UrlFetchApp.fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) {
    throw new Error(`Drive API export failed: ${response.getResponseCode()}`);
  }
  const text = response.getContentText().trim();
  if (text.length === 0) throw new Error('Document is empty');
  return [{ title: 'メインコンテンツ', text, index: 0 }];
};

// ========================================
// セクション4: Markdown生成
// ========================================

const buildMarkdownFiles_ = (
  tabs: Array<{ title: string; text: string; index: number }>,
  subject: string,
  eventDate: Date,
  basePath: string,
  eventId: string,
  htmlLink: string,
): Array<{ path: string; content: string }> => {
  const tz = Session.getScriptTimeZone();
  const dateFormatted = Utilities.formatDate(eventDate, tz, 'yyyy-MM-dd HH:mm');
  const cleanTitle = cleanSubject_(subject);

  const lines: string[] = [
    `<!-- eventId:${eventId} -->`,
    '',
    `# ${cleanTitle}`,
    '',
    `> 日時: ${dateFormatted}`,
  ];

  if (htmlLink) {
    lines.push(`> カレンダーURL: ${htmlLink}`);
  }
  lines.push('');

  tabs.forEach((tab) => {
    lines.push('---', '', `## ${tab.title}`, '', tab.text, '');
  });

  return [{ path: `${basePath}.md`, content: lines.join('\n') }];
};

// ========================================
// セクション5: GitHub Git Data API
// ========================================

const pushToGitHub_ = (
  token: string,
  files: Array<{ path: string; content: string }>,
  commitMessage: string,
): void => {
  const MAX_RETRIES = 3;
  const apiBase = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
  };

  const treeItems: Array<{
    path: string;
    mode: string;
    type: string;
    sha: string;
  }> = [];
  for (const file of files) {
    const blobRes = fetchGitHubAPI_(
      `${apiBase}/git/blobs`,
      'post',
      { content: file.content, encoding: 'utf-8' },
      headers,
    );
    treeItems.push({
      path: file.path,
      mode: '100644',
      type: 'blob',
      sha: blobRes.sha,
    });
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const refRes = fetchGitHubAPI_(
      `${apiBase}/git/ref/heads/${GITHUB_BRANCH}`,
      'get',
      null,
      headers,
    );
    const headCommitSha = refRes.object.sha;

    const commitRes = fetchGitHubAPI_(
      `${apiBase}/git/commits/${headCommitSha}`,
      'get',
      null,
      headers,
    );
    const baseTreeSha = commitRes.tree.sha;

    const treeRes = fetchGitHubAPI_(
      `${apiBase}/git/trees`,
      'post',
      { base_tree: baseTreeSha, tree: treeItems },
      headers,
    );

    const now = new Date().toISOString();
    const newCommitRes = fetchGitHubAPI_(
      `${apiBase}/git/commits`,
      'post',
      {
        message: commitMessage,
        tree: treeRes.sha,
        parents: [headCommitSha],
        author: {
          name: 'GAS AutoSave',
          email: 'gas-autosave@users.noreply.github.com',
          date: now,
        },
        committer: {
          name: 'GAS AutoSave',
          email: 'gas-autosave@users.noreply.github.com',
          date: now,
        },
      },
      headers,
    );

    const refUpdateRes = fetchGitHubAPIWithStatus_(
      `${apiBase}/git/refs/heads/${GITHUB_BRANCH}`,
      'patch',
      { sha: newCommitRes.sha },
      headers,
    );

    if (refUpdateRes.ok) {
      console.log(
        `GitHub commit: ${newCommitRes.sha.substring(0, 7)}` +
          (attempt > 1 ? ` (retried ${attempt})` : ''),
      );
      return;
    }

    if (refUpdateRes.status === 422 && attempt < MAX_RETRIES) {
      console.log(`Ref update conflict, retry ${attempt}/${MAX_RETRIES}...`);
      Utilities.sleep(2000 * attempt);
      continue;
    }

    throw new Error(
      `GitHub ref update failed (${refUpdateRes.status}): ${refUpdateRes.body}`,
    );
  }
};

const fetchGitHubAPI_ = (
  url: string,
  method: GoogleAppsScript.URL_Fetch.HttpMethod,
  // biome-ignore lint/suspicious/noExplicitAny: payload is JSON-serializable
  payload: any,
  headers: Record<string, string>,
  // biome-ignore lint/suspicious/noExplicitAny: returns parsed JSON
): any => {
  const options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
    method,
    headers,
    muteHttpExceptions: true,
  };
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  const response = UrlFetchApp.fetch(url, options);
  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    const errorBody = response.getContentText();
    throw new Error(`GitHub API ${status}: ${errorBody.substring(0, 200)}`);
  }
  return JSON.parse(response.getContentText());
};

const fetchGitHubAPIWithStatus_ = (
  url: string,
  method: GoogleAppsScript.URL_Fetch.HttpMethod,
  // biome-ignore lint/suspicious/noExplicitAny: payload is JSON-serializable
  payload: any,
  headers: Record<string, string>,
): { ok: boolean; status: number; body: string } => {
  const options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
    method,
    headers,
    muteHttpExceptions: true,
  };
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  const response = UrlFetchApp.fetch(url, options);
  const status = response.getResponseCode();
  return {
    ok: status >= 200 && status < 300,
    status,
    body: response.getContentText(),
  };
};

// ========================================
// セクション6: 文字列処理ユーティリティ
// ========================================

/** Gemini メール件名形式（「メモ:「タイトル」（年月日）」）のノイズ除去 */
const cleanSubject_ = (text: string): string => {
  return (
    text
      .replace(/^メモ:\s*「(.+?)」\s*/, '$1')
      .replace(/[（(]\d{4}年\d{1,2}月\d{1,2}日[）)]\s*$/, '')
      .trim() || text
  );
};

/** ファイルシステムに安全な文字列に変換 */
const sanitizeForFileName_ = (text: string): string => {
  return (
    cleanSubject_(text)
      .replace(/[\s　]+/g, '_')
      .replace(/[/\\:*?"<>|#%&{}$!'@+`=]/g, '')
      .replace(/^[._]+|[._]+$/g, '')
      .substring(0, 80) || 'untitled'
  );
};
