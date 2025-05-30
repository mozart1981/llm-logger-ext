import enginePromise from './getEngine.js';

// Constants for event categorization and timing
const CONSTANTS = {
  MAJOR_EVENT_TYPES: ['submit', 'navigation', 'click'],
  FORM_EVENT_TYPES: ['input', 'change', 'focus', 'blur', 'submit', 'invalid'],
  DRAG_EVENT_TYPES: ['dragstart', 'drag', 'dragenter', 'dragover', 'dragleave', 'drop'],
  TEXT_EVENT_TYPES: ['input', 'keydown', 'keyup', 'paste', 'cut', 'copy'],
  GROUP_TIME_THRESHOLD: 2000, // milliseconds
  MAX_CACHE_SIZE: 50
};

// Cache for summarized responses
const summaryCache = new Map();

// Template for workflow summary
const SUMMARY_TEMPLATE = `Analyze this sequence of user interactions and create a detailed workflow summary.
Focus on the specific values and changes made during the user's interactions.

Event Sequence:
{eventBlocks}

Provide a structured summary in the following format:

[FINAL SUMMARY] WORKFLOW SUMMARY
--------------
Step-by-Step Actions:
1. [First action with EXACT field values - What field was changed? From what value to what value?]
2. [Second action with EXACT field values]
3. [Continue with numbered steps...]

Context Details:
- Starting Point: [Initial page/state with any relevant field values]
- End Point: [Final page/state with any relevant field values]
- Key Interactions: [List each form field change with exact before/after values]

Process Analysis:
- Main Task: [What was the user trying to accomplish]
- Completion Status: [Whether the task was completed]
- Notable Patterns: [Any repeated actions or patterns in field updates]

IMPORTANT: Always include the exact values that were changed in fields, not just the field names.
For example, instead of "Updated Category field", say "Changed Category field from 'Electronics' to 'Books'"`;

/**
 * Main message handler for the summarizer worker
 */
self.onmessage = async ({ data }) => {
  if (data.cmd !== 'summarise') return;

  try {
    const engine = await enginePromise;
    const cacheKey = generateCacheKey(data.events);
    
    // Check cache first
    if (summaryCache.has(cacheKey)) {
      self.postMessage(summaryCache.get(cacheKey));
      return;
    }

    const groupedEvents = groupRelatedEvents(data.events);
    const eventBlocks = buildEventBlocks(groupedEvents);
    const prompt = SUMMARY_TEMPLATE.replace('{eventBlocks}', eventBlocks.join('\n\n'));

    const result = await engine.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.2,
    });

    const response = {
      id: data.id,
      summary: result.choices[0].message.content.trim(),
    };

    // Cache the response
    summaryCache.set(cacheKey, response);
    if (summaryCache.size > CONSTANTS.MAX_CACHE_SIZE) {
      const firstKey = summaryCache.keys().next().value;
      summaryCache.delete(firstKey);
    }

    self.postMessage(response);
  } catch (error) {
    console.error('Error in summarizer worker:', error);
    self.postMessage({
      id: data.id,
      error: error.message
    });
  }
};

/**
 * Generates a cache key for a set of events
 * @param {Array} events - Array of events
 * @returns {string} Cache key
 */
function generateCacheKey(events) {
  const { workflows = [], otherEvents = [] } = events;
  
  const workflowKeys = workflows.map(w => 
    `wf-${w.type}-${w.duration}`
  );
  
  const eventKeys = otherEvents.map(e => 
    `evt-${e.actionType}-${e.timestamp}`
  );
  
  return [...workflowKeys, ...eventKeys]
    .join('|')
    .slice(0, 100); // Limit key length
}

/**
 * Determines the category of an event
 * @param {Array} events - Array of related events
 * @returns {string} Event category
 */
function determineEventCategory(events) {
  // Look for structured analysis first
  const structuredEvent = events.find(e => e.structuredAnalysis?.interaction?.category);
  if (structuredEvent) {
    return structuredEvent.structuredAnalysis.interaction.category;
  }

  // Fall back to event type analysis
  const types = events.map(e => e.type);
  
  if (types.some(t => CONSTANTS.FORM_EVENT_TYPES.slice(0, 2).includes(t))) {
    return 'Form Submission';
  }
  if (types.some(t => CONSTANTS.FORM_EVENT_TYPES.includes(t))) {
    return 'Form Input';
  }
  if (types.some(t => ['tabNavigate', 'navigation'].includes(t))) {
    return 'Navigation';
  }
  if (types.some(t => CONSTANTS.DRAG_EVENT_TYPES.slice(0, 2).includes(t))) {
    return 'Content Manipulation';
  }
  if (types.some(t => ['click', 'dblclick', 'contextmenu'].includes(t))) {
    return 'UI Interaction';
  }
  if (types.some(t => ['copy', 'cut', 'paste'].includes(t))) {
    return 'Data Transfer';
  }
  
  return 'Other Interaction';
}

