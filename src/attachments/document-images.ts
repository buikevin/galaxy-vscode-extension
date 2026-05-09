/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-05-07
 * @modify date 2026-05-07
 * @desc Cross-platform document → image extraction helpers.
 *       - Office (DOCX/XLSX/PPTX): pure-JS via JSZip (works on Win/Mac/Linux).
 *       - PDF: prefers `pdftoppm` (Poppler) when available for true page rasterization,
 *              else falls back to pdfjs-dist + pngjs to extract embedded image
 *              XObjects (no native deps required).
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Maximum number of PDF pages we render / inspect per attachment. */
export const MAX_PDF_PAGES_FOR_VISION = 10;
/** Maximum number of embedded media files extracted per office document. */
export const MAX_EMBEDDED_MEDIA_FOR_VISION = 20;
/** PDF render DPI used by `pdftoppm` fast path. */
export const PDF_RENDER_DPI = 150;
/** Allowed image extensions inside Office archives. */
const OFFICE_IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

let pdftoppmAvailability: boolean | null = null;

/**
 * Detects whether the `pdftoppm` binary (Poppler) is available on PATH.
 * Result is cached for the lifetime of the process.
 */
export function isPdfToPpmAvailable(): boolean {
  if (pdftoppmAvailability !== null) {
    return pdftoppmAvailability;
  }
  try {
    const result = spawnSync("pdftoppm", ["-v"], { stdio: "ignore" });
    pdftoppmAvailability = result.status === 0 || result.error === undefined;
  } catch {
    pdftoppmAvailability = false;
  }
  return pdftoppmAvailability ?? false;
}

/** Test-only: resets the cached `pdftoppm` probe. */
export function _resetPdfToPpmAvailabilityForTests(): void {
  pdftoppmAvailability = null;
}

/**
 * Renders up to `MAX_PDF_PAGES_FOR_VISION` pages of a PDF into PNG files
 * inside `outputDir` using `pdftoppm`.
 */
function renderPdfPagesWithPdftoppm(
  pdfPath: string,
  outputDir: string,
): string[] {
  if (!fs.existsSync(pdfPath)) return [];
  fs.mkdirSync(outputDir, { recursive: true });
  const prefix = path.join(outputDir, "page");
  try {
    execFileSync(
      "pdftoppm",
      [
        "-png",
        "-r",
        String(PDF_RENDER_DPI),
        "-l",
        String(MAX_PDF_PAGES_FOR_VISION),
        pdfPath,
        prefix,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch {
    return [];
  }
  return fs
    .readdirSync(outputDir)
    .filter((name) => /^page-?\d+\.png$/i.test(name))
    .sort()
    .slice(0, MAX_PDF_PAGES_FOR_VISION)
    .map((name) => path.join(outputDir, name));
}

/**
 * Pure-JS fallback: extracts embedded image XObjects from a PDF using pdfjs-dist
 * and writes them as PNG via pngjs. No native binaries required.
 */
async function extractPdfEmbeddedImages(
  pdfPath: string,
  outputDir: string,
): Promise<string[]> {
  if (!fs.existsSync(pdfPath)) return [];
  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs", {
    with: { "resolution-mode": "import" },
  });
  let PNG: typeof import("pngjs").PNG;
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    ({ PNG } = await import("pngjs"));
  } catch {
    return [];
  }

  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
  try {
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    doc = await pdfjs.getDocument({
      data,
      disableFontFace: true,
      useSystemFonts: false,
    }).promise;
  } catch {
    return [];
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const written: string[] = [];
  const pageCount = Math.min(doc.numPages, MAX_PDF_PAGES_FOR_VISION);
  for (let pageNum = 1; pageNum <= pageCount; pageNum += 1) {
    try {
      const page = await doc.getPage(pageNum);
      const ops = await page.getOperatorList();
      for (let i = 0; i < ops.fnArray.length; i += 1) {
        if (ops.fnArray[i] !== pdfjs.OPS.paintImageXObject) continue;
        const imgName = ops.argsArray[i]?.[0];
        if (typeof imgName !== "string") continue;
        const img = await new Promise<unknown>((resolve) => {
          try {
            page.objs.get(imgName, (value: unknown) => resolve(value));
          } catch {
            resolve(null);
          }
        });
        const png = encodeImageObjectToPng(img, PNG);
        if (!png) continue;
        const targetPath = path.join(
          outputDir,
          `page-${String(pageNum).padStart(3, "0")}-img-${i}.png`,
        );
        fs.writeFileSync(targetPath, png);
        written.push(targetPath);
        if (written.length >= MAX_PDF_PAGES_FOR_VISION) {
          await page.cleanup();
          return written;
        }
      }
      await page.cleanup();
    } catch {
      // Skip pages that fail; continue with the rest.
    }
  }
  return written;
}

/**
 * Encodes a pdfjs-dist image XObject (`{ width, height, kind, data }`) as a PNG buffer.
 * Returns `null` when the image cannot be encoded.
 */
function encodeImageObjectToPng(
  img: unknown,
  PNG: typeof import("pngjs").PNG,
): Buffer | null {
  if (!img || typeof img !== "object") return null;
  const obj = img as {
    width?: number;
    height?: number;
    kind?: number;
    data?: Uint8Array | Uint8ClampedArray;
  };
  const { width, height, kind, data } = obj;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !data ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  const rgba = expandToRgba(data, width, height, kind ?? 0);
  if (!rgba) return null;
  try {
    const png = new PNG({ width, height });
    png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    return PNG.sync.write(png);
  } catch {
    return null;
  }
}

/**
 * Expands various pdfjs image-data layouts (grayscale, RGB, RGBA) into a flat RGBA buffer.
 * pdfjs `kind` constants: 1 = GRAYSCALE_1BPP, 2 = RGB_24BPP, 3 = RGBA_32BPP.
 */
function expandToRgba(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  kind: number,
): Uint8Array | null {
  const pixelCount = width * height;
  const out = new Uint8Array(pixelCount * 4);
  if (kind === 3 && data.length >= pixelCount * 4) {
    out.set(data.subarray(0, pixelCount * 4));
    return out;
  }
  if (kind === 2 && data.length >= pixelCount * 3) {
    for (let p = 0, src = 0, dst = 0; p < pixelCount; p += 1) {
      out[dst++] = data[src++] ?? 0;
      out[dst++] = data[src++] ?? 0;
      out[dst++] = data[src++] ?? 0;
      out[dst++] = 255;
    }
    return out;
  }
  if (data.length >= pixelCount) {
    for (let p = 0, dst = 0; p < pixelCount; p += 1) {
      const g = data[p] ?? 0;
      out[dst++] = g;
      out[dst++] = g;
      out[dst++] = g;
      out[dst++] = 255;
    }
    return out;
  }
  return null;
}

/**
 * Extracts embedded media (images) from one office document into `outputDir`
 * using pure-JS JSZip. Supports DOCX (`word/media/`), XLSX (`xl/media/`)
 * and PPTX (`ppt/media/`).
 */
async function extractArchiveMedia(
  archivePath: string,
  mediaPrefix: string,
  outputDir: string,
): Promise<string[]> {
  let JSZipMod: { default?: unknown } & Record<string, unknown>;
  try {
    JSZipMod = (await import("jszip")) as { default?: unknown } & Record<
      string,
      unknown
    >;
  } catch {
    return [];
  }
  const JSZipCtor = (JSZipMod.default ??
    JSZipMod) as new () => import("jszip") & {
    loadAsync: (b: Buffer) => Promise<import("jszip")>;
  };
  const JSZip = JSZipCtor as unknown as {
    loadAsync: (b: Buffer) => Promise<import("jszip")>;
  };
  let zip: import("jszip");
  try {
    const buffer = fs.readFileSync(archivePath);
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return [];
  }

  const entries = Object.values(zip.files).filter(
    (entry) =>
      !entry.dir &&
      entry.name.startsWith(mediaPrefix) &&
      OFFICE_IMAGE_EXT_RE.test(entry.name),
  );
  if (entries.length === 0) return [];

  fs.mkdirSync(outputDir, { recursive: true });
  const written: string[] = [];
  for (const entry of entries.slice(0, MAX_EMBEDDED_MEDIA_FOR_VISION)) {
    try {
      const data = await entry.async("nodebuffer");
      const targetName = path
        .basename(entry.name)
        .replace(/[^a-zA-Z0-9._-]+/g, "-");
      const targetPath = path.join(outputDir, targetName);
      fs.writeFileSync(targetPath, data);
      written.push(targetPath);
    } catch {
      // Skip individual entry failures.
    }
  }
  return written;
}

/** Document metadata describing an extraction request. */
export type DocumentImageExtractionInput = Readonly<{
  attachmentId: string;
  storedPath: string;
  originalName: string;
  mimeType: string;
  cacheRootDir: string;
}>;

/** Resolves the document type used to drive the extraction strategy. */
function resolveDocumentKind(
  input: DocumentImageExtractionInput,
): "pdf" | "docx" | "xlsx" | "pptx" | null {
  const ext = path.extname(input.originalName).toLowerCase();
  const mime = input.mimeType.toLowerCase();
  if (ext === ".pdf" || mime === "application/pdf") return "pdf";
  if (
    ext === ".docx" ||
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "docx";
  }
  if (
    ext === ".xlsx" ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    return "xlsx";
  }
  if (
    ext === ".pptx" ||
    mime ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    return "pptx";
  }
  return null;
}

/**
 * Extracts every embedded or rendered page image we can produce for one document.
 * Cached on disk under `<cacheRootDir>/<attachmentId>/`.
 */
export async function extractDocumentImages(
  input: DocumentImageExtractionInput,
): Promise<string[]> {
  const kind = resolveDocumentKind(input);
  if (!kind) return [];
  const cacheDir = path.join(input.cacheRootDir, input.attachmentId);
  if (kind === "pdf") {
    if (isPdfToPpmAvailable()) {
      const fast = renderPdfPagesWithPdftoppm(input.storedPath, cacheDir);
      if (fast.length > 0) return fast;
    }
    return extractPdfEmbeddedImages(input.storedPath, cacheDir);
  }
  const prefix =
    kind === "docx"
      ? "word/media/"
      : kind === "xlsx"
        ? "xl/media/"
        : "ppt/media/";
  return extractArchiveMedia(input.storedPath, prefix, cacheDir);
}

/**
 * Convenience helper that extracts images from an in-memory buffer
 * by writing it to a short-lived temp file.
 */
export async function extractDocumentImagesFromBuffer(opts: {
  attachmentId: string;
  originalName: string;
  mimeType: string;
  buffer: Buffer;
  cacheRootDir: string;
}): Promise<string[]> {
  const ext = path.extname(opts.originalName).toLowerCase() || ".bin";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "galaxy-doc-img-"));
  const tmpPath = path.join(tmpDir, `source${ext}`);
  try {
    fs.writeFileSync(tmpPath, opts.buffer);
    return await extractDocumentImages({
      attachmentId: opts.attachmentId,
      storedPath: tmpPath,
      originalName: opts.originalName,
      mimeType: opts.mimeType,
      cacheRootDir: opts.cacheRootDir,
    });
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore temp cleanup failures.
    }
  }
}
