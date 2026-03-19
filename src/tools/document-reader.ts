import fs from 'node:fs';
import path from 'node:path';

export type DocumentResult = Readonly<{
  success: boolean;
  content: string;
  error?: string;
  format?: string;
  pageCount?: number;
  truncated?: boolean;
  totalChars?: number;
  returnedChars?: number;
  offset?: number;
  nextOffset?: number;
  hasMore?: boolean;
}>;

const DEFAULT_DOCUMENT_MAX_CHARS = 20_000;
const MAX_TABLE_ROWS = 120;
const MAX_TABLE_COLS = 16;
const MAX_CELL_CHARS = 120;

type DocumentReadOptions = Readonly<{
  maxChars?: number;
  offset?: number;
}>;

function sliceDocumentContent(
  content: string,
  opts?: DocumentReadOptions,
): Readonly<{ content: string; truncated: boolean; totalChars: number; returnedChars: number; offset: number; nextOffset?: number; hasMore: boolean }> {
  const maxChars = Math.max(1, Number(opts?.maxChars ?? DEFAULT_DOCUMENT_MAX_CHARS));
  const offset = Math.max(0, Number(opts?.offset ?? 0));
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

function truncateCell(value: unknown): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_CELL_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_CELL_CHARS)}...`;
}

export async function readDocumentFile(filePath: string, opts?: DocumentReadOptions): Promise<DocumentResult> {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return { success: false, content: '', error: `File not found: ${filePath}` };
  }

  const ext = path.extname(resolved).toLowerCase();

  try {
    switch (ext) {
      case '.pdf':
        return await readPdf(resolved, opts);
      case '.docx':
      case '.doc':
        return await readDocx(resolved, opts);
      case '.xlsx':
      case '.xls':
      case '.xlsm':
      case '.xlsb':
        return readExcel(resolved, opts);
      case '.csv':
        return readCsv(resolved, opts);
      case '.md':
      case '.txt':
      case '.rst':
        return readText(resolved, opts);
      default:
        return readText(resolved, opts);
    }
  } catch (err) {
    return {
      success: false,
      content: '',
      error: `Failed to read ${ext} file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function readPdf(filePath: string, opts?: DocumentReadOptions): Promise<DocumentResult> {
  try {
    const pdfParseModule = (await import('pdf-parse')) as unknown as {
      default?: (buf: Buffer) => Promise<{ text: string; numpages: number }>;
    };
    const pdfParse =
      pdfParseModule.default ??
      ((buffer: Buffer) =>
        Promise.reject(new Error(`Unable to load pdf-parse for ${buffer.byteLength} bytes`)));
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    const sliced = sliceDocumentContent(data.text, opts);
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
  } catch (err) {
    return {
      success: false,
      content: '',
      error: `PDF parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function readDocx(filePath: string, opts?: DocumentReadOptions): Promise<DocumentResult> {
  try {
    const mammoth = await import('mammoth');
    const buffer = fs.readFileSync(filePath);
    const result = await mammoth.extractRawText({ buffer });
    const sliced = sliceDocumentContent(result.value, opts);
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
  } catch (err) {
    return {
      success: false,
      content: '',
      error: `DOCX parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function readExcel(filePath: string, opts?: DocumentReadOptions): DocumentResult {
  try {
    const XLSX = require('xlsx') as typeof import('xlsx');
    const workbook = XLSX.readFile(filePath, { cellDates: true, cellNF: false, cellText: true });
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

      const rows: string[][] = XLSX.utils.sheet_to_json<string[]>(sheet, {
        header: 1,
        defval: '',
        raw: false,
      });

      const nonEmptyRows = rows.filter((row) =>
        row.some((cell) => String(cell ?? '').trim() !== ''),
      );

      if (nonEmptyRows.length === 0) {
        sections.push(`## Sheet: ${sheetName}\n(empty sheet)`);
        continue;
      }

      const firstRow = (nonEmptyRows[0] ?? []).slice(0, MAX_TABLE_COLS).map(truncateCell);
      const dataRows = nonEmptyRows.slice(1, MAX_TABLE_ROWS + 1).map((row) => row.slice(0, MAX_TABLE_COLS).map(truncateCell));

      const colWidths = firstRow.map((header, index) => {
        const maxData = Math.max(...dataRows.map((row) => String(row[index] ?? '').length));
        return Math.max(String(header).length, maxData, 3);
      });

      const pad = (value: string, width: number) => String(value).padEnd(width);
      const header = `| ${firstRow
        .map((cell, index) => pad(String(cell), colWidths[index] ?? 3))
        .join(' | ')} |`;
      const divider = `| ${colWidths.map((width) => '-'.repeat(width)).join(' | ')} |`;
      const bodyLines = dataRows
        .slice(0, 500)
        .map(
          (row) =>
            `| ${firstRow
              .map((_, index) => pad(String(row[index] ?? ''), colWidths[index] ?? 3))
              .join(' | ')} |`,
        );

      const tableStr = [header, divider, ...bodyLines].join('\n');
      const truncNote =
        nonEmptyRows.length - 1 > MAX_TABLE_ROWS || (nonEmptyRows[0]?.length ?? 0) > MAX_TABLE_COLS
          ? `\n> _(showing ${Math.min(MAX_TABLE_ROWS, Math.max(0, nonEmptyRows.length - 1))} of ${Math.max(0, nonEmptyRows.length - 1)} rows and ${Math.min(MAX_TABLE_COLS, firstRow.length || MAX_TABLE_COLS)} of ${nonEmptyRows[0]?.length ?? 0} columns)_`
          : '';

      sections.push(
        `## Sheet: ${sheetName} (${Math.max(0, nonEmptyRows.length - 1)} rows × ${nonEmptyRows[0]?.length ?? 0} cols)\n\n${tableStr}${truncNote}`,
      );
    }

    const sliced = sliceDocumentContent(sections.join('\n\n---\n\n'), opts);

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
  } catch (err) {
    return {
      success: false,
      content: '',
      error: `Excel parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function readCsv(filePath: string, opts?: DocumentReadOptions): DocumentResult {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');

    if (lines.length === 0) {
      return { success: true, content: '(empty CSV)', format: 'CSV' };
    }

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

    const rows = lines.map(parseCsvLine);
    const firstRow = (rows[0] ?? []).slice(0, MAX_TABLE_COLS).map(truncateCell);
    const dataRows = rows.slice(1, MAX_TABLE_ROWS + 1).map((row) => row.slice(0, MAX_TABLE_COLS).map(truncateCell));

    const colWidths = firstRow.map((header, index) => {
      const maxData = Math.max(...dataRows.map((row) => (row[index] ?? '').length));
      return Math.max(header.length, maxData, 3);
    });

    const pad = (value: string, width: number) => value.padEnd(width);
    const header = `| ${firstRow.map((cell, index) => pad(cell, colWidths[index] ?? 3)).join(' | ')} |`;
    const divider = `| ${colWidths.map((width) => '-'.repeat(width)).join(' | ')} |`;
    const bodyLines = dataRows.map(
      (row) =>
        `| ${firstRow.map((_, index) => pad(row[index] ?? '', colWidths[index] ?? 3)).join(' | ')} |`,
    );

    const truncNote =
      rows.length - 1 > MAX_TABLE_ROWS || (rows[0]?.length ?? 0) > MAX_TABLE_COLS
        ? `\n\n> _(showing ${Math.min(MAX_TABLE_ROWS, Math.max(0, rows.length - 1))} of ${Math.max(0, rows.length - 1)} rows and ${Math.min(MAX_TABLE_COLS, firstRow.length || MAX_TABLE_COLS)} of ${rows[0]?.length ?? 0} columns)_`
        : '';

    const sliced = sliceDocumentContent(
      `## CSV (${Math.max(0, rows.length - 1)} rows × ${rows[0]?.length ?? 0} cols)\n\n${[header, divider, ...bodyLines].join('\n')}${truncNote}`,
      opts,
    );

    return {
      success: true,
      content: sliced.content,
      format: 'CSV',
      pageCount: 1,
      truncated: sliced.truncated,
      totalChars: sliced.totalChars,
      returnedChars: sliced.returnedChars,
      offset: sliced.offset,
      ...(typeof sliced.nextOffset === 'number' ? { nextOffset: sliced.nextOffset } : {}),
      hasMore: sliced.hasMore,
    };
  } catch (err) {
    return {
      success: false,
      content: '',
      error: `CSV parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function readText(filePath: string, opts?: DocumentReadOptions): DocumentResult {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const ext = path.extname(filePath).toLowerCase();
    const sliced = sliceDocumentContent(content, opts);
    return {
      success: true,
      content: sliced.content,
      format: ext.slice(1).toUpperCase() || 'TEXT',
      truncated: sliced.truncated,
      totalChars: sliced.totalChars,
      returnedChars: sliced.returnedChars,
      offset: sliced.offset,
      ...(typeof sliced.nextOffset === 'number' ? { nextOffset: sliced.nextOffset } : {}),
      hasMore: sliced.hasMore,
    };
  } catch (err) {
    return {
      success: false,
      content: '',
      error: `Text read error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
