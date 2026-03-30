import { useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, Play, Plus } from "lucide-react";
import { postHostMessage } from "@webview/vscode";
import type { WebviewMessage } from "@shared/protocol";

type RichMessageBodyProps = Readonly<{
  content: string;
  tone?: "assistant" | "tool" | "muted";
  compact?: boolean;
}>;

type InlinePart =
  | Readonly<{ type: "text"; value: string }>
  | Readonly<{ type: "code"; value: string }>
  | Readonly<{ type: "strong"; value: string }>
  | Readonly<{ type: "link"; href: string; label: string }>;

type HighlightToken = Readonly<{
  kind:
    | "plain"
    | "comment"
    | "keyword"
    | "string"
    | "number"
    | "property"
    | "operator";
  value: string;
}>;

const INLINE_PATTERN = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s)]+)/g;
const JS_TS_KEYWORDS = /\b(const|let|var|function|return|if|else|for|while|switch|case|break|continue|import|from|export|default|async|await|try|catch|throw|new|class|extends|implements|interface|type|enum|public|private|protected|readonly)\b/g;
const JAVA_KEYWORDS = /\b(public|private|protected|class|interface|enum|extends|implements|static|final|void|new|return|if|else|switch|case|break|continue|try|catch|throw|import|package)\b/g;
const PYTHON_KEYWORDS = /\b(def|class|return|if|elif|else|for|while|try|except|finally|raise|import|from|as|with|async|await|lambda|pass|yield|in|is|not|and|or)\b/g;
const GO_KEYWORDS = /\b(func|package|import|type|struct|interface|return|if|else|switch|case|break|continue|go|defer|range|map|chan|var|const)\b/g;
const RUST_KEYWORDS = /\b(fn|let|mut|pub|impl|trait|struct|enum|match|if|else|loop|while|for|return|use|mod|crate|async|await)\b/g;
const PHP_KEYWORDS = /\b(function|class|public|private|protected|return|if|else|elseif|foreach|while|switch|case|break|continue|namespace|use|new)\b/g;
const JSON_PROPERTY_PATTERN = /^(\s*)"([^"]+)"(\s*:)/;
const JSON_STRING_PATTERN = /"([^"\\]|\\.)*"/g;
const NUMBER_PATTERN = /\b-?(0|[1-9]\d*)(\.\d+)?\b/g;
const BASH_COMMENT_PATTERN = /#.*/;
const BASH_STRING_PATTERN = /("([^"\\]|\\.)*"|'([^'\\]|\\.)*')/g;

function openExternalLink(href: string): void {
  postHostMessage({
    type: "link-open",
    payload: { href },
  } satisfies WebviewMessage);
}

function insertIntoComposer(text: string): void {
  window.dispatchEvent(
    new CustomEvent("galaxy:insert-composer-text", {
      detail: { text },
    }),
  );
}

function parseInlineParts(text: string): readonly InlinePart[] {
  const parts: InlinePart[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(INLINE_PATTERN)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      parts.push(Object.freeze({ type: "text" as const, value: text.slice(lastIndex, start) }));
    }

    if (match[2]) {
      parts.push(Object.freeze({ type: "code" as const, value: match[2] }));
    } else if (match[4]) {
      parts.push(Object.freeze({ type: "strong" as const, value: match[4] }));
    } else if (match[6] && match[7]) {
      parts.push(Object.freeze({ type: "link" as const, label: match[6], href: match[7] }));
    } else if (match[8]) {
      parts.push(Object.freeze({ type: "link" as const, label: match[8], href: match[8] }));
    }

    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(Object.freeze({ type: "text" as const, value: text.slice(lastIndex) }));
  }

  return parts;
}

