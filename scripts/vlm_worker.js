import enginePromise from './getEngine.js';

self.onmessage = async ({ data }) => {
  if (data.cmd !== 'describe') return;

  const engine = await enginePromise;

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
          text: `Describe the user interaction in this image with specific details about:
1. The exact UI element being interacted with (button, dropdown, text field, etc.)
2. Any visible text or values being changed (from X to Y)
3. The location or context of the interaction (which section, menu, or part of the interface)
4. The state of any relevant UI elements (selected, expanded, focused, etc.)

Keep the description concise but include all relevant details about the interaction.`,
        },
      ],
    },
  ];

  const result = await engine.chat.completions.create({
    messages: userMessage,
    max_tokens: 100,
    temperature: 0.1,
  });

  self.postMessage({
    id: data.id,
    description: result.choices[0].message.content.trim(),
  });
};