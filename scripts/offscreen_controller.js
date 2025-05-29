console.log('offscreen controller boot');

const vlmWorker = new Worker(chrome.runtime.getURL('scripts/vlm_worker.js'), {
  type: 'module',
});
const sumWorker = new Worker(chrome.runtime.getURL('scripts/summarizer_worker.js'), {
  type: 'module',
});

const pending = new Map();

function routeResponse(workerName, { data }) {
  const entry = pending.get(data.id);
  if (!entry) {
    console.warn(`⚠ No pending entry for id ${data.id}`);
    return;
  }

  if (workerName === 'vlm' && data.description) {
    console.log('📸 [VLM DESCRIPTION]', data.description);
  } else if (workerName === 'sum' && data.summary) {
    console.log('📝 [SUMMARY]', data.summary);
  } else {
    console.log(`[${workerName.toUpperCase()} RESPONSE]`, data);
  }

  entry.port.postMessage(data);
  pending.delete(data.id);
}

vlmWorker.onmessage = (msg) => routeResponse('vlm', msg);
sumWorker.onmessage = (msg) => routeResponse('sum', msg);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'mlPipe') return;

  console.log('mlPipe connected');

  port.onMessage.addListener((msg) => {
    if (msg.cmd === 'describe') {
      pending.set(msg.id, { port });
      vlmWorker.postMessage(msg);
    } else if (msg.cmd === 'summarise') {
      pending.set(msg.id, { port });
      sumWorker.postMessage(msg);
    }
  });

  port.onDisconnect.addListener(() => {
    console.log('mlPipe disconnected');
  });
});