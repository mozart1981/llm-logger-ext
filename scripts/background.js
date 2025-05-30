console.log('🔧 background worker boot');

const MAX_BATCH_SIZE = 10;
let queue = [];
let port = null;

// Track workflow state
let currentWorkflow = {
  type: null,
  target: null,
  steps: [],
  startTime: null,
  lastEventTime: null
};

// Workflow classification patterns
const WORKFLOW_PATTERNS = {
  FIELD_UPDATE: {
    name: 'Field Update',
    startTriggers: ['select', 'click'],  // select for dropdowns, click for other fields
    endTriggers: ['change'],
    targetTypes: ['select', 'input', 'textarea']
  },
  FORM_SUBMISSION: {
    name: 'Form Submission',
    startTriggers: ['change'],
    endTriggers: ['submit'],
    targetTypes: ['form']
  },
  NAVIGATION: {
    name: 'Navigation',
    startTriggers: ['click'],
    endTriggers: ['navigation'],
    targetTypes: ['a', 'button']
  }
};

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
    // Only show the final summary from the summarizer, not VLM descriptions
    if (msg.summary) {
      console.log('📝 [FINAL SUMMARY]', msg.summary);
    }
  });
}

connectToMLPipe();

// Detect workflow transitions
function updateWorkflow(evt) {
  const now = Date.now();
  
  // Check if this event starts a new workflow
  for (const [type, pattern] of Object.entries(WORKFLOW_PATTERNS)) {
    if (pattern.startTriggers.includes(evt.type) && 
        pattern.targetTypes.includes(evt.elementType)) {
      
      // If we have an existing workflow that's too old, finish it
      if (currentWorkflow.type && 
          (now - currentWorkflow.lastEventTime > 5000)) { // 5 second timeout
        finishWorkflow();
      }
      
      // Start new workflow if we don't have one
      if (!currentWorkflow.type) {
        currentWorkflow = {
          type,
          target: evt.fieldDetails?.fieldLabel || evt.identifier,
          steps: [],
          startTime: now,
          lastEventTime: now
        };
      }
    }
  }
  
  // Add step to current workflow if we have one
  if (currentWorkflow.type) {
    const stepDetails = {
      action: evt.description || evt.type,
      timestamp: now,
      details: {
        type: evt.type,
        elementType: evt.elementType,
        fieldDetails: evt.fieldDetails,
        actionType: evt.actionType,
        // Add field change details if available
        fieldChange: evt.fieldChange ? {
          field: evt.fieldChange.field,
          from: evt.fieldChange.from,
          to: evt.fieldChange.to,
          options: evt.fieldChange.options
        } : null,
        // Add form data if available
        formData: evt.formData
      }
    };

    currentWorkflow.steps.push(stepDetails);
    currentWorkflow.lastEventTime = now;
    
    // Check if this event ends the workflow
    const pattern = WORKFLOW_PATTERNS[currentWorkflow.type];
    if (pattern.endTriggers.includes(evt.type)) {
      finishWorkflow();
    }
  }
}