/**
 * Groups related events together based on timing and context
 * @param {Object} eventData - Object containing workflows and otherEvents
 * @returns {Array} Array of event groups
 */
function groupRelatedEvents(eventData) {
  const { workflows = [], otherEvents = [] } = eventData;
  
  // Convert workflows into event-like objects for grouping
  const workflowEvents = workflows.map(w => ({
    type: 'workflow',
    workflowType: w.type,
    timestamp: w.startTime,
    description: `${w.type} workflow: ${w.target}`,
    steps: w.steps,
    duration: w.duration
  }));

  // Combine workflow events with other events and sort by timestamp
  const allEvents = [...workflowEvents, ...otherEvents].sort((a, b) => {
    const timeA = a.timestamp || a.ts;
    const timeB = b.timestamp || b.ts;
    return timeA - timeB;
  });

  const groups = [];
  let currentGroup = [];
  let lastTimestamp = 0;
  
  allEvents.forEach(event => {
    const timestamp = event.timestamp || event.ts;
    const shouldStartNewGroup = shouldCreateNewGroup(event, currentGroup, timestamp, lastTimestamp);
    
    if (shouldStartNewGroup) {
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
      }
      currentGroup = [event];
    } else {
      currentGroup.push(event);
    }
    
    lastTimestamp = timestamp;
  });
  
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }
  
  return groups;
}

/**
 * Determines if a new group should be created
 * @param {Object} event - Current event
 * @param {Array} currentGroup - Current group of events
 * @param {number} timestamp - Current event timestamp
 * @param {number} lastTimestamp - Last event timestamp
 * @returns {boolean} Whether to create a new group
 */
function shouldCreateNewGroup(event, currentGroup, timestamp, lastTimestamp) {
  return (
    isMajorEvent(event) ||
    currentGroup.length === 0 ||
    timestamp - lastTimestamp > CONSTANTS.GROUP_TIME_THRESHOLD ||
    !areEventsRelated(currentGroup[0], event) ||
    haveDifferentCategories(currentGroup[0], event)
  );
}

/**
 * Checks if two events have different categories
 * @param {Object} event1 - First event
 * @param {Object} event2 - Second event
 * @returns {boolean} Whether events have different categories
 */
function haveDifferentCategories(event1, event2) {
  const cat1 = event1.structuredAnalysis?.interaction?.category;
  const cat2 = event2.structuredAnalysis?.interaction?.category;
  return cat1 && cat2 && cat1 !== cat2;
}

/**
 * Checks if an event is a major event
 * @param {Object} event - Event to check
 * @returns {boolean} Whether the event is major
 */
function isMajorEvent(event) {
  return CONSTANTS.MAJOR_EVENT_TYPES.includes(event.type) || 
         event.structuredAnalysis?.interaction?.category === 'Navigation';
}

/**
 * Checks if two events are related
 * @param {Object} event1 - First event
 * @param {Object} event2 - Second event
 * @returns {boolean} Whether events are related
 */
function areEventsRelated(event1, event2) {
  if (!event1 || !event2) return false;
  
  // Check structured analysis first
  if (event1.structuredAnalysis?.interaction && event2.structuredAnalysis?.interaction) {
    const context1 = event1.structuredAnalysis.interaction.context;
    const context2 = event2.structuredAnalysis.interaction.context;
    
    if (context1?.user_flow && context1.user_flow === context2?.user_flow) return true;
    if (context1?.parent_container && context1.parent_container === context2?.parent_container) return true;
  }
  
  // Fall back to basic relationship checks
  return (
    event1.path === event2.path ||
    (isFormEvent(event1) && isFormEvent(event2)) ||
    (isDragEvent(event1) && isDragEvent(event2)) ||
    (isTextEvent(event1) && isTextEvent(event2))
  );
}

