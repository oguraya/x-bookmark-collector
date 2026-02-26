(() => {
  // Constants
  const SCROLL_INTERVAL_MS = 2500;
  const SCROLL_WAIT_MS = 1500;
  const SCROLL_RATIO = 0.8;
  const MAX_NO_CONTENT_COUNT = 3;
  const TEXT_PREVIEW_LENGTH = 200;

  // State
  let collectedUrls = new Map(); // url -> tweet data
  let isCollecting = false;
  let scrollInterval = null;
  let noNewContentCount = 0;

  // Persistence via chrome.storage.local
  function saveToStorage() {
    const data = Object.fromEntries(collectedUrls);
    chrome.storage.local.set({ collectedBookmarks: data }).catch(e =>
      console.debug('[X Bookmark Collector] storage save error:', e)
    );
  }

  async function loadFromStorage() {
    try {
      const result = await chrome.storage.local.get('collectedBookmarks');
      if (result.collectedBookmarks) {
        for (const [url, info] of Object.entries(result.collectedBookmarks)) {
          if (!collectedUrls.has(url)) {
            collectedUrls.set(url, info);
          }
        }
      }
    } catch (e) {
      console.debug('[X Bookmark Collector] storage load error:', e);
    }
  }

  // Extract media URLs from an article element (excluding quoted tweet area)
  function extractMediaUrls(article, quoteContainer) {
    const imageUrls = [];
    let hasVideo = false;

    if (!article) return { imageUrls, hasVideo };

    // Collect quote-area image srcs to exclude later
    const quoteImgSrcs = new Set();
    if (quoteContainer) {
      quoteContainer.querySelectorAll('img[src*="pbs.twimg.com/media"]').forEach(img => {
        quoteImgSrcs.add(img.src);
      });
    }

    // Images: pbs.twimg.com/media (skip those inside quote)
    article.querySelectorAll('img[src*="pbs.twimg.com/media"]').forEach(img => {
      if (quoteContainer && quoteContainer.contains(img)) return;
      let src = img.src;
      // Convert to original size
      try {
        const url = new URL(src);
        url.searchParams.set('name', 'orig');
        src = url.toString();
      } catch (e) { console.debug('[X Bookmark Collector] URL parse error:', e); }
      if (!imageUrls.includes(src)) {
        imageUrls.push(src);
      }
    });

    // Video / GIF detection (outside quote)
    const checkVideo = el => {
      if (quoteContainer && quoteContainer.contains(el)) return false;
      return true;
    };

    const videos = article.querySelectorAll('video');
    for (const v of videos) { if (checkVideo(v)) { hasVideo = true; break; } }

    if (!hasVideo) {
      const vc = article.querySelectorAll('[data-testid="videoComponent"], [data-testid="videoPlayer"]');
      for (const v of vc) { if (checkVideo(v)) { hasVideo = true; break; } }
    }

    // GIF badge
    if (!hasVideo) {
      const gifs = article.querySelectorAll('[aria-label="GIF"]');
      for (const g of gifs) { if (checkVideo(g)) { hasVideo = true; break; } }
    }

    return { imageUrls, hasVideo };
  }

  // Extract quoted tweet info
  function extractQuotedTweet(article) {
    const quoteContainer = article.querySelector('[data-testid="quoteTweet"]');
    if (!quoteContainer) return null;

    // Find the status link inside the quote
    const links = quoteContainer.querySelectorAll('a[href*="/status/"]');
    let quotedUrl = '';
    let quotedAuthor = '';

    for (const link of links) {
      const match = link.getAttribute('href')?.match(/^\/([^/]+)\/status\/(\d+)$/);
      if (match) {
        quotedUrl = `https://x.com${link.getAttribute('href')}`;
        quotedAuthor = match[1];
        break;
      }
    }

    // Quoted tweet text
    let quotedText = '';
    const quotedTextEl = quoteContainer.querySelector('[data-testid="tweetText"]');
    if (quotedTextEl) {
      quotedText = quotedTextEl.innerText?.substring(0, TEXT_PREVIEW_LENGTH) || '';
    }

    if (!quotedUrl) return null;
    return { quotedUrl, quotedAuthor, quotedText };
  }

  // Check for external links
  function hasExternalLinks(article) {
    if (!article) return false;
    if (article.querySelector('[data-testid="card.wrapper"]')) return true;

    const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
    if (tweetTextEl) {
      const links = tweetTextEl.querySelectorAll('a[href^="https://t.co/"]');
      if (links.length > 0) return true;
    }
    return false;
  }

  // Determine tags
  function determineTags(article, mediaInfo, hasQuote, extLinks) {
    const tags = [];

    if (mediaInfo.imageUrls.length > 0) tags.push('image');
    if (mediaInfo.hasVideo) tags.push('video');
    if (hasQuote) tags.push('quote');
    if (extLinks) tags.push('link');

    // Thread
    const text = article?.innerText || '';
    if (text.includes('このスレッドを表示') || text.includes('Show this thread')) {
      tags.push('thread');
    }

    // Long text
    if (article?.querySelector('[data-testid="tweet-text-show-more-link"]')) {
      tags.push('long_text');
    }

    if (tags.length === 0) tags.push('text_only');
    return tags;
  }

  // Main extraction
  function extractTweetUrls() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    let newCount = 0;

    articles.forEach(article => {
      // Find permalink via time element
      const timeEl = article.querySelector('time');
      const timeLink = timeEl?.closest('a[href*="/status/"]');
      if (!timeLink) return;

      const href = timeLink.getAttribute('href');
      const match = href?.match(/^\/([^/]+)\/status\/(\d+)$/);
      if (!match) return;

      const mainUrl = `https://x.com${href}`;
      if (collectedUrls.has(mainUrl)) return;

      const author = match[1];
      const time = timeEl?.getAttribute('datetime') || '';

      // Tweet text (exclude quoted tweet text)
      const quoteContainer = article.querySelector('[data-testid="quoteTweet"]');
      let text = '';
      const tweetTextEls = article.querySelectorAll('[data-testid="tweetText"]');
      for (const el of tweetTextEls) {
        if (quoteContainer && quoteContainer.contains(el)) continue;
        text = el.innerText?.substring(0, TEXT_PREVIEW_LENGTH) || '';
        break;
      }

      // Media (excluding quoted area)
      const mediaInfo = extractMediaUrls(article, quoteContainer);

      // Quoted tweet
      const quoted = extractQuotedTweet(article);

      // External links
      const extLinks = hasExternalLinks(article);

      // Tags
      const tags = determineTags(article, mediaInfo, !!quoted, extLinks);

      collectedUrls.set(mainUrl, {
        author,
        text,
        time,
        mediaUrls: mediaInfo.imageUrls.join(' '),
        hasVideo: mediaInfo.hasVideo,
        quotedUrl: quoted?.quotedUrl || '',
        quotedAuthor: quoted?.quotedAuthor || '',
        quotedText: quoted?.quotedText || '',
        tags: tags.join(',')
      });

      newCount++;
    });

    if (newCount > 0) saveToStorage();
    return newCount;
  }

  const clean = s => (s || '').replace(/[\t\n\r]/g, ' ');

  // Generate TSV
  function generateTsv() {
    const header = [
      'url', 'author', 'date', 'text',
      'media_urls', 'has_video',
      'quoted_url', 'quoted_author', 'quoted_text',
      'tags'
    ].join('\t');

    const rows = [];
    collectedUrls.forEach((info, url) => {
      rows.push([
        url,
        `@${info.author}`,
        info.time,
        clean(info.text),
        info.mediaUrls,
        info.hasVideo ? 'true' : 'false',
        info.quotedUrl,
        info.quotedAuthor ? `@${info.quotedAuthor}` : '',
        clean(info.quotedText),
        info.tags
      ].join('\t'));
    });

    return header + '\n' + rows.join('\n');
  }

  // Generate JSON
  function generateJson() {
    const items = [];
    collectedUrls.forEach((info, url) => {
      items.push({
        url,
        author: `@${info.author}`,
        date: info.time,
        text: info.text,
        media_urls: info.mediaUrls ? info.mediaUrls.split(' ') : [],
        has_video: info.hasVideo,
        quoted_url: info.quotedUrl || null,
        quoted_author: info.quotedAuthor ? `@${info.quotedAuthor}` : null,
        quoted_text: info.quotedText || null,
        tags: info.tags ? info.tags.split(',') : []
      });
    });
    return JSON.stringify(items, null, 2);
  }

  // Download JSON file
  function downloadJson() {
    if (collectedUrls.size === 0) return;
    const json = generateJson();
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `x_bookmarks_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Download TSV file
  function downloadTsv() {
    if (collectedUrls.size === 0) return;
    const tsv = generateTsv();
    const blob = new Blob(['\uFEFF' + tsv], { type: 'text/tab-separated-values;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `x_bookmarks_${new Date().toISOString().slice(0, 10)}.tsv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Expand "show more" links to get full tweet text
  function expandShowMoreLinks() {
    const links = document.querySelectorAll('[data-testid="tweet-text-show-more-link"]');
    let clicked = 0;
    links.forEach(link => {
      if (!link.dataset.xbcExpanded) {
        link.click();
        link.dataset.xbcExpanded = '1';
        clicked++;
      }
    });
    return clicked;
  }

  // Auto-scroll
  function autoScroll() {
    const prevHeight = document.documentElement.scrollHeight;
    window.scrollBy(0, window.innerHeight * SCROLL_RATIO);

    setTimeout(() => {
      // Expand "show more" before extracting
      const expanded = expandShowMoreLinks();
      const extractDelay = expanded > 0 ? 500 : 0;

      setTimeout(() => {
        const newFound = extractTweetUrls();
        const newHeight = document.documentElement.scrollHeight;

        sendStatus();

        if (newHeight === prevHeight && newFound === 0) {
          noNewContentCount++;
          if (noNewContentCount >= MAX_NO_CONTENT_COUNT) {
            stopCollecting();
            downloadTsv(); // Auto-download on complete
            sendMessage({ type: 'COLLECTION_COMPLETE', count: collectedUrls.size });
            return;
          }
        } else {
          noNewContentCount = 0;
        }

        // Schedule next scroll only if still collecting
        if (isCollecting) {
          scrollInterval = setTimeout(autoScroll, SCROLL_INTERVAL_MS);
        }
      }, extractDelay);
    }, SCROLL_WAIT_MS);
  }

  function startCollecting() {
    if (isCollecting) return;
    isCollecting = true;
    noNewContentCount = 0;

    extractTweetUrls();
    sendStatus();

    scrollInterval = setTimeout(autoScroll, SCROLL_INTERVAL_MS);
  }

  function stopCollecting() {
    isCollecting = false;
    if (scrollInterval) {
      clearTimeout(scrollInterval);
      scrollInterval = null;
    }
  }

  function sendStatus() {
    sendMessage({
      type: 'STATUS_UPDATE',
      count: collectedUrls.size,
      isCollecting
    });
  }

  function sendMessage(msg) {
    chrome.runtime.sendMessage(msg).catch(e => console.debug('[X Bookmark Collector] sendMessage error:', e));
  }

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'START_COLLECTING':
        startCollecting();
        sendResponse({ ok: true });
        break;
      case 'STOP_COLLECTING':
        stopCollecting();
        sendResponse({ ok: true });
        break;
      case 'GET_STATUS':
        sendResponse({
          count: collectedUrls.size,
          isCollecting,
          isBookmarkPage: location.pathname.includes('/i/bookmarks')
        });
        break;
      case 'GET_DATA':
        sendResponse({ data: [...collectedUrls.entries()].map(([url, info]) => ({ url, ...info })) });
        break;
      case 'DOWNLOAD_TSV':
        downloadTsv();
        sendResponse({ ok: true });
        break;
      case 'DOWNLOAD_JSON':
        downloadJson();
        sendResponse({ ok: true });
        break;
      case 'CLEAR_DATA':
        collectedUrls.clear();
        saveToStorage();
        sendResponse({ ok: true });
        break;
    }
    return true;
  });

  loadFromStorage().then(() => {
    extractTweetUrls();
    console.log('[X Bookmark Collector] Ready — restored', collectedUrls.size, 'items from storage');
  });
})();
