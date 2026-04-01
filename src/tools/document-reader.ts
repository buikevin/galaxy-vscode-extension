/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Document decoding helpers for PDF, DOCX, spreadsheet, CSV, and plain-text files.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_DOCUMENT_MAX_CHARS,
  MAX_DOCUMENT_CELL_CHARS,
  MAX_DOCUMENT_TABLE_COLS,
  MAX_DOCUMENT_TABLE_ROWS,
} from '../shared/constants';
import type { DocumentReadOptions, DocumentResult, DocumentSliceResult } from '../shared/document-reader';

/**
 * Slices decoded document text into one paginated chunk.
 *
 * @param content Fully decoded document content.
 * @param options Optional pagination settings.
 * @returns Paginated slice metadata for the requested chunk.
 */
function sliceDocumentContent(content: string, options?: DocumentReadOptions): DocumentSliceResult {
  const maxChars = Math.max(1, Number(options?.maxChars ?? DEFAULT_DOCUMENT_MAX_CHARS));
  const offset = Math.max(0, Number(options?.offset ?? 0));
  const totalChars = content.length;
  const sliced = content.slice(offset, offset + maxChars);
  const hasMore = offset + sliced.length < totalChars;
  return Object.freeze({
    content: sliced,
    truncated: hasMore || offset > 0,
    totalChars,
    returnedChars: sliced.length,
    offset,
    ...(hasMore ? { nextOffset: offset + sliced.length } : {}),
    hasMore,
  });
}

/**
 * Truncates one spreadsheet cell for markdown table rendering.
 *
 * @param value Raw cell value from the spreadsheet parser.
 * @returns Normalized and size-limited cell text.
 */
function truncateCell(value: unknown): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_DOCUMENT_CELL_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_DOCUMENT_CELL_CHARS)}...`;
}

/**
 * Reads and decodes one supported document file.
 *
 * @param filePath Input file path.
 * @param options Optional pagination settings.
 * @returns Decoded document result or failure details.
 */
export async function readDocumentFile(filePath: string, options?: DocumentReadOptions): Promise<DocumentResult> {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return { success: false, content: '', error: `File not found: ${filePath}` };
  }

  const extension = path.extname(resolved).toLowerCase();

  try {
    switch (extension) {
      case '.pdf':
        return await readPdf(resolved, options);
      case '.docx':
      case '.doc':
        return await readDocx(resolved, options);
      case '.xlsx':
      case '.xls':
      case '.xlsm':
      case '.xlsb':
        return readExcel(resolved, options);
      case '.csv':
        return readCsv(resolved, options);
      case '.md':
      case '.txt':
      case '.rst':
        return readText(resolved, options);
      default:
        return readText(resolved, options);
    }
  } catch (error) {
    return {
      success: false,
      content: '',
      error: `Failed to read ${extension} file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Reads a web page and returns plain-text-like content with optional pagination.
 *
 * @param url HTTP or HTTPS URL to fetch.
 * @param options Optional pagination settings.
 * @returns Paginated text extracted from the fetched response body.
 */
