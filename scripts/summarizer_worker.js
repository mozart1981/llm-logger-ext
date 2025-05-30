import enginePromise from './getEngine.js';

self.onmessage = async ({ data }) => {
  if (data.cmd !== 'summarise') return;

  const engine = await enginePromise;

  // Build a string prompt for LLMs with enhanced details
  const textBlocks = data.events.map((e, i) => {
    const details = [e.type];
    if (e.description) details.push(e.description);
    if (e.label) details.push(e.label);
    if (e.url && !e.description) details.push(e.url);
    
    return `Frame ${i + 1}: ${details.join(' — ')}`;
  });

  const prompt = `Below is a detailed sequence of user interactions with a web browser, organized in frames. Each frame represents a distinct user action or browser event. Please create a comprehensive summary that includes:
1. The sequence of pages visited and interactions performed
2. Any specific content the user engaged with (text inputs, clicks, etc.)
3. The timing and flow of actions
4. Important details about what the user viewed or interacted with

Events:
${textBlocks.join('\n')}

Create a detailed paragraph (100-150 words) that tells the story of what the user did, maintaining chronological order and including specific details about their interactions. Reference frame numbers when describing key actions.`;

  const result = await engine.chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 250,
    temperature: 0.3,
  });

  self.postMessage({
    id: data.id,
    summary: result.choices[0].message.content.trim(),
  });
};