// Finish current workflow and add to queue
function finishWorkflow() {
  if (currentWorkflow.type && currentWorkflow.steps.length > 0) {
    // Extract field changes for the summary
    const fieldChanges = currentWorkflow.steps
      .filter(step => step.details.fieldChange)
      .map(step => step.details.fieldChange);
    
    queue.push({
      type: 'workflow',
      workflowType: currentWorkflow.type,
      target: currentWorkflow.target,
      steps: currentWorkflow.steps,
      startTime: currentWorkflow.startTime,
      endTime: currentWorkflow.lastEventTime,
      duration: currentWorkflow.lastEventTime - currentWorkflow.startTime,
      fieldChanges // Add field changes to the workflow summary
    });
    
    // Reset workflow
    currentWorkflow = {
      type: null,
      target: null,
      steps: [],
      startTime: null,
      lastEventTime: null
    };
  }
}

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
    await handleEvent({
      ...msg,
      tabId: sender.tab.id,
      url: sender.tab.url
    });
  } else if (msg.kind === 'screenshot') {
    try {
      console.log('📸 Taking screenshot for tab:', sender.tab.id);
      
      // Get the current active tab in the window
      const tabs = await chrome.tabs.query({ 
        active: true, 
        windowId: sender.tab.windowId 
      });
      
      // Only take screenshot if the sender tab is the active tab
      if (tabs[0]?.id !== sender.tab.id) {
        console.log('⏭️ Skipping screenshot - tab not active');
        return { skipped: true };
      }
      
      const screenshot = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
      const imgBase64 = screenshot.split(',')[1];
      
      // Add screenshot event to queue
      await handleEvent({
        type: 'screenshot',
        imgBase64,
        timestamp: Date.now(),
        tabId: sender.tab.id,
        url: sender.tab.url
      });
      
      return { screenshot: imgBase64 };
    } catch (error) {
      console.error('Failed to capture screenshot:', error);
      return { error: error.message };
    }
  } else if (msg.kind === 'process_batch') {
    try {
      console.log('🔄 Processing batch of screenshots:', msg.screenshots.length);
      
      // Process each screenshot with VLM
      const descriptions = [];
      for (const screenshot of msg.screenshots) {
        const description = await describeWithVLM({
          type: 'screenshot',
          imgBase64: screenshot,
          ...msg.metadata
        });
        descriptions.push(description);
      }
      
      // Generate a summary of the batch
      const summary = await summariseBatch(descriptions.map((desc, i) => ({
        type: 'screenshot',
        description: desc,
        timestamp: msg.metadata.triggers[i].timestamp,
        trigger: msg.metadata.triggers[i].trigger,
        url: msg.metadata.url
      })));
      
      // Store the summary
      await chrome.storage.local.set({
        log: summary,
        lastBatch: {
          timestamp: Date.now(),
          url: msg.metadata.url,
          descriptions
        }
      });
      
      return { success: true };
    } catch (error) {
      console.error('Failed to process screenshot batch:', error);
      return { error: error.message };
    }
  }
  
  // Required for async message handling
  return true;
});

async function handleEvent(evt) {
  console.log('🎯 Processing event:', evt.type, evt.actionType || '');

  // Add meaningful context based on action type
  if (evt.actionType) {
    switch (evt.actionType) {
      case 'field_change':
        evt.label = `Changed ${evt.fieldChange.field} from "${evt.fieldChange.from}" to "${evt.fieldChange.to}"`;
        break;
      case 'checkbox_change':
      case 'radio_selection':
      case 'button_click':
      case 'field_input':
        evt.label = evt.description;
        break;
      default:
        if (evt.description) {
          evt.label = evt.description;
        }
    }
  }

  // Update workflow state
  updateWorkflow(evt);

  // Add event to queue
  queue.push(evt);

  // Check if we should process the batch
  if (queue.length >= MAX_BATCH_SIZE || evt.type === 'screenshot') {
    // Finish any ongoing workflow
    finishWorkflow();
    
    console.log(`🔄 Processing batch of ${queue.length} events...`);
    const summary = await summariseBatch(queue);
    console.log('📝 Generated summary:', summary);

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
    
    port.postMessage({
      cmd: 'describe',
      id,
      imgBase64: evt.imgBase64,
      eventContext: {
        type: evt.type,
        timestamp: evt.timestamp,
        url: evt.url,
        actionType: evt.actionType,
        fieldDetails: evt.fieldDetails,
        description: evt.description
      }
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
    console.log('📊 Preparing batch summary for', events.length, 'events');
    
    // Group events by workflow
    const workflows = events.filter(e => e.type === 'workflow');
    const otherEvents = events.filter(e => e.type !== 'workflow');
    
    // Enhance events with workflow context
    const enhancedEvents = {
      workflows: workflows.map(w => ({
        type: WORKFLOW_PATTERNS[w.workflowType]?.name || w.workflowType,
        target: w.target,
        duration: w.duration,
        steps: w.steps.map(s => ({
          action: s.action,
          details: s.details
        }))
      })),
      otherEvents: otherEvents.map(evt => ({
        contextualDescription: evt.description || evt.label,
        actionType: evt.actionType || 'interaction',
        fieldDetails: evt.fieldDetails || null,
        timestamp: evt.timestamp || evt.ts
      }))
    };

    console.log('📤 Sending to summarizer:', enhancedEvents);
    port.postMessage({
      cmd: 'summarise',
      id,
      events: enhancedEvents,
    });

    port.onMessage.addListener(function listener(msg) {
      if (msg.id === id && msg.summary) {
        console.log('📥 Received summary from worker');
        port.onMessage.removeListener(listener);
        resolve(msg.summary);
      }
    });
  });
}