export async function readWebPage(
  url: string,
  options?: DocumentReadOptions,
): Promise<DocumentResult> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return {
        success: false,
        content: '',
        error: `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
      };
    }
    const raw = await response.text();
    const normalized = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const sliced = sliceDocumentContent(normalized, options);
    return {
      success: true,
      content: sliced.content,
      format: 'HTML',
      truncated: sliced.truncated,
      totalChars: sliced.totalChars,
      returnedChars: sliced.returnedChars,
      offset: sliced.offset,
      ...(typeof sliced.nextOffset === 'number' ? { nextOffset: sliced.nextOffset } : {}),
      hasMore: sliced.hasMore,
    };
  } catch (error) {
    return {
      success: false,
      content: '',
      error: `Web page read error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Reads and decodes a PDF file.
 *
 * @param filePath Absolute PDF path.
 * @param options Optional pagination settings.
 * @returns Paginated PDF text.
 */
async function readPdf(filePath: string, options?: DocumentReadOptions): Promise<DocumentResult> {
  try {
    const pdfParseModule = (await import('pdf-parse')) as unknown as {
      default?: (buffer: Buffer) => Promise<{ text: string; numpages: number }>;
    };
    const pdfParse =
      pdfParseModule.default ??
      ((buffer: Buffer) => Promise.reject(new Error(`Unable to load pdf-parse for ${buffer.byteLength} bytes`)));
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    const sliced = sliceDocumentContent(data.text, options);
    return {
      success: true,
      content: sliced.content,
      format: 'PDF',
      pageCount: data.numpages,
      truncated: sliced.truncated,
      totalChars: sliced.totalChars,
      returnedChars: sliced.returnedChars,
      offset: sliced.offset,
      ...(typeof sliced.nextOffset === 'number' ? { nextOffset: sliced.nextOffset } : {}),
      hasMore: sliced.hasMore,
    };
  } catch (error) {
    return {
      success: false,
      content: '',
      error: `PDF parse error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Reads and decodes a DOCX/DOC file.
 *
 * @param filePath Absolute DOCX path.
 * @param options Optional pagination settings.
 * @returns Paginated DOCX text.
 */
async function readDocx(filePath: string, options?: DocumentReadOptions): Promise<DocumentResult> {
  try {
    const mammoth = await import('mammoth');
    const buffer = fs.readFileSync(filePath);
    const result = await mammoth.extractRawText({ buffer });
    const sliced = sliceDocumentContent(result.value, options);
    return {
      success: true,
      content: sliced.content,
      format: 'DOCX',
      truncated: sliced.truncated,
      totalChars: sliced.totalChars,
      returnedChars: sliced.returnedChars,
      offset: sliced.offset,
      ...(typeof sliced.nextOffset === 'number' ? { nextOffset: sliced.nextOffset } : {}),
      hasMore: sliced.hasMore,
    };
  } catch (error) {
    return {
      success: false,
      content: '',
      error: `DOCX parse error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Reads and renders a spreadsheet workbook into markdown sections.
 *
 * @param filePath Absolute workbook path.
 * @param options Optional pagination settings.
 * @returns Paginated spreadsheet summary.
 */
function readExcel(filePath: string, options?: DocumentReadOptions): DocumentResult {
  try {
    const xlsx = require('xlsx') as typeof import('xlsx');
    const workbook = xlsx.readFile(filePath, { cellDates: true, cellNF: false, cellText: true });
    const sheetNames = workbook.SheetNames;

    if (sheetNames.length === 0) {
      return { success: true, content: '(empty workbook — no sheets found)', format: 'Excel' };
    }

    const sections: string[] = [];
    for (const sheetName of sheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) {
        continue;
      }
      const rows: string[][] = xlsx.utils.sheet_to_json<string[]>(sheet, {
        header: 1,
        defval: '',
        raw: false,
      });
      const nonEmptyRows = rows.filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''));
      if (nonEmptyRows.length === 0) {
        sections.push(`## Sheet: ${sheetName}\n(empty sheet)`);
        continue;
      }
      const firstRow = (nonEmptyRows[0] ?? []).slice(0, MAX_DOCUMENT_TABLE_COLS).map(truncateCell);
      const dataRows = nonEmptyRows
        .slice(1, MAX_DOCUMENT_TABLE_ROWS + 1)
        .map((row) => row.slice(0, MAX_DOCUMENT_TABLE_COLS).map(truncateCell));
      const columnWidths = firstRow.map((header, index) => {
        const maxData = Math.max(...dataRows.map((row) => String(row[index] ?? '').length));
        return Math.max(String(header).length, maxData, 3);
      });
      const pad = (value: string, width: number) => String(value).padEnd(width);
      const header = `| ${firstRow.map((cell, index) => pad(String(cell), columnWidths[index] ?? 3)).join(' | ')} |`;
      const divider = `| ${columnWidths.map((width) => '-'.repeat(width)).join(' | ')} |`;
      const bodyLines = dataRows
        .slice(0, 500)
        .map((row) => `| ${firstRow.map((_, index) => pad(String(row[index] ?? ''), columnWidths[index] ?? 3)).join(' | ')} |`);
      const truncationNote =
        nonEmptyRows.length - 1 > MAX_DOCUMENT_TABLE_ROWS || (nonEmptyRows[0]?.length ?? 0) > MAX_DOCUMENT_TABLE_COLS
          ? `\n> _(showing ${Math.min(MAX_DOCUMENT_TABLE_ROWS, Math.max(0, nonEmptyRows.length - 1))} of ${Math.max(0, nonEmptyRows.length - 1)} rows and ${Math.min(MAX_DOCUMENT_TABLE_COLS, firstRow.length || MAX_DOCUMENT_TABLE_COLS)} of ${nonEmptyRows[0]?.length ?? 0} columns)_`
          : '';
      sections.push(
        `## Sheet: ${sheetName} (${Math.max(0, nonEmptyRows.length - 1)} rows × ${nonEmptyRows[0]?.length ?? 0} cols)\n\n${[header, divider, ...bodyLines].join('\n')}${truncationNote}`,
      );
    }

    const sliced = sliceDocumentContent(sections.join('\n\n---\n\n'), options);
    return {
      success: true,
      content: sliced.content,
      format: 'Excel',
      pageCount: sheetNames.length,
      truncated: sliced.truncated,
      totalChars: sliced.totalChars,
      returnedChars: sliced.returnedChars,
      offset: sliced.offset,
      ...(typeof sliced.nextOffset === 'number' ? { nextOffset: sliced.nextOffset } : {}),
      hasMore: sliced.hasMore,
    };
  } catch (error) {
    return {
      success: false,
      content: '',
      error: `Excel parse error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Parses a single CSV line with basic quoted-cell support.
 *
 * @param line Raw CSV line.
 * @returns Parsed cells for the line.
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let inQuote = false;
  let cell = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuote && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuote = !inQuote;
      }
    } else if (char === ',' && !inQuote) {
      result.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  result.push(cell.trim());
  return result;
}

/**
 * Reads and renders a CSV file into a compact markdown table.
 *
 * @param filePath Absolute CSV path.
 * @param options Optional pagination settings.
 * @returns Paginated CSV summary.
 */
function readCsv(filePath: string, options?: DocumentReadOptions): DocumentResult {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');
    if (lines.length === 0) {
      return { success: true, content: '(empty CSV)', format: 'CSV' };
    }
    const rows = lines.map(parseCsvLine);
    const nonEmptyRows = rows.filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''));
    const firstRow = (nonEmptyRows[0] ?? []).slice(0, MAX_DOCUMENT_TABLE_COLS).map(truncateCell);
    const dataRows = nonEmptyRows
      .slice(1, MAX_DOCUMENT_TABLE_ROWS + 1)
      .map((row) => row.slice(0, MAX_DOCUMENT_TABLE_COLS).map(truncateCell));
    const columnWidths = firstRow.map((header, index) => {
      const maxData = Math.max(...dataRows.map((row) => String(row[index] ?? '').length));
      return Math.max(String(header).length, maxData, 3);
    });
    const pad = (value: string, width: number) => String(value).padEnd(width);
    const header = `| ${firstRow.map((cell, index) => pad(String(cell), columnWidths[index] ?? 3)).join(' | ')} |`;
    const divider = `| ${columnWidths.map((width) => '-'.repeat(width)).join(' | ')} |`;
    const bodyLines = dataRows.map((row) => `| ${firstRow.map((_, index) => pad(String(row[index] ?? ''), columnWidths[index] ?? 3)).join(' | ')} |`);
    const sliced = sliceDocumentContent([header, divider, ...bodyLines].join('\n'), options);
    return {
      success: true,
      content: sliced.content,
      format: 'CSV',
      truncated: sliced.truncated,
      totalChars: sliced.totalChars,
      returnedChars: sliced.returnedChars,
      offset: sliced.offset,
      ...(typeof sliced.nextOffset === 'number' ? { nextOffset: sliced.nextOffset } : {}),
      hasMore: sliced.hasMore,
    };
  } catch (error) {
    return {
      success: false,
      content: '',
      error: `CSV parse error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Reads a plain-text-like document without additional parsing.
 *
 * @param filePath Absolute text file path.
 * @param options Optional pagination settings.
 * @returns Paginated text content.
 */
function readText(filePath: string, options?: DocumentReadOptions): DocumentResult {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const sliced = sliceDocumentContent(raw, options);
    return {
      success: true,
      content: sliced.content,
      format: 'Text',
      truncated: sliced.truncated,
      totalChars: sliced.totalChars,
      returnedChars: sliced.returnedChars,
      offset: sliced.offset,
      ...(typeof sliced.nextOffset === 'number' ? { nextOffset: sliced.nextOffset } : {}),
      hasMore: sliced.hasMore,
    };
  } catch (error) {
    return {
      success: false,
      content: '',
      error: `Text parse error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
