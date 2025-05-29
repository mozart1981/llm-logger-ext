import { CreateMLCEngine } from "@mlc-ai/web-llm";

let engine = null;

async function getEngine() {
  if (!engine) {
    engine = await CreateMLCEngine('Llama-3.2-3B-Instruct-q4f16_1-MLC');
    await engine.reload();
    enginePromise = newEngine;
  }
  return engine;
}

self.onmessage = async ({ data }) => {
  if (data.cmd !== 'summarise') return;

  const engine = await getEngine();

  const blocks = [];
  data.events.forEach((e, i) => {
    blocks.push({
      type: 'image_url',
      image_url: {
        url: `data:image/png;base64,${e.imgBase64}`,
        format: 'image/png',
      },
    });
    blocks.push({
      type: 'text',
      text: `Frame ${i + 1}: ${e.type} — ${e.description || e.url || 'n/a'}`,
    });
  });

  blocks.push({
    type: 'text',
    text: 'Summarize the sequence above in 50 words or fewer.',
  });

  const result = await engine.chat.completions.create({
    messages: [{ role: 'user', content: blocks }],
    max_tokens: 120,
    temperature: 0.1,
  });

  self.postMessage({
    id: data.id,
    summary: result.choices[0].message.content.trim(),
  });
};