function highlightJsonLine(line: string): readonly HighlightToken[] {
  const propertyMatch = line.match(JSON_PROPERTY_PATTERN);
  if (propertyMatch) {
    const prefix = propertyMatch[1] ?? "";
    const property = `"${propertyMatch[2] ?? ""}"`;
    const suffix = propertyMatch[3] ?? ":";
    const rest = line.slice(propertyMatch[0].length);
    return Object.freeze([
      { kind: "plain", value: prefix },
      { kind: "property", value: property },
      { kind: "operator", value: suffix },
      ...highlightJsonLine(rest),
    ]);
  }

  const tokens: HighlightToken[] = [];
  let index = 0;
  for (const match of line.matchAll(JSON_STRING_PATTERN)) {
    const start = match.index ?? 0;
    if (start > index) {
      const before = line.slice(index, start);
      let last = 0;
      for (const numberMatch of before.matchAll(NUMBER_PATTERN)) {
        const numberStart = numberMatch.index ?? 0;
        if (numberStart > last) {
          tokens.push({ kind: "plain", value: before.slice(last, numberStart) });
        }
        tokens.push({ kind: "number", value: numberMatch[0] });
        last = numberStart + numberMatch[0].length;
      }
      if (last < before.length) {
        tokens.push({ kind: "plain", value: before.slice(last) });
      }
    }
    tokens.push({ kind: "string", value: match[0] });
    index = start + match[0].length;
  }

  if (index < line.length) {
    const tail = line.slice(index);
    let last = 0;
    for (const numberMatch of tail.matchAll(NUMBER_PATTERN)) {
      const numberStart = numberMatch.index ?? 0;
      if (numberStart > last) {
        tokens.push({ kind: "plain", value: tail.slice(last, numberStart) });
      }
      tokens.push({ kind: "number", value: numberMatch[0] });
      last = numberStart + numberMatch[0].length;
    }
    if (last < tail.length) {
      tokens.push({ kind: "plain", value: tail.slice(last) });
    }
  }

  return Object.freeze(tokens);
}

function highlightJsTsLine(line: string): readonly HighlightToken[] {
  return highlightKeywordLine(line, JS_TS_KEYWORDS, "//");
}

