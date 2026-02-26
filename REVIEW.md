# X Bookmark URL Collector — コードレビュー

## 総合評価

全体的に**よくまとまった軽量な Chrome 拡張**です。依存ライブラリゼロ・ビルド不要というシンプルな構成で、目的を的確に達成しています。以下、カテゴリごとに詳細なフィードバックをまとめます。

---

## 良い点

1. **シンプルなアーキテクチャ** — Manifest V3 準拠で、content script + popup の最小構成。依存ライブラリなし、ビルドステップなしで導入が容易。
2. **IIFE による名前空間の保護** — `content.js` を即時実行関数で囲み、グローバル汚染を防止している（`content.js:1`）。
3. **重複排除** — `Map` を使って URL ベースの O(1) 重複チェックを実現（`content.js:3`）。
4. **引用ツイートの除外処理** — メディア抽出・テキスト抽出の両方で `quoteContainer` を正しく除外しており、データの正確性が高い。
5. **Excel 互換** — TSV に BOM (`\uFEFF`) を付与し、Excel で直接開いても文字化けしない（`content.js:222`）。
6. **自動停止ロジック** — 3 回連続で新規コンテンツがなければ自動停止＆ダウンロードする設計が実用的（`content.js:244-250`）。
7. **UI/UX** — X のダークテーマに合わせた統一感のあるデザイン、リアルタイムのタグ分布表示、トーストによるフィードバック。

---

## バグ・不具合

### B-1: `setInterval` + `setTimeout` の競合リスク（重要度: 中）

**場所:** `content.js:234-265`

`autoScroll()` は `setInterval(autoScroll, 2500)` で呼ばれ、内部で `setTimeout(() => ..., 1500)` を使っている。`setInterval` は前回の実行完了を待たないため、スクロール量やネットワーク遅延によっては `setTimeout` 内の処理が前回分とオーバーラップする可能性がある。

**推奨:** `setInterval` を `setTimeout` のチェーンに置き換える。

```js
function startCollecting() {
  if (isCollecting) return;
  isCollecting = true;
  noNewContentCount = 0;
  extractTweetUrls();
  sendStatus();
  scheduleNextScroll();
}

function scheduleNextScroll() {
  scrollInterval = setTimeout(() => {
    autoScroll(() => {
      if (isCollecting) scheduleNextScroll();
    });
  }, 2500);
}
```

### B-2: `hasVideo` が boolean であるにも関わらず文字列チェック（重要度: 低）

**場所:** `popup.js:68`

```js
const videoIcon = item.hasVideo ? '🎬' : '';
```

`GET_DATA` のレスポンスでは `hasVideo` は boolean だが、TSV 生成時に `'true'`/`'false'` 文字列に変換している（`content.js:207`）。現在の実装ではデータソースが Map から直接取られるため問題ないが、将来的に TSV パース結果を使う場合は不整合が起きうる。

### B-3: `storage` パーミッションが未使用（重要度: 低）

**場所:** `manifest.json:6`

`permissions` に `"storage"` が宣言されているが、コード中に `chrome.storage` の利用箇所がない。不要なパーミッションはユーザーの信頼性に影響するため削除を推奨。

---

## セキュリティ

### S-1: XSS リスク — `innerHTML` での動的コンテンツ挿入（重要度: 高）

**場所:** `popup.js:48-50`, `popup.js:66-75`

```js
// popup.js:48-50
summary.innerHTML = sorted.map(([tag, count]) =>
  `<span class="tag-badge">${tag}: ${count}</span>`
).join('');

// popup.js:70-74
return `<div class="preview-item">
  <span class="url">${item.url}</span> ${mediaIcon}${videoIcon}${quoteIcon}<br>
  @${item.author}${item.text ? ' — ' + item.text.substring(0, 50) + '...' : ''}
  <br><span class="tags">${item.tags}</span>
</div>`;
```

`item.url`, `item.author`, `item.text`, `item.tags` はすべて X.com の DOM から取得されたユーザー制御可能なデータであり、エスケープなしに `innerHTML` へ挿入している。悪意あるツイートにHTMLタグが含まれていた場合、ポップアップ内でスクリプトが実行される可能性がある。

