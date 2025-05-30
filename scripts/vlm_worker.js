import enginePromise from './getEngine.js';

// Constants for event categorization
const EVENT_SECTIONS = {
  BASIC_INFO: 'basic_info',
  ELEMENT_DETAILS: 'element_details',
  INTERACTION_STATE: 'interaction_state',
  SPATIAL_INFO: 'spatial_info',
  TECHNICAL_DETAILS: 'technical_details'
};

// Cache for parsed responses to avoid repeated processing
const responseCache = new Map();

// Template for VLM analysis prompt
const ANALYSIS_TEMPLATE = `Analyze this micro-interaction in detail. The captured event context is:
{eventContext}

Provide a structured analysis in JSON-like format:
{
  "interaction": {
    "category": "[Form Input|Navigation|UI Control|Data Manipulation|Media Control]",
    "action": {
      "type": "[The specific interaction type]",
      "target": "[The element interacted with]",
      "location": "[Where in the UI this occurred]"
    },
    "state_change": {
      "before": "[Previous state/value]",
      "after": "[New state/value]",
      "impact": "[What this change affects in the UI]"
    },
    "sequence": [
      "Step 1: [First micro-action]",
      "Step 2: [Second micro-action]",
      ...
    ],
    "visual_evidence": {
      "confirms_action": "[yes/no]",
      "visible_changes": "[What changed visually]",
      "ui_feedback": "[Any UI feedback shown]"
    },
    "context": {
      "parent_container": "[The containing element/section]",
      "related_elements": "[Nearby or affected elements]",
      "user_flow": "[Where this fits in a typical user journey]"
    }
  }
}

Focus on being precise about what changed and how it impacts the user's interaction flow. This analysis will be used to build a larger narrative of user actions.`;

/**
 * Formats event context into a readable description
 * @param {Object} ctx - Event context object
 * @returns {string} Formatted description
 */
function formatEventContext(ctx) {
  if (!ctx) return 'No event context available';

  const sections = Object.fromEntries(
    Object.values(EVENT_SECTIONS).map(section => [section, []])
  );
  
  // Basic Event Information
  sections[EVENT_SECTIONS.BASIC_INFO].push(
    `Event Type: ${ctx.type}`,
    `Timestamp: ${new Date(ctx.timestamp || ctx.ts).toLocaleTimeString()}`
  );
  
  // Element Details
  if (ctx.elementType) {
    const elementDetails = sections[EVENT_SECTIONS.ELEMENT_DETAILS];
    elementDetails.push(`Element Type: ${ctx.elementType}`);
    if (ctx.label) elementDetails.push(`Label: ${ctx.label}`);
    if (ctx.path) elementDetails.push(`DOM Path: ${ctx.path}`);
  }
  
  // Interaction State
  if (ctx.elementState?.length) {
    sections[EVENT_SECTIONS.INTERACTION_STATE].push(
      `Element States: ${ctx.elementState.join(', ')}`
    );
  }
  
  // Input Details
  if (ctx.inputDetails) {
    const details = formatInputDetails(ctx.inputDetails);
    sections[EVENT_SECTIONS.TECHNICAL_DETAILS].push(details);
  }
  
  // Spatial Information
  if (ctx.rect) {
    sections[EVENT_SECTIONS.SPATIAL_INFO].push(formatSpatialInfo(ctx.rect));
  }
  
  // Action Description
  if (ctx.description) {
    sections[EVENT_SECTIONS.BASIC_INFO].push(`Action Description: ${ctx.description}`);
  }

  return formatSections(sections);
}

/**
 * Formats input details into a string
 * @param {Object} inputDetails - Input field details
 * @returns {string} Formatted input details
 */
function formatInputDetails(inputDetails) {
  const { type, name, id, currentLength, maxLength, pattern, placeholder } = inputDetails;
  const details = [`Input Type: ${type}`];
  
  if (name) details.push(`Field Name: "${name}"`);
  if (id) details.push(`ID: "${id}"`);
  if (currentLength !== undefined) details.push(`Current Length: ${currentLength}`);
  if (maxLength) details.push(`Max Length: ${maxLength}`);
  if (pattern) details.push(`Pattern: ${pattern}`);
  if (placeholder) details.push(`Placeholder: "${placeholder}"`);
  
  return details.join('\n');
}

/**
 * Formats spatial information into a string
 * @param {Object} rect - Rectangle dimensions and position
 * @returns {string} Formatted spatial information
 */
function formatSpatialInfo(rect) {
  const spatial = [`Screen Position: (${rect.x}, ${rect.y})`];
  
  if (rect.viewportX !== undefined) {
    spatial.push(`Viewport Position: (${rect.viewportX}, ${rect.viewportY})`);
  }
  spatial.push(`Size: ${rect.width}x${rect.height}`);
  
  return spatial.join('\n');
}

/**
 * Formats sections into final output
 * @param {Object} sections - Sections with their content
 * @returns {string} Formatted sections
 */
function formatSections(sections) {
  return Object.entries(sections)
    .filter(([_, items]) => items.length > 0)
    .map(([section, items]) => {
      const title = section.replace('_', ' ').toUpperCase();
      return `=== ${title} ===\n${items.join('\n')}`;
    })
    .join('\n\n');
}

/**
 * Attempts to parse JSON-like structure from VLM response
 * @param {string} description - Raw VLM response
 * @returns {Object|null} Parsed structure or null
 */
function parseStructuredAnalysis(description) {
  try {
    const jsonMatch = description.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch (e) {
    console.warn('Failed to parse structured analysis:', e);
    return null;
  }
}

// Main message handler
self.onmessage = async ({ data }) => {
  if (data.cmd !== 'describe') return;

  try {
    const engine = await enginePromise;
    const cacheKey = `${data.id}-${data.imgBase64.slice(0, 100)}`;
    
    // Check cache first
    if (responseCache.has(cacheKey)) {
      self.postMessage(responseCache.get(cacheKey));
      return;
    }

    const eventContextDesc = data.eventContext ? formatEventContext(data.eventContext) : '';
    const userMessage = [{
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${data.imgBase64}`,
            format: 'image/png',
          },
        },
        {
          type: 'text',
          text: ANALYSIS_TEMPLATE.replace('{eventContext}', eventContextDesc)
        },
      ],
    }];

    const result = await engine.chat.completions.create({
      messages: userMessage,
      max_tokens: 400,
      temperature: 0.1,
    });

    const description = result.choices[0].message.content.trim();
    const structuredAnalysis = parseStructuredAnalysis(description);
    
    const response = {
      id: data.id,
      description,
      structuredAnalysis,
      eventContext: data.eventContext
    };

    // Cache the response
    responseCache.set(cacheKey, response);
    if (responseCache.size > 100) { // Prevent unbounded growth
      const firstKey = responseCache.keys().next().value;
      responseCache.delete(firstKey);
    }

    self.postMessage(response);
  } catch (error) {
    console.error('Error in VLM worker:', error);
    self.postMessage({
      id: data.id,
      error: error.message,
      eventContext: data.eventContext
    });
  }
};