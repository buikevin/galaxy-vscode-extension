/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-09
 * @modify date 2026-04-09
 * @desc Shared image-loading helpers used by multimodal runtime drivers.
 */

import fs from "node:fs";
import path from "node:path";

type InlineImagePayload = Readonly<{
  mimeType: string;
  base64Data: string;
  dataUrl: string;
}>;

const IMAGE_MIME_BY_EXTENSION = Object.freeze<Record<string, string>>({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
});

function readInlineImagePayload(imagePath: string): InlineImagePayload | null {
  const normalizedPath = String(imagePath ?? "").trim();
  if (!normalizedPath || !fs.existsSync(normalizedPath)) {
    return null;
  }

  const mimeType =
    IMAGE_MIME_BY_EXTENSION[path.extname(normalizedPath).toLowerCase()] ?? null;
  if (!mimeType) {
    return null;
  }

  const base64Data = fs.readFileSync(normalizedPath).toString("base64");
  return Object.freeze({
    mimeType,
    base64Data,
    dataUrl: `data:${mimeType};base64,${base64Data}`,
  });
}

export function buildOpenAIImageContentParts(
  imagePaths: readonly string[],
): Array<Record<string, unknown>> {
  return imagePaths
    .map((imagePath) => readInlineImagePayload(imagePath))
    .filter((payload): payload is InlineImagePayload => payload !== null)
    .map((payload) =>
      Object.freeze({
        type: "image_url",
        image_url: Object.freeze({
          url: payload.dataUrl,
        }),
      }),
    );
}

export function buildClaudeImageContentBlocks(
  imagePaths: readonly string[],
): Array<Record<string, unknown>> {
  return imagePaths
    .map((imagePath) => readInlineImagePayload(imagePath))
    .filter((payload): payload is InlineImagePayload => payload !== null)
    .map((payload) =>
      Object.freeze({
        type: "image",
        source: Object.freeze({
          type: "base64",
          media_type: payload.mimeType,
          data: payload.base64Data,
        }),
      }),
    );
}

export function buildGeminiImageContentParts(
  imagePaths: readonly string[],
): Array<Record<string, unknown>> {
  return imagePaths
    .map((imagePath) => readInlineImagePayload(imagePath))
    .filter((payload): payload is InlineImagePayload => payload !== null)
    .map((payload) =>
      Object.freeze({
        inlineData: Object.freeze({
          mimeType: payload.mimeType,
          data: payload.base64Data,
        }),
      }),
    );
}