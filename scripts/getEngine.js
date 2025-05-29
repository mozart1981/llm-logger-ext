import { CreateMLCEngine } from "@mlc-ai/web-llm";

const MODEL_NAME = "Llama-3.2-3B-Instruct-q4f16_1-MLC";

const enginePromise = CreateMLCEngine(MODEL_NAME);

export function getEngine() {
  return enginePromise;
}

export default enginePromise;