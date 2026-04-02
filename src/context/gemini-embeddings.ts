/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-31
 * @modify date 2026-04-01
 * @desc Gemini embedding helpers shared by semantic retrieval layers with local fallback vectors.
 */

import { createHash } from 'node:crypto';

import { EMBEDDING_TIMEOUT_MS, GEMINI_EMBEDDING_MODEL } from './entities/constants';
import type { GeminiEmbeddingTaskType } from './entities/gemini';

const GEMINI_EMBEDDING_API_KEY =
  process.env.GEMINI_API_KEY?.trim() ||
  process.env.GOOGLE_API_KEY?.trim() ||
  'AIzaSyBBEuo4Hz1d5oCtSxYe0uULMCXtQS-7DF0';
const LOCAL_FALLBACK_EMBEDDING_DIMENSIONS = 128;

/**
 * Returns the embedding model name used by current retrieval flows.
 */
export function getGeminiEmbeddingModel(): string {
  return GEMINI_EMBEDDING_MODEL;
}

/**
 * Generates a deterministic local embedding when remote Gemini embeddings are unavailable.
 */
function createLocalFallbackEmbedding(text: string, taskType: GeminiEmbeddingTaskType): readonly number[] {
  const vector = new Array<number>(LOCAL_FALLBACK_EMBEDDING_DIMENSIONS).fill(0);
  const normalizedText = `${taskType}\n${text}`.normalize('NFKC');
  const tokenParts = normalizedText
    .split(/[\s\p{P}\p{S}]+/u)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const features = tokenParts.length > 0 ? tokenParts : [normalizedText.toLowerCase()];

  for (const feature of features) {
    const hash = createHash('sha256').update(feature).digest();
    for (let index = 0; index < hash.length; index += 1) {
      const dimension = (hash[index] ?? 0) % LOCAL_FALLBACK_EMBEDDING_DIMENSIONS;
      const signedValue = index % 2 === 0 ? 1 : -1;
      vector[dimension] = (vector[dimension] ?? 0) + signedValue;
    }
  }

  let magnitude = 0;
  for (const value of vector) {
    magnitude += value * value;
  }
  if (magnitude === 0) {
    return Object.freeze(vector);
  }

  const normalizedVector = vector.map((value) => value / Math.sqrt(magnitude));
  return Object.freeze(normalizedVector);
}

/**
 * Generates deterministic local fallback embeddings for one batch of texts.
 */
function createLocalFallbackEmbeddings(
  texts: readonly string[],
  taskType: GeminiEmbeddingTaskType,
): readonly (readonly number[])[] {
  return Object.freeze(texts.map((text) => createLocalFallbackEmbedding(text, taskType)));
}

/**
 * Requests Gemini embeddings for one batch of texts.
 */
export async function embedTexts(
  texts: readonly string[],
  taskType: GeminiEmbeddingTaskType,
): Promise<readonly (readonly number[])[] | null> {
  if (texts.length === 0) {
    return Object.freeze([]);
  }

  try {
    const { GoogleGenAI } = await import('@google/genai');
    const client = new GoogleGenAI({ apiKey: GEMINI_EMBEDDING_API_KEY });
    const response = await Promise.race([
      client.models.embedContent({
        model: GEMINI_EMBEDDING_MODEL,
        contents: [...texts],
        config: {
          taskType,
        },
      }),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), EMBEDDING_TIMEOUT_MS);
      }),
    ]);
    if (!response) {
      return createLocalFallbackEmbeddings(texts, taskType);
    }
    const embeddings = (response.embeddings ?? []).map((item) => Object.freeze([...(item.values ?? [])]));
    if (embeddings.length !== texts.length) {
      return createLocalFallbackEmbeddings(texts, taskType);
    }
    return Object.freeze(embeddings);
  } catch {
    return createLocalFallbackEmbeddings(texts, taskType);
  }
}

/**
 * Computes cosine similarity between two embedding vectors.
 */
export function cosineSimilarityEmbedding(
  left: readonly number[] | null | undefined,
  right: readonly number[] | null | undefined,
): number {
  if (!left || !right || left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}
