// capture curated events, attach rect + tabId, send to background
console.log('🔄 Content script loaded and initializing...');

const KEEP = new Set([
  'click',      // for button clicks and link navigation
  'input',      // for form inputs
  'change',     // for form field changes
  'submit',     // for form submissions
  'navigation', // for page navigation
  'select',     // for dropdown selections
  'focus',      // when elements receive focus
  'blur',       // when elements lose focus
  'mousedown',  // for drag operations start
  'mouseup',    // for drag operations end
  'keydown',    // for keyboard interactions
  'keyup'       // for keyboard interactions
]);

// Screenshot batching configuration
const BATCH_SIZE = 10;
const SCREENSHOT_INTERVAL = 1000; // Take a screenshot every second
let screenshotInterval = null;
let screenshotBatch = [];
let lastScreenshotTime = Date.now();

// Screenshot control
const MIN_SCREENSHOT_INTERVAL = 2000; // Minimum 2 seconds between screenshots
let lastDOMHash = '';
let screenshotTimeout = null;

// Calculate a simple hash of the page's main content
function getPageContentHash() {
  // Get the main content, excluding highly dynamic elements
  const content = document.body.innerHTML
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove scripts
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')   // Remove styles
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
  
  // Simple hash function
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString();
}

// Check if enough time has passed since last screenshot
function canTakeScreenshot() {
  const now = Date.now();
  return (now - lastScreenshotTime) >= MIN_SCREENSHOT_INTERVAL;
}

// Take screenshot if content has changed and enough time has passed
function checkAndTakeScreenshot(reason = 'content_change') {
  if (screenshotTimeout) {
    clearTimeout(screenshotTimeout);
    screenshotTimeout = null;
  }

  screenshotTimeout = setTimeout(() => {
    const currentHash = getPageContentHash();
    if (currentHash !== lastDOMHash && canTakeScreenshot()) {
      captureScreenshot(reason);
      lastDOMHash = currentHash;
      lastScreenshotTime = Date.now();
    }
  }, 500); // Debounce DOM changes
}

// Initialize DOM observation
function startDOMObservation() {
  // Initial content hash
  lastDOMHash = getPageContentHash();
  
  // Watch for DOM changes
  const observer = new MutationObserver((mutations) => {
    // Filter out minor text changes and attribute updates
    const significantChanges = mutations.some(mutation => {
      // Added or removed nodes
      if (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0) {
        return true;
      }
      
      // Changed attributes that affect layout
      if (mutation.type === 'attributes') {
        const attr = mutation.attributeName;
        return ['style', 'class', 'hidden', 'display'].includes(attr);
      }
      
      return false;
    });

    if (significantChanges) {
      checkAndTakeScreenshot();
    }
  });

  // Observe everything except attributes that change frequently
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden', 'display'],
    characterData: false
  });
}

// Enhanced DOM path capture
function domPath(el) {
  const parts = [];
  while (el && parts.length < 6 && el.nodeType === 1) {
    let part = el.nodeName.toLowerCase();
    
    // Capture all relevant attributes that help identify the element
    const identifyingAttrs = [
      'id',
      'name',
      'role',
      'type',
      'aria-label',
      'data-testid',
      'data-id',
      'data-type',
      'href',
      'value',
      'placeholder'
    ];
    
    // Add any custom data attributes
    const dataAttrs = Array.from(el.attributes)
      .filter(attr => attr.name.startsWith('data-'))
      .map(attr => attr.name);
    
    const allAttrs = [...new Set([...identifyingAttrs, ...dataAttrs])];
    
    // Build attribute string
    const attrs = allAttrs
      .filter(attr => el.getAttribute(attr))
      .map(attr => `${attr}="${el.getAttribute(attr)}"`)
      .join('][');
    
    if (attrs) part += `[${attrs}]`;
    
    // Add classes (limited to 3 most specific ones)
    if (el.className) {
      const classes = Array.from(el.classList)
        .filter(c => !c.includes('_')) // Skip generated/utility classes
        .slice(0, 3)
        .join('.');
      if (classes) part += '.' + classes;
    }
    
    parts.unshift(part);
    el = el.parentNode;
  }
  return parts.join(' > ');
}

