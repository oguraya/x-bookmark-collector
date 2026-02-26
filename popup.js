const $ = id => document.getElementById(id);

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

let currentTabId = null;

async function sendToContent(msg) {
  if (!currentTabId) return null;
  try {
    return await chrome.tabs.sendMessage(currentTabId, msg);
  } catch (e) {
    console.debug('[X Bookmark Collector] sendToContent error:', e);
    return null;
  }
}

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2000);
}

function updateUI(status) {
  $('count').textContent = status.count || 0;
  const collecting = status.isCollecting;
  $('btnStart').style.display = collecting ? 'none' : 'block';
  $('btnStop').style.display = collecting ? 'block' : 'none';
  $('indicator').classList.toggle('active', collecting);
}

// Show tag distribution summary
function updateTagSummary(data) {
  const tagCounts = {};
  data.forEach(item => {
    (item.tags || '').split(',').forEach(tag => {
      tag = tag.trim();
      if (tag) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    });
  });

  const summary = $('tagSummary');
  if (Object.keys(tagCounts).length === 0) {
    summary.innerHTML = '';
    return;
  }

  const sorted = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
  summary.innerHTML = sorted.map(([tag, count]) =>
    `<span class="tag-badge">${escapeHtml(tag)}: ${count}</span>`
  ).join('');
}

async function updatePreview() {
  const resp = await sendToContent({ type: 'GET_DATA' });
  if (!resp?.data) return;

  updateTagSummary(resp.data);

  const preview = $('preview');
  if (resp.data.length === 0) {
    preview.innerHTML = '<div style="color:#8b98a5;text-align:center;padding:8px;">まだデータがありません</div>';
    return;
  }

  const items = resp.data.slice(-15).reverse();
  preview.innerHTML = items.map(item => {
    const mediaIcon = item.mediaUrls ? '🖼' : '';
    const videoIcon = item.hasVideo ? '🎬' : '';
    const quoteIcon = item.quotedUrl ? '💬' : '';
    const textPreview = item.text ? ' — ' + escapeHtml(item.text.substring(0, 50)) + '...' : '';
    return `<div class="preview-item">
      <span class="url">${escapeHtml(item.url)}</span> ${mediaIcon}${videoIcon}${quoteIcon}<br>
      ${item.displayName ? escapeHtml(item.displayName) + ' ' : ''}@${escapeHtml(item.author)}${textPreview}
      <br><span class="tags">${escapeHtml(item.tags)}</span>
    </div>`;
  }).join('');
}

// Events
$('btnStart').addEventListener('click', async () => {
  $('completeMsg').style.display = 'none';
  await sendToContent({ type: 'START_COLLECTING' });
  updateUI({ isCollecting: true, count: parseInt($('count').textContent) });
});

$('btnStop').addEventListener('click', async () => {
  await sendToContent({ type: 'STOP_COLLECTING' });
  updateUI({ isCollecting: false, count: parseInt($('count').textContent) });
  updatePreview();
});

$('btnDownload').addEventListener('click', async () => {
  await sendToContent({ type: 'DOWNLOAD_TSV' });
  toast('TSVをダウンロードしました');
});

$('btnDownloadJson').addEventListener('click', async () => {
  await sendToContent({ type: 'DOWNLOAD_JSON' });
  toast('JSONをダウンロードしました');
});

$('btnClear').addEventListener('click', async () => {
  await sendToContent({ type: 'CLEAR_DATA' });
  updateUI({ isCollecting: false, count: 0 });
  $('tagSummary').innerHTML = '';
  $('completeMsg').style.display = 'none';
  updatePreview();
  toast('クリアしました');
});

// Listen for updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_UPDATE') {
    updateUI(msg);
    updatePreview();
  }
  if (msg.type === 'COLLECTION_COMPLETE') {
    updateUI({ isCollecting: false, count: msg.count });
    $('completeMsg').style.display = 'block';
    updatePreview();
  }
});

// Init
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  currentTabId = tab.id;

  const isBookmarkPage = tab.url?.includes('/i/bookmarks');
  $('notOnPage').style.display = isBookmarkPage ? 'none' : 'block';
  $('mainUI').style.display = isBookmarkPage ? 'block' : 'none';

  if (isBookmarkPage) {
    const status = await sendToContent({ type: 'GET_STATUS' });
    if (status) {
      updateUI(status);
      updatePreview();
    }
  }
})();