/**
 * Checks if an event is a form event
 * @param {Object} event - Event to check
 * @returns {boolean} Whether the event is a form event
 */
function isFormEvent(event) {
  return CONSTANTS.FORM_EVENT_TYPES.includes(event.type);
}

/**
 * Checks if an event is a drag event
 * @param {Object} event - Event to check
 * @returns {boolean} Whether the event is a drag event
 */
function isDragEvent(event) {
  return CONSTANTS.DRAG_EVENT_TYPES.includes(event.type);
}

/**
 * Checks if an event is a text event
 * @param {Object} event - Event to check
 * @returns {boolean} Whether the event is a text event
 */
function isTextEvent(event) {
  return CONSTANTS.TEXT_EVENT_TYPES.includes(event.type) && 
         ['input', 'textarea'].includes(event.elementType);
}

/**
 * Builds event blocks for summary
 * @param {Array} groupedEvents - Array of event groups
 * @returns {Array} Formatted event blocks
 */
function buildEventBlocks(groupedEvents) {
  return groupedEvents.map((group, i) => {
    const mainEvent = group[0];
    const category = determineEventCategory(group);
    
    const details = [
      `=== Action Group ${i + 1}: ${category.toUpperCase()} ===`
    ];

    group.forEach((evt, j) => {
      const eventDetails = formatEventDetails(evt, j);
      details.push(...eventDetails);
    });

    return details.join('\n');
  });
}

/**
 * Formats event details for summary
 * @param {Object} evt - Event to format
 * @param {number} index - Event index
 * @returns {Array} Formatted event details
 */
function formatEventDetails(evt, index) {
  const timestamp = new Date(evt.timestamp || evt.ts).toLocaleTimeString();
  const eventNum = index + 1;
  const details = [];

  // Start with timestamp and basic info
  let mainDetail = `  ${eventNum}. [${timestamp}] `;

  // Add context-specific details
  if (evt.type === 'workflow') {
    mainDetail += `${evt.workflowType} workflow on "${evt.target}"`;
    if (evt.steps?.length > 0) {
      details.push(mainDetail);
      evt.steps.forEach((step, i) => {
        let stepDetail = `    ${i + 1}. ${step.action}`;
        if (step.details?.fieldDetails) {
          const fd = step.details.fieldDetails;
          stepDetail += ` (Field: "${fd.fieldLabel || fd.name}", Value: "${fd.value}")`;
        }
        details.push(stepDetail);
      });
      return details;
    }
  }
  else if (evt.type === 'navigation') {
    mainDetail += `Navigated to: ${evt.pageTitle} (${evt.url})`;
  } 
  else if (evt.type === 'click') {
    if (evt.href) {
      mainDetail += `Clicked link "${evt.identifier}" → ${evt.href}`;
    } else {
      mainDetail += `Clicked ${evt.elementType} "${evt.identifier}"`;
      if (evt.parentContext) {
        mainDetail += ` in ${evt.parentContext}`;
      }
    }
  }
  else if (evt.type === 'input' || evt.type === 'change') {
    if (evt.fieldChange) {
      mainDetail += `Changed "${evt.fieldChange.field}" from "${evt.fieldChange.from}" to "${evt.fieldChange.to}"`;
      if (evt.fieldChange.options) {
        details.push(`    Available options: ${evt.fieldChange.options.join(', ')}`);
      }
    } else if (evt.fieldDetails) {
      mainDetail += `Updated ${evt.fieldDetails.fieldType} field "${evt.fieldDetails.fieldLabel}" to "${evt.fieldDetails.value}"`;
    } else {
      mainDetail += `Updated ${evt.fieldType || 'form'} field "${evt.fieldName || 'unknown'}"`;
    }
    if (evt.parentContext) {
      mainDetail += ` in ${evt.parentContext}`;
    }
  }
  else if (evt.type === 'submit') {
    mainDetail += `Submitted form${evt.parentContext ? ` in ${evt.parentContext}` : ''}`;
    if (evt.formData) {
      details.push('    Form data:');
      Object.entries(evt.formData).forEach(([key, value]) => {
        details.push(`      ${key}: ${value}`);
      });
    }
  }

  details.unshift(mainDetail);

  // Add any additional context
  if (evt.description && !mainDetail.includes(evt.description)) {
    details.push(`    Details: ${evt.description}`);
  }

  return details;
}
