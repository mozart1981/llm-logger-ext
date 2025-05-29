import enginePromise from './getEngine.js';

self.onmessage = async ({ data }) => {
  if (data.cmd !== 'summarise') return;

  const engine = await enginePromise;

  // Build a string prompt for LLMs
  const textBlocks = data.events.map((e, i) =>
    `Frame ${i + 1}: ${e.type} — ${e.description || e.url || 'n/a'}`
  );
  const prompt = textBlocks.join('\n') + '\nSummarize the sequence above in 50 words or fewer.';

  const result = await engine.chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 120,
    temperature: 0.1,
  });

  self.postMessage({
    id: data.id,
    summary: result.choices[0].message.content.trim(),
  });
};
