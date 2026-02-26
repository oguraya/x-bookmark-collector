// Badge display for collected bookmark count
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_UPDATE' || msg.type === 'COLLECTION_COMPLETE') {
    const count = msg.count || 0;
    const text = count > 0 ? String(count) : '';
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: '#1d9bf0' });
  }
});
