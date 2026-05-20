/**
 * 常见敏感字段名称。
 *
 * 日志写入前会根据这些关键字做脱敏，避免 token、key、secret 等内容进入日志。
 */
const SENSITIVE_KEYWORDS = ["token", "secret", "key", "password", "passwd", "credential", "authorization", "cookie"];

/**
 * 对任意 JSON 可序列化数据进行脱敏。
 *
 * @param value 待脱敏的数据。
 * @returns 脱敏后的数据副本。
 */
export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input)) {
      const normalizedKey = key.toLowerCase();
      const isSensitiveKey = SENSITIVE_KEYWORDS.some((keyword) => normalizedKey.includes(keyword));
      output[key] = isSensitiveKey ? "[已脱敏]" : redactValue(item);
    }
    return output;
  }

  if (typeof value === "string") {
    return redactText(value);
  }

  return value;
}

/**
 * 对文本进行敏感信息脱敏。
 *
 * @param text 原始文本。
 * @returns 脱敏后的文本。
 */
export function redactText(text: string): string {
  return text
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, "[已脱敏:api_key]")
    .replace(/(AKIA[0-9A-Z]{16})/g, "[已脱敏:aws_key]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[已脱敏:bearer]")
    .replace(/([A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Za-z0-9_]*\s*=\s*)[^\s]+/gi, "$1[已脱敏]");
}

/**
 * 将对象转换成脱敏 JSON 字符串。
 *
 * @param value 待序列化对象。
 * @param space 缩进空格数。
 * @returns 脱敏后的 JSON 字符串。
 */
export function redactJsonString(value: unknown, space = 2): string {
  return JSON.stringify(redactValue(value), null, space);
}