function highlightKeywordLine(
  line: string,
  keywordPattern: RegExp,
  commentPrefix: string
): readonly HighlightToken[] {
  const tokens: HighlightToken[] = [];
  const commentIndex = line.indexOf(commentPrefix);
  const source = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
  let cursor = 0;
  const patterns = [
    { kind: "string" as const, regex: /("([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`)/g },
    { kind: "number" as const, regex: NUMBER_PATTERN },
    { kind: "keyword" as const, regex: keywordPattern },
  ];

  while (cursor < source.length) {
    let bestMatch: { start: number; end: number; kind: HighlightToken["kind"]; value: string } | null = null;

    for (const pattern of patterns) {
      pattern.regex.lastIndex = cursor;
      const match = pattern.regex.exec(source);
      if (!match) {
        continue;
      }
      const start = match.index;
      const end = start + match[0].length;
      if (!bestMatch || start < bestMatch.start) {
        bestMatch = { start, end, kind: pattern.kind, value: match[0] };
      }
    }

    if (!bestMatch) {
      tokens.push({ kind: "plain", value: source.slice(cursor) });
      cursor = source.length;
      break;
    }

    if (bestMatch.start > cursor) {
      tokens.push({ kind: "plain", value: source.slice(cursor, bestMatch.start) });
    }
    tokens.push({ kind: bestMatch.kind, value: bestMatch.value });
    cursor = bestMatch.end;
  }

  if (commentIndex >= 0) {
    tokens.push({ kind: "comment", value: line.slice(commentIndex) });
  }

  return Object.freeze(tokens);
}

function highlightPythonLine(line: string): readonly HighlightToken[] {
  return highlightKeywordLine(line, PYTHON_KEYWORDS, "#");
}

function highlightJavaLine(line: string): readonly HighlightToken[] {
  return highlightKeywordLine(line, JAVA_KEYWORDS, "//");
}

function highlightGoLine(line: string): readonly HighlightToken[] {
  return highlightKeywordLine(line, GO_KEYWORDS, "//");
}

function highlightRustLine(line: string): readonly HighlightToken[] {
  return highlightKeywordLine(line, RUST_KEYWORDS, "//");
}

function highlightPhpLine(line: string): readonly HighlightToken[] {
  return highlightKeywordLine(line, PHP_KEYWORDS, "//");
}

function highlightBashLine(line: string): readonly HighlightToken[] {
  const commentMatch = line.match(BASH_COMMENT_PATTERN);
  const commentIndex = commentMatch?.index ?? -1;
  const source = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
  const tokens: HighlightToken[] = [];
  let cursor = 0;

  for (const match of source.matchAll(BASH_STRING_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      const chunk = source.slice(cursor, start);
      tokens.push(...chunk.split(/(\s+|\|+|&&|;)/).filter(Boolean).map((value, index) => {
        if (/^\s+$/.test(value)) {
          return { kind: "plain" as const, value };
        }
        if (/^(\||&&|;)$/.test(value)) {
          return { kind: "operator" as const, value };
        }
        if (index === 0 && value.trim()) {
          return { kind: "keyword" as const, value };
        }
        if (value.startsWith("-")) {
          return { kind: "property" as const, value };
        }
        return { kind: "plain" as const, value };
      }));
    }

    tokens.push({ kind: "string", value: match[0] });
    cursor = start + match[0].length;
  }

  if (cursor < source.length) {
    const tail = source.slice(cursor);
    tokens.push(...tail.split(/(\s+|\|+|&&|;)/).filter(Boolean).map((value, index) => {
      if (/^\s+$/.test(value)) {
        return { kind: "plain" as const, value };
      }
      if (/^(\||&&|;)$/.test(value)) {
        return { kind: "operator" as const, value };
      }
      if (tokens.length === 0 && index === 0 && value.trim()) {
        return { kind: "keyword" as const, value };
      }
      if (value.startsWith("-")) {
        return { kind: "property" as const, value };
      }
      return { kind: "plain" as const, value };
    }));
  }

  if (commentIndex >= 0) {
    tokens.push({ kind: "comment", value: line.slice(commentIndex) });
  }

  return Object.freeze(tokens);
}

function highlightCode(language: string, code: string): readonly (readonly HighlightToken[])[] {
  const normalized = language.toLowerCase();
  const lines = code.split("\n");

  if (normalized === "json") {
    return Object.freeze(lines.map((line) => highlightJsonLine(line)));
  }

  if (normalized === "bash" || normalized === "sh" || normalized === "zsh" || normalized === "shell") {
    return Object.freeze(lines.map((line) => highlightBashLine(line)));
  }

  if (normalized === "js" || normalized === "javascript" || normalized === "ts" || normalized === "typescript") {
    return Object.freeze(lines.map((line) => highlightJsTsLine(line)));
  }

  if (normalized === "java") {
    return Object.freeze(lines.map((line) => highlightJavaLine(line)));
  }

  if (normalized === "python" || normalized === "py") {
    return Object.freeze(lines.map((line) => highlightPythonLine(line)));
  }

  if (normalized === "go" || normalized === "golang") {
    return Object.freeze(lines.map((line) => highlightGoLine(line)));
  }

  if (normalized === "rust" || normalized === "rs") {
    return Object.freeze(lines.map((line) => highlightRustLine(line)));
  }

  if (normalized === "php") {
    return Object.freeze(lines.map((line) => highlightPhpLine(line)));
  }

  return Object.freeze(lines.map((line) => Object.freeze([{ kind: "plain" as const, value: line }])));
}

function tokenClassName(kind: HighlightToken["kind"]): string {
  switch (kind) {
    case "comment":
      return "text-[#6a737d]";
    case "keyword":
      return "text-[#c792ea]";
    case "string":
      return "text-[#c3e88d]";
    case "number":
      return "text-[#f78c6c]";
    case "property":
      return "text-[#82aaff]";
    case "operator":
      return "text-[#89ddff]";
    default:
      return "text-[color:var(--gc-foreground)]";
  }
}

function LinkNode(props: Readonly<{ href: string; label: string }>) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 align-baseline text-[color:var(--gc-accent)] underline decoration-[color:var(--gc-accent)]/40 underline-offset-4 transition-opacity hover:opacity-85"
      onClick={() => openExternalLink(props.href)}
      title={props.href}
    >
      <span className="break-all text-left">{props.label}</span>
      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
    </button>
  );
}