**推奨:** `textContent` + DOM API を使うか、最低限 HTML エスケープ関数を通す。

```js
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
```

### S-2: Content Script のメッセージ送信元検証なし（重要度: 低）

**場所:** `content.js:289`

`chrome.runtime.onMessage.addListener` では送信元の検証をしていない。Chrome Extension のメッセージング API は同一拡張内に限定されるため実害は低いが、明示的に `sender.id === chrome.runtime.id` をチェックすると防御的になる。

---

## コード品質・改善提案

### C-1: テキストのサニタイズ処理の重複

**場所:** `content.js:200`

`clean()` 関数が `generateTsv()` 内にクロージャとして定義されている。この関数は `forEach` のイテレーション毎に再生成される。パフォーマンスへの影響は軽微だが、ループ外に移動させるのが望ましい。

```js
const clean = s => (s || '').replace(/[\t\n\r]/g, ' ');
// ↑ forEach の外に移動
```

### C-2: マジックナンバーの定数化

**場所:** 複数箇所

以下の値を定数として定義すると可読性・保守性が向上する。

```js
const SCROLL_INTERVAL_MS = 2500;
const SCROLL_WAIT_MS = 1500;
const SCROLL_RATIO = 0.8;
const MAX_NO_CONTENT_COUNT = 3;
const TEXT_PREVIEW_LENGTH = 200;
const POPUP_PREVIEW_COUNT = 15;
```

### C-3: エラーの無視

**場所:** `content.js:32`, `content.js:285`, `popup.js:9`

`catch {}` や `catch(() => {})` で例外を完全に無視している箇所が複数ある。デバッグ時に問題の特定が困難になるため、少なくとも `console.debug()` でログ出力することを推奨。

### C-4: `imageUrls` の重複チェックが O(n)

**場所:** `content.js:33`

```js
if (!imageUrls.includes(src)) {
  imageUrls.push(src);
}
```

`Array.includes` は O(n)。画像数は最大 4 枚程度なので実質的な問題はないが、`Set` を使えばより意図が明確になる。

### C-5: `matches` パターンの改善

**場所:** `manifest.json:20`

```json
"matches": ["https://x.com/i/bookmarks*", "https://twitter.com/i/bookmarks*"]
```

Manifest V3 の match pattern では `*` はパスの区切りを含まない。`/i/bookmarks/folder/xxx` のようなサブパスにマッチさせるには `https://x.com/i/bookmarks/*` と `/` を挟む方がより正確。現状のパターンでも `bookmarksxyz` のような偶発的マッチは起きにくいが、仕様上は修正が望ましい。

---

## 機能拡張の提案

### F-1: `chrome.storage.local` によるデータ永続化

現状はページリロードでデータが消失する。`chrome.storage.local` に収集済みデータを保存すれば、ブラウザを閉じても安全。（`storage` パーミッションは既に宣言済み。）

### F-2: 収集済み件数のバッジ表示

`chrome.action.setBadgeText()` を使って拡張アイコンに収集数を表示すれば、ポップアップを開かなくても進捗がわかる。background service worker の追加が必要。

### F-3: CSV/JSON エクスポート対応

TSV のみだと用途が限られる。JSON 出力を追加すればプログラムからの利用が容易になる。

### F-4: 「さらに表示」の展開

`long_text` タグがつくツイートの全文取得には、「さらに表示」リンクのクリックによる展開処理が必要。自動スクロール中にこれを組み込めば、より完全なテキストデータが得られる。

---

## まとめ

| カテゴリ | 件数 | 最高重要度 |
|----------|------|-----------|
| バグ     | 3    | 中        |
| セキュリティ | 2 | 高        |
| コード品質 | 5  | 低        |
| 機能提案 | 4    | —         |

**最優先で対応すべき項目:**

1. **S-1: XSS 対策** — `innerHTML` に挿入するユーザーデータを必ずエスケープする
2. **B-1: `setInterval`/`setTimeout` の競合** — `setTimeout` チェーンに置き換える
3. **B-3: 未使用の `storage` パーミッション** — 使わないなら削除する（使うなら F-1 を実装する）

全体として、目的に対して過不足のないシンプルで実用的な拡張です。上記の改善を施せば、より堅牢で安全なツールになるでしょう。