// Enhanced element state capture
function getElementState(el) {
  const state = [];
  
  // Interactive states
  if (el.disabled) state.push('disabled');
  if (el.readOnly) state.push('readonly');
  if (el.checked) state.push('checked');
  if (el.required) state.push('required');
  if (el.multiple) state.push('multiple');
  if (document.activeElement === el) state.push('focused');
  
  // ARIA states
  const ariaStates = [
    'expanded',
    'selected',
    'pressed',
    'invalid',
    'hidden',
    'current',
    'busy'
  ];
  
  ariaStates.forEach(ariaState => {
    const value = el.getAttribute(`aria-${ariaState}`);
    if (value === 'true') state.push(ariaState);
  });
  
  // Visual states
  const style = window.getComputedStyle(el);
  if (style.display === 'none') state.push('hidden');
  if (style.visibility === 'hidden') state.push('invisible');
  if (parseFloat(style.opacity) === 0) state.push('transparent');
  
  // Position states
  const rect = el.getBoundingClientRect();
  const viewport = {
    top: 0,
    left: 0,
    bottom: window.innerHeight,
    right: window.innerWidth
  };
  
  if (rect.top > viewport.bottom) state.push('below-viewport');
  if (rect.bottom < viewport.top) state.push('above-viewport');
  if (rect.left > viewport.right) state.push('right-of-viewport');
  if (rect.right < viewport.left) state.push('left-of-viewport');
  
  return state;
}

// Track input debouncing
let inputDebounceTimer = null;
let lastInputValue = new Map(); // Track last value for change detection

// Enhanced context capture
function getEventContext(target, type) {
  const context = {
    url: window.location.href,
    pageTitle: document.title,
    timestamp: Date.now(),
    type: type,
    frameId: window.frameElement ? window.frameElement.id : 'main'
  };

  if (type === 'navigation') {
    context.description = `Navigated to ${document.title} (${window.location.href})`;
    return context;
  }

  if (target) {
    // Get element details
    context.elementType = target.tagName.toLowerCase();
    context.path = domPath(target);
    context.state = getElementState(target);
    
    // Get text content
    let textContent = target.textContent?.trim();
    if (textContent && textContent.length > 100) {
      textContent = textContent.slice(0, 100) + '...';
    }
    
    // Build identifier from available attributes
    context.identifier = (
      target.getAttribute('aria-label') ||
      target.getAttribute('title') ||
      target.getAttribute('alt') ||
      target.getAttribute('name') ||
      target.getAttribute('placeholder') ||
      target.value ||
      textContent ||
      target.id ||
      ''
    ).trim();

    // Get parent context
    const parentSelectors = [
      '[role]',
      'form',
      'section',
      'article',
      'nav',
      'header',
      'footer',
      'main',
      'aside',
      'dialog',
      '.modal',
      '[class*="container"]',
      '[class*="wrapper"]',
      'table',
      'fieldset'
    ];
    
    const parentContext = target.closest(parentSelectors.join(','));
    if (parentContext) {
      context.parentContext = {
        type: parentContext.tagName.toLowerCase(),
        role: parentContext.getAttribute('role'),
        identifier: (
          parentContext.getAttribute('aria-label') ||
          parentContext.getAttribute('title') ||
          parentContext.id ||
          parentContext.className
        )
      };
    }

    // Add interaction details based on element type
    switch(context.elementType) {
      case 'a':
        context.description = `Clicked link "${context.identifier}"${target.href ? ` leading to ${target.href}` : ''}`;
        context.href = target.href;
        break;
        
      case 'button':
      case 'input':
        if (target.type === 'submit' || target.type === 'button') {
          context.description = `Clicked button "${context.identifier}"`;
        } else {
          const fieldValue = getFormFieldValue(target);
          context.fieldValue = fieldValue;
          context.description = `Interacted with ${fieldValue.type} field "${context.identifier}"`;
        }
        break;
        
      case 'select':
        const fieldValue = getFormFieldValue(target);
        context.fieldValue = fieldValue;
        context.description = `Selected "${fieldValue.value}" from dropdown "${context.identifier}"`;
        break;
        
      default:
        context.description = `${type} on ${context.elementType}${context.identifier ? ` "${context.identifier}"` : ''}`;
    }

    // Add form context if within a form
    const form = target.closest('form');
    if (form) {
      context.form = {
        id: form.id,
        name: form.getAttribute('name'),
        action: form.action,
        method: form.method
      };
    }
  }

  return context;
}

