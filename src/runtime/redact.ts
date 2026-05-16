/** 敏感字段名正则。 */
const sensitiveKeyPattern = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|private[_-]?key|access[_-]?key|credential)/i;

/** 常见密钥文本正则。 */
const sensitiveTextPatterns: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(sk-[A-Za-z0-9_-]{10,})/g,
  /(ghp_[A-Za-z0-9_]{20,})/g,
  /(xox[baprs]-[A-Za-z0-9-]+)/g,
  /([A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*=)[^\s]+/gi,
  /([A-Za-z0-9_]*SECRET[A-Za-z0-9_]*=)[^\s]+/gi,
  /([A-Za-z0-9_]*KEY[A-Za-z0-9_]*=)[^\s]+/gi
];

/**
 * 脱敏普通文本。
 */
export function redactText(text: string): string {
  let output = text;
  for (const pattern of sensitiveTextPatterns) {
    output = output.replace(pattern, (match, prefix) => {
      if (typeof prefix === "string" && match.startsWith(prefix)) {
        return `${prefix}[REDACTED]`;
      }
      return "[REDACTED]";
    });
  }
  return output;
}

/**
 * 递归脱敏 JSON 值。
 */
export function redactJson<T>(value: T): T {
  return redactJsonInternal(value, new WeakSet()) as T;
}

/**
 * 递归脱敏 JSON 值的内部实现。
 */
function redactJsonInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactJsonInternal(item, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveKeyPattern.test(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redactJsonInternal(child, seen);
    }
  }
  return output;
}
