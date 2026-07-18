import type { SanitizedCiLog } from "./ciTypes.js";

/* eslint-disable no-control-regex -- sekwencje ANSI są danymi, które celowo usuwamy z logu CI. */
const ANSI = new RegExp(
  "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
  "g",
);
/* eslint-enable no-control-regex */
const INJECTION =
  /(?:ignore|disregard|override).{0,40}(?:instruction|prompt|policy)|(?:reveal|print|exfiltrate).{0,30}(?:secret|token|password)|force[- ]push|curl\s+https?:|powershell\s+-/i;

const SECRET_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /\b(?:gh[opurs]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: "Bearer [REDACTED]" },
  { pattern: /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, replacement: "Basic [REDACTED]" },
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replacement: "[REDACTED_AWS_ACCESS_KEY]" },
  {
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    pattern: /\b(?:Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi,
    replacement: "$1: [REDACTED]",
  },
  {
    pattern: /\b(?:password|passwd|pwd|client_secret|access_token)\s*[=:]\s*[^\s;]+/gi,
    replacement: "$1=[REDACTED]",
  },
  {
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s]+/gi,
    replacement: "[REDACTED_CONNECTION_STRING]",
  },
  { pattern: /\b(?:AccountKey|SharedAccessSignature)=[^;\s]+/gi, replacement: "$1=[REDACTED]" },
];

function redact(value: string): { content: string; redactions: number } {
  let content = value;
  let redactions = 0;
  for (const item of SECRET_PATTERNS) {
    content = content.replace(item.pattern, (...args: unknown[]) => {
      redactions += 1;
      const match = String(args[0]);
      if (item.replacement.includes("$1")) {
        const label = /^([A-Za-z-]+)/.exec(match)?.[1] ?? "secret";
        return item.replacement.replace("$1", label);
      }
      return item.replacement;
    });
  }
  return { content, redactions };
}

function deduplicate(lines: readonly string[]): { lines: string[]; removed: number } {
  const result: string[] = [];
  let previous = "";
  let repeats = 0;
  let removed = 0;
  for (const line of lines) {
    if (line === previous && line.trim() !== "") {
      repeats += 1;
      if (repeats > 2) {
        removed += 1;
        continue;
      }
    } else {
      previous = line;
      repeats = 0;
    }
    result.push(line);
  }
  return { lines: result, removed };
}

function errorBlocks(lines: readonly string[]): string[] {
  const indexes = lines
    .map((line, index) =>
      /\b(error|failed|failure|exception|fatal|panic|assertion)\b/i.test(line) ? index : -1,
    )
    .filter((index) => index >= 0)
    .slice(0, 20);
  const blocks = new Set<string>();
  for (const index of indexes) {
    blocks.add(lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 5)).join("\n"));
  }
  return [...blocks];
}

function truncate(
  content: string,
  blocks: readonly string[],
  maxChars: number,
): { content: string; truncated: boolean } {
  if (content.length <= maxChars) return { content, truncated: false };
  const evidence = blocks.join("\n---\n").slice(0, Math.floor(maxChars * 0.4));
  const available = Math.max(0, maxChars - evidence.length - 80);
  const head = content.slice(0, Math.floor(available / 2));
  const tail = content.slice(-Math.ceil(available / 2));
  return {
    content: `${head}\n...[CI LOG TRUNCATED]...\n${evidence}\n...[CI LOG TAIL]...\n${tail}`.slice(
      0,
      maxChars,
    ),
    truncated: true,
  };
}

export function sanitizeCiLog(raw: string, maxChars = 200_000): SanitizedCiLog {
  const normalized = raw.replace(ANSI, "").replace(/\r\n?/g, "\n").replaceAll("\0", "");
  const redacted = redact(normalized);
  const deduplicated = deduplicate(redacted.content.split("\n"));
  const content = deduplicated.lines.join("\n");
  const blocks = errorBlocks(deduplicated.lines);
  const limited = truncate(content, blocks, maxChars);
  return {
    content: limited.content,
    truncated: limited.truncated,
    redactions: redacted.redactions,
    removedDuplicateLines: deduplicated.removed,
    errorBlocks: blocks,
    promptInjectionWarning: INJECTION.test(content),
  };
}

export function containsRemotePromptInjection(value: string): boolean {
  return INJECTION.test(value);
}
