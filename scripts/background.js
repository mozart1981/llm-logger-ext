console.log('🔧 background worker boot');

const MAX_BATCH_SIZE = 5;
let queue = [];
let port = null;

// Ensure the offscreen document is active
async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument();
  if (!exists) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_SCRAPING'],
      justification: 'Need offscreen context for ML workers',
    });
    console.log('✅ Offscreen document created');
  }
}

// Connect to the offscreen controller
async function connectToMLPipe() {
  await ensureOffscreen();

  port = chrome.runtime.connect({ name: 'mlPipe' });

  port.onDisconnect.addListener(() => {
    console.warn('⚠ mlPipe disconnected, reconnecting...');
    port = null;
    connectToMLPipe();
  });

  port.onMessage.addListener((msg) => {
    if (msg.description) {
      console.log('📸 [VLM DESCRIPTION]', msg.description);
    }
    if (msg.summary) {
      console.log('📝 [FINAL SUMMARY]', msg.summary);
    }
  });
}

connectToMLPipe();

// Listen for tab navigations
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  handleEvent({
    type: 'tabNavigate',
    url: tab.url,
    title: tab.title,
    ts: Date.now(),
  });
});

// Listen for content script events
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.kind === 'evt') {
    handleEvent(msg);
  }
});

async function handleEvent(evt) {
  console.log('[BG] got', evt.type, evt.label || '');

  if (!evt.label && evt.imgBase64) {
    evt.label = await describeWithVLM(evt);
  }

  queue.push(evt);

  if (queue.length >= MAX_BATCH_SIZE) {
    console.log(`[BG] Batch size reached (${queue.length}), summarizing...`);
    const summary = await summariseBatch(queue);
    console.log('📝 Summary saved to storage:', summary);

    await chrome.storage.local.set({ log: summary });

    queue = [];
  }
}

async function describeWithVLM(evt) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();

    port.postMessage({
      cmd: 'describe',
      id,
      imgBase64: evt.imgBase64,
    });

    port.onMessage.addListener(function listener(msg) {
      if (msg.id === id && msg.description) {
        port.onMessage.removeListener(listener);
        resolve(msg.description);
      }
    });
  });
}

async function summariseBatch(events) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();

    port.postMessage({
      cmd: 'summarise',
      id,
      events,
    });

    port.onMessage.addListener(function listener(msg) {
      if (msg.id === id && msg.summary) {
        port.onMessage.removeListener(listener);
        resolve(msg.summary);
      }
    });
  });
}