function renderInline(text: string, keyPrefix: string): ReactNode {
  return parseInlineParts(text).map((part, index) => {
    if (part.type === "code") {
      return (
        <code
          key={`${keyPrefix}-code-${index}`}
          className="rounded-md bg-[var(--gc-surface)] px-1.5 py-0.5 font-mono text-[0.92em] text-[color:var(--gc-accent)]"
        >
          {part.value}
        </code>
      );
    }

    if (part.type === "strong") {
      return (
        <strong key={`${keyPrefix}-strong-${index}`} className="font-semibold text-[color:var(--gc-foreground)]">
          {part.value}
        </strong>
      );
    }

    if (part.type === "link") {
      return (
        <LinkNode
          key={`${keyPrefix}-link-${index}`}
          href={part.href}
          label={part.label}
        />
      );
    }

    return <span key={`${keyPrefix}-text-${index}`}>{part.value}</span>;
  });
}

function getToneClassName(tone: RichMessageBodyProps["tone"]): string {
  if (tone === "muted") {
    return "text-[color:var(--gc-muted)]";
  }

  return "text-[color:var(--gc-foreground)]";
}

function CodeActions(props: Readonly<{ code: string; language: string }>) {
  const [copied, setCopied] = useState(false);
  const isShell =
    props.language === "bash" ||
    props.language === "sh" ||
    props.language === "zsh" ||
    props.language === "shell";

  async function copyCode(): Promise<void> {
    try {
      await navigator.clipboard.writeText(props.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  function runInTerminal(): void {
    postHostMessage({
      type: "terminal-snippet-run",
      payload: {
        code: props.code,
        language: props.language || undefined,
      },
    } satisfies WebviewMessage);
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[color:var(--gc-muted)] transition-colors hover:bg-[var(--gc-surface)] hover:text-[color:var(--gc-foreground)]"
        onClick={copyCode}
        title="Sao chép đoạn mã"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[color:var(--gc-muted)] transition-colors hover:bg-[var(--gc-surface)] hover:text-[color:var(--gc-foreground)]"
        onClick={() => insertIntoComposer(props.code)}
        title="Chèn vào ô nhập"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      {isShell ? (
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[color:var(--gc-accent)] transition-colors hover:bg-[var(--gc-accent-soft)]"
          onClick={runInTerminal}
          title="Chạy trong terminal"
        >
          <Play className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export function RichMessageBody(props: RichMessageBodyProps) {
  const blocks = props.content.replace(/\r\n/g, "\n").split(/```/);
  const toneClassName = getToneClassName(props.tone);
  const spacingClassName = props.compact ? "space-y-2" : "space-y-4";
  const bodyClassName = props.compact
    ? "text-[12.5px] leading-6"
    : props.tone === "assistant"
      ? "text-[13.5px] leading-7"
      : "text-[13px] leading-7";

  return (
    <div className={`min-w-0 max-w-full overflow-x-hidden ${toneClassName}`}>
      <div className={`${spacingClassName} ${bodyClassName}`}>
        {blocks.map((block, blockIndex) => {
          const isCodeBlock = blockIndex % 2 === 1;

          if (isCodeBlock) {
            const lines = block.split("\n");
            const language = lines[0]?.trim().toLowerCase() ?? "";
            const code = lines.slice(language ? 1 : 0).join("\n").trimEnd();
            if (!code) {
              return null;
            }

            const highlightedLines = highlightCode(language, code);

            return (
              <div
                key={`code-${blockIndex}`}
                className="overflow-hidden rounded-xl bg-[var(--gc-bg)]"
              >
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 bg-[color:color-mix(in_srgb,var(--gc-surface)_90%,transparent)] px-3 py-2">
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] uppercase tracking-[0.12em] text-[color:var(--gc-muted)]">
                    {language || "mã"}
                  </span>
                  <CodeActions code={code} language={language} />
                </div>
                <pre className="overflow-x-hidden whitespace-pre-wrap break-words p-3 text-[12px] leading-6 text-[color:var(--gc-foreground)]">
                  <code className="block min-w-0 max-w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                    {highlightedLines.map((lineTokens, lineIndex) => (
                      <div
                        key={`line-${blockIndex}-${lineIndex}`}
                        className="min-w-0 max-w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                      >
                        {lineTokens.map((token, tokenIndex) => (
                          <span
                            key={`line-${blockIndex}-${lineIndex}-token-${tokenIndex}`}
                            className={tokenClassName(token.kind)}
                          >
                            {token.value}
                          </span>
                        ))}
                        {lineIndex < highlightedLines.length - 1 ? "\n" : null}
                      </div>
                    ))}
                  </code>
                </pre>
              </div>
            );
          }

          const paragraphs = block
            .split(/\n{2,}/)
            .map((item) => item.trim())
            .filter(Boolean);

          return paragraphs.map((paragraph, paragraphIndex) => {
            const key = `block-${blockIndex}-paragraph-${paragraphIndex}`;
            const lines = paragraph.split("\n");

            if (lines.every((line) => /^(\s*[-*]\s+)/.test(line))) {
              return (
                <ul key={key} className="space-y-1 pl-5">
                  {lines.map((line, lineIndex) => (
                    <li key={`${key}-li-${lineIndex}`} className="list-disc marker:text-[color:var(--gc-muted)]">
                      {renderInline(line.replace(/^\s*[-*]\s+/, ""), `${key}-li-${lineIndex}`)}
                    </li>
                  ))}
                </ul>
              );
            }

            if (lines.every((line) => /^(\s*\d+\.\s+)/.test(line))) {
              return (
                <ol key={key} className="space-y-1 pl-5">
                  {lines.map((line, lineIndex) => (
                    <li key={`${key}-li-${lineIndex}`} className="list-decimal marker:text-[color:var(--gc-muted)]">
                      {renderInline(line.replace(/^\s*\d+\.\s+/, ""), `${key}-li-${lineIndex}`)}
                    </li>
                  ))}
                </ol>
              );
            }

            if (lines.length === 1 && /^#{1,3}\s+/.test(lines[0]!)) {
              const level = (lines[0]!.match(/^#+/)?.[0].length ?? 1);
              const className =
                level === 1
                  ? "text-[17px] font-semibold tracking-[-0.01em]"
                  : level === 2
                    ? "text-[15px] font-semibold tracking-[-0.01em]"
                    : "text-[14px] font-semibold";
              return (
                <div key={key} className={className}>
                  {renderInline(lines[0]!.replace(/^#{1,3}\s+/, ""), key)}
                </div>
              );
            }

            if (lines.every((line) => /^\s*>\s?/.test(line))) {
              return (
                <blockquote
                  key={key}
                  className="border-l-2 border-[color:var(--gc-accent)]/40 pl-3 italic text-[color:var(--gc-muted)]"
                >
                  {lines.map((line, lineIndex) => (
                    <div key={`${key}-quote-${lineIndex}`}>
                      {renderInline(line.replace(/^\s*>\s?/, ""), `${key}-quote-${lineIndex}`)}
                    </div>
                  ))}
                </blockquote>
              );
            }

            return (
              <p key={key} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                {lines.map((line, lineIndex) => (
                  <span key={`${key}-line-${lineIndex}`}>
                    {renderInline(line, `${key}-line-${lineIndex}`)}
                    {lineIndex < lines.length - 1 ? <br /> : null}
                  </span>
                ))}
              </p>
            );
          });
        })}
      </div>
    </div>
  );
}
