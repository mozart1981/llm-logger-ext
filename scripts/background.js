console.log('🔧 background worker boot');

const MAX_BATCH_SIZE = 10; // Increased batch size to handle more events
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
  console.log('🔌 Connecting to ML pipe...');

  port = chrome.runtime.connect({ name: 'mlPipe' });
  console.log('✅ ML pipe connected');

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
  console.log('🌐 Tab updated:', tab.url);
  handleEvent({
    type: 'tabNavigate',
    url: tab.url,
    title: tab.title,
    ts: Date.now(),
  });
});

// Listen for content script events
chrome.runtime.onMessage.addListener(async (msg, sender) => {
  console.log('📨 Received message:', msg.kind, 'from tab:', sender.tab?.id);
  
  if (msg.kind === 'evt') {
    handleEvent({
      ...msg,
      tabId: sender.tab.id,
      url: sender.tab.url
    });
  } else if (msg.kind === 'screenshot') {
    try {
      console.log('📸 Taking screenshot for tab:', sender.tab.id);
      // Take screenshot of the tab that sent the message
      const screenshot = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
      
      // Remove the data:image/png;base64, prefix
      const imgBase64 = screenshot.split(',')[1];
      
      // Create an event with the screenshot
      handleEvent({
        type: 'screenshot',
        trigger: msg.trigger,
        timestamp: msg.timestamp,
        imgBase64,
        tabId: sender.tab.id,
        url: sender.tab.url
      });
      console.log('✅ Screenshot captured and processed');
    } catch (error) {
      console.error('Failed to capture screenshot:', error);
    }
  }
  
  // Required for async message handling
  return true;
});

async function handleEvent(evt) {
  console.log('🎯 Processing event:', evt.type, evt.label || '');

  if (!evt.label && evt.imgBase64) {
    console.log('🖼️ Getting VLM description for image...');
    evt.label = await describeWithVLM(evt);
  }

  queue.push(evt);
  console.log('📦 Queue size:', queue.length);

  // Save events more frequently with periodic screenshots
  if (queue.length >= MAX_BATCH_SIZE || evt.type === 'screenshot') {
    console.log(`🔄 Processing batch of ${queue.length} events...`);
    const summary = await summariseBatch(queue);
    console.log('📝 Summary saved to storage:', summary);

    // Store both summary and raw events
    await chrome.storage.local.set({ 
      log: summary,
      events: queue.map(e => ({
        ...e,
        imgBase64: null // Don't store images in local storage
      }))
    });

    queue = [];
    console.log('🧹 Queue cleared');
  }
}

async function describeWithVLM(evt) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    console.log('🔍 Requesting VLM description:', id);

    // Extract relevant event context
    const eventContext = {
      type: evt.type,
      label: evt.label,
      path: evt.path,
      elementType: evt.elementType,
      elementState: evt.elementState,
      description: evt.description,
      inputDetails: evt.inputDetails,
      rect: evt.rect,
      timestamp: evt.timestamp || evt.ts,
      url: evt.url,
      tabId: evt.tabId
    };

    port.postMessage({
      cmd: 'describe',
      id,
      imgBase64: evt.imgBase64,
      eventContext: eventContext
    });

    port.onMessage.addListener(function listener(msg) {
      if (msg.id === id && msg.description) {
        console.log('✅ Got VLM description:', id);
        port.onMessage.removeListener(listener);
        resolve(msg.description);
      }
    });
  });
}

async function summariseBatch(events) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    console.log('📊 Requesting batch summary:', id);

    port.postMessage({
      cmd: 'summarise',
      id,
      events,
    });

    port.onMessage.addListener(function listener(msg) {
      if (msg.id === id && msg.summary) {
        console.log('✅ Got batch summary:', id);
        port.onMessage.removeListener(listener);
        resolve(msg.summary);
      }
    });
  });
}
