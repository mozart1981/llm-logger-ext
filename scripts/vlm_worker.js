import { CreateMLCEngine, prebuiltAppConfig } from "@mlc-ai/web-llm";

let enginePromise;

async function getEngine() {
  if (!enginePromise) {
    enginePromise = CreateMLCEngine({
      appConfig: prebuiltAppConfig('Phi-3.5-vision-instruct-q4f16_1-MLC'),
    });
    await enginePromise.reload();
  }
  return enginePromise;
}

self.onmessage = async ({ data }) => {
  if (data.cmd !== 'describe') return;

  const engine = await getEngine();

  const userMessage = [
    {
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
          text: 'Describe the user action in this image briefly.',
        },
      ],
    },
  ];

  const result = await engine.chat.completions.create({
    messages: userMessage,
    max_tokens: 30,
    temperature: 0.0,
  });

  self.postMessage({
    id: data.id,
    description: result.choices[0].message.content.trim(),
  });
};