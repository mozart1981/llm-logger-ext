// capture curated events, attach rect + tabId, send to background
const KEEP = new Set(['click','input','change','keydown','copy','cut','paste']);

function labelFromDom(el) {
  return (
    el?.innerText || el?.ariaLabel || el?.alt ||
    el?.title || el?.name || ''
  ).trim().slice(0,80);
}

function domPath(el) {
  const parts = [];
  while (el && parts.length < 4 && el.nodeType === 1) {
    let part = el.nodeName;
    if (el.id) part += '#'+el.id;
    else if (el.className) part += '.'+el.className.split(/\s/)[0];
    parts.unshift(part);
    el = el.parentNode;
  }
  return parts.join('>');
}

async function getTabId() {
  return new Promise(res => {
    chrome.runtime.sendMessage({ cmd:'getTabId' }, res);
  });
}

document.addEventListener('*', () => {}, { capture:true }); // keeps Service Worker alive

document.addEventListener('click', handler, { capture:true, passive:true });
document.addEventListener('keydown', handler, { capture:true, passive:true });
document.addEventListener('input', handler, { capture:true, passive:true });

async function handler(e) {
  if (!KEEP.has(e.type)) return;

  const rect = e.target.getBoundingClientRect();
  const msg = {
    kind:'evt',
    type:e.type,
    label: labelFromDom(e.target) || '',
    rect: { x:rect.x, y:rect.y, width:rect.width, height:rect.height },
    path: domPath(e.target),
    ts: Date.now(),
    tabId: await getTabId()
  };

  chrome.runtime.sendMessage(msg).catch(()=>{});
}