// Get form field value in a simple way
function getFormFieldValue(el) {
  if (!el || !el.tagName) return null;
  
  const type = el.type || el.tagName.toLowerCase();
  const details = {
    type,
    name: el.name || '',
    id: el.id || ''
  };

  // Handle password fields specially
  if (type === 'password') {
    details.value = '*'.repeat(el.value.length);
  } else if (type === 'checkbox' || type === 'radio') {
    details.checked = el.checked;
  } else if (el.value !== undefined) {
    details.value = el.value;
  }

  return details;
}

// Start collecting screenshots
function startScreenshotCapture() {
  if (screenshotInterval) return;
  
  console.log('📸 Starting batched screenshot capture');
  screenshotInterval = setInterval(async () => {
    if (document.hidden) return; // Don't capture when tab is hidden
    
    const now = Date.now();
    // Ensure at least 1 second between screenshots
    if (now - lastScreenshotTime < SCREENSHOT_INTERVAL) return;
    
    await captureScreenshot('periodic');
    lastScreenshotTime = now;
    
    // If we've collected enough screenshots, send the batch for analysis
    if (screenshotBatch.length >= BATCH_SIZE) {
      await processBatch();
    }
  }, SCREENSHOT_INTERVAL);
}

function stopScreenshotCapture() {
  if (screenshotInterval) {
    console.log('⏹️ Stopping screenshot capture');
    clearInterval(screenshotInterval);
    screenshotInterval = null;
  }
}

// Process a batch of screenshots with VLM
async function processBatch() {
  if (screenshotBatch.length === 0) return;
  
  console.log(`🔄 Processing batch of ${screenshotBatch.length} screenshots`);
  
  try {
    // Send batch to background script for VLM processing
    await chrome.runtime.sendMessage({
      kind: 'process_batch',
      screenshots: screenshotBatch,
      metadata: {
        url: window.location.href,
        title: document.title,
        timestamp: Date.now()
      }
    });
    
    // Clear the batch after successful processing
    screenshotBatch = [];
  } catch (error) {
    console.error('Failed to process screenshot batch:', error);
  }
}

// Capture and store screenshot in batch
async function captureScreenshot(trigger) {
  try {
    console.log('📸 Taking screenshot, trigger:', trigger);
    
    // Request screenshot from background script
    const response = await chrome.runtime.sendMessage({
      kind: 'screenshot',
      trigger,
      timestamp: Date.now()
    });
    
    if (response && response.screenshot) {
      screenshotBatch.push({
        screenshot: response.screenshot,
        timestamp: Date.now(),
        trigger: trigger
      });
    }
  } catch (error) {
    console.error('Screenshot capture failed:', error);
  }
}

// Main event handler
async function handler(e) {
  console.log('🎯 Event captured:', e.type);
  
  if (!KEEP.has(e.type)) {
    console.log('❌ Event type not in KEEP set:', e.type);
    return;
  }

  const target = e.target;
  const context = getEventContext(target, e.type);
  console.log('📦 Event context:', context);
  
  // Send event to background script
  console.log('📤 Sending event to background:', context);
  chrome.runtime.sendMessage({
    kind: 'evt',
    ...context
  }).catch((error) => {
    console.error('Failed to send event to background:', error);
  });
}

// Add listeners for all events we want to track
console.log('📡 Setting up event listeners for:', Array.from(KEEP));
KEEP.forEach(eventType => {
  document.addEventListener(eventType, handler, { capture: true, passive: true });
});
console.log('✅ Event listeners attached');

// Start screenshot capture when page is ready
if (document.readyState === 'complete') {
  startScreenshotCapture();
} else {
  window.addEventListener('load', startScreenshotCapture);
}

// Handle visibility changes
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Process any remaining screenshots before stopping
    if (screenshotBatch.length > 0) {
      processBatch();
    }
    stopScreenshotCapture();
  } else {
    startScreenshotCapture();
  }
});

// Track URL changes
let lastUrl = window.location.href;
console.log('🌐 Starting navigation tracking from:', lastUrl);

new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    console.log('🔄 URL changed from', lastUrl, 'to', window.location.href);
    // Process any remaining screenshots before navigation
    if (screenshotBatch.length > 0) {
      processBatch();
    }
    lastUrl = window.location.href;
    handler({ type: 'navigation', target: document.body });
  }
}).observe(document, { subtree: true, childList: true });

console.log('🎉 Content script initialization complete');
