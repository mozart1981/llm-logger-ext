// capture curated events, attach rect + tabId, send to background
console.log('🔄 Content script loaded and initializing...');

const KEEP = new Set([
  'click',      // for button clicks and link navigation
  'change',     // for form field changes (including dropdowns)
  'select',     // for dropdown menu interactions
  'submit',     // for form submissions
  'navigation'  // for page navigation
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

// Get form field value in a smart way
function getFormFieldValue(el) {
  if (!el || !el.tagName) return null;
  
  const type = el.type || el.tagName.toLowerCase();
  const details = {
    type,
    name: el.name || '',
    id: el.id || '',
    fieldLabel: el.getAttribute('aria-label') || 
                el.getAttribute('placeholder') || 
                findFieldLabel(el) ||
                el.name ||
                el.id ||
                type,
    rawValue: el.value // Store raw value for comparison
  };

  // Handle different input types
  switch(type) {
    case 'select-one':
    case 'select-multiple':
      details.value = Array.from(el.selectedOptions).map(opt => opt.text).join(', ');
      details.selectedValue = el.value;
      details.allOptions = Array.from(el.options).map(opt => ({
        text: opt.text,
        value: opt.value,
        selected: opt.selected
      }));
      details.fieldType = 'dropdown';
      break;
      
    case 'password':
      details.value = '*'.repeat(el.value.length);
      details.fieldType = 'password';
      break;
      
    case 'checkbox':
    case 'radio':
      details.checked = el.checked;
      details.value = el.value;
      details.fieldType = type;
      // Get all related options for radio buttons
      if (type === 'radio' && el.name) {
        const radioGroup = document.querySelectorAll(`input[type="radio"][name="${el.name}"]`);
        details.allOptions = Array.from(radioGroup).map(radio => ({
          text: findFieldLabel(radio) || radio.value,
          value: radio.value,
          selected: radio.checked
        }));
      }
      break;
      
    default:
      details.value = el.value;
      details.fieldType = 'text';
      if (el.maxLength > 0) {
        details.maxLength = el.maxLength;
      }
      // Add any data validation attributes
      const validationAttrs = ['min', 'max', 'pattern', 'required', 'minlength', 'maxlength'];
      details.validation = {};
      validationAttrs.forEach(attr => {
        if (el.hasAttribute(attr)) {
          details.validation[attr] = el.getAttribute(attr);
        }
      });
  }

  return details;
}

// Helper to find associated label text
function findFieldLabel(el) {
  // Check for explicit label
  if (el.id) {
    const label = document.querySelector(`label[for="${el.id}"]`);
    if (label) return label.textContent.trim();
  }
  
  // Check for wrapping label
  const wrapper = el.closest('label');
  if (wrapper) {
    const labelText = wrapper.textContent.trim();
    // Remove the field's own value from the label if it's there
    return labelText.replace(el.value || '', '').trim();
  }
  
  // Check for preceding label-like elements
  const previousEl = el.previousElementSibling;
  if (previousEl && (
      previousEl.tagName === 'LABEL' ||
      previousEl.classList.contains('label') ||
      previousEl.classList.contains('field-label')
    )) {
    return previousEl.textContent.trim();
  }
  
  return '';
}

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
    
    // Get field details if it's a form element
    if (target.tagName === 'SELECT' || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      const fieldDetails = getFormFieldValue(target);
      context.fieldDetails = fieldDetails;
      
      // Create meaningful descriptions based on field type and event
      switch(fieldDetails.fieldType) {
        case 'dropdown':
          if (type === 'select') {
            context.description = `Opened ${fieldDetails.fieldLabel} menu (current: "${fieldDetails.value}")`;
            context.actionType = 'dropdown_open';
          } else if (type === 'change') {
            const previousValue = target.dataset.previousValue || '';
            context.description = `Changed ${fieldDetails.fieldLabel} to "${fieldDetails.value}"`;
            context.actionType = 'field_change';
            context.fieldChange = {
              field: fieldDetails.fieldLabel,
              from: previousValue,
              to: fieldDetails.value,
              options: fieldDetails.allOptions.map(opt => opt.text)
            };
          }
          break;
          
        case 'checkbox':
          context.description = `${fieldDetails.checked ? 'Checked' : 'Unchecked'} ${fieldDetails.fieldLabel}`;
          context.actionType = 'checkbox_change';
          context.fieldChange = {
            field: fieldDetails.fieldLabel,
            from: !fieldDetails.checked,
            to: fieldDetails.checked,
            type: 'boolean'
          };
          break;
          
        case 'radio':
          context.description = `Selected "${fieldDetails.value}" for ${fieldDetails.fieldLabel}`;
          context.actionType = 'radio_selection';
          context.fieldChange = {
            field: fieldDetails.fieldLabel,
            from: fieldDetails.allOptions.find(opt => opt.selected && opt.value !== fieldDetails.value)?.text || '',
            to: fieldDetails.value,
            options: fieldDetails.allOptions.map(opt => opt.text)
          };
          break;
          
        default:
          if (type === 'change' || type === 'input') {
            const previousValue = target.dataset.previousValue || '';
            context.description = `Updated ${fieldDetails.fieldLabel}`;
            context.actionType = 'field_input';
            context.fieldChange = {
              field: fieldDetails.fieldLabel,
              from: previousValue,
              to: fieldDetails.value,
              type: fieldDetails.type
            };
          }
      }
      
      // Store current value for next change
      target.dataset.previousValue = fieldDetails.rawValue;
    } else {
      // Handle non-form elements
      const identifier = (
        target.getAttribute('aria-label') ||
        target.getAttribute('title') ||
        target.getAttribute('alt') ||
        target.getAttribute('name') ||
        target.getAttribute('placeholder') ||
        target.textContent?.trim() ||
        target.id ||
        ''
      ).trim();

      if (type === 'click') {
        if (target.tagName === 'BUTTON' || target.tagName === 'A' || target.getAttribute('role') === 'button') {
          context.description = `Clicked ${identifier ? `"${identifier}"` : 'button'}`;
          context.actionType = 'button_click';
        } else {
          context.description = `Clicked on ${target.tagName.toLowerCase()}${identifier ? ` "${identifier}"` : ''}`;
          context.actionType = 'element_click';
        }
      }
    }
  }

  return context;
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
      screenshots: screenshotBatch.map(item => item.screenshot), // Send just the screenshot content
      metadata: {
        url: window.location.href,
        title: document.title,
        timestamp: Date.now(),
        triggers: screenshotBatch.map(item => ({ 
          timestamp: item.timestamp,
          trigger: item.trigger 
        }))
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
    
    if (response.skipped) {
      console.log('⏭️ Screenshot skipped - tab not active');
      return;
    }
    
    if (response && response.screenshot) {
      // Ensure the screenshot is a string (base64 or data URL)
      if (typeof response.screenshot === 'string') {
        screenshotBatch.push({
          screenshot: response.screenshot,
          timestamp: Date.now(),
          trigger: trigger
        });
      } else {
        console.error('Screenshot response was not a string:', typeof response.screenshot);
      }
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
