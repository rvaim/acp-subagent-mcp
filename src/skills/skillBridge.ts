import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AppConfig } from "../config/types.js";
import type { SubagentSkillMode, SubagentSkillOptions } from "../task/types.js";

/**
 * 发现到的单个 Skill 元数据。
 */
export interface DiscoveredSkill {
  /** Skill 名称，优先来自 frontmatter name，缺省使用目录名。 */
  name: string;
  /** Skill 描述，用于低 token 清单。 */
  description: string;
  /** 额外触发说明。 */
  whenToUse?: string;
  /** SKILL.md 绝对路径。 */
  filePath: string;
  /** Skill 所在目录。 */
  dir: string;
  /** 来源类型。 */
  source: "project" | "user" | "extra";
  /** 是否禁止模型自动调用。 */
  disableModelInvocation: boolean;
  /** 原始 SKILL.md 内容。仅 inline 模式按需加载。 */
  content?: string;
}

/**
 * 渲染给子代理的 Skill 上下文。
 */
export interface SkillPromptContext {
  /** 实际注入模式。 */
  mode: SubagentSkillMode;
  /** 所有发现到的可见 Skill 数量。 */
  discoveredCount: number;
  /** 注入到 prompt 的 Skill 清单。 */
  listed: Array<Pick<DiscoveredSkill, "name" | "description" | "whenToUse" | "source">>;
  /** 内联到 prompt 的 Skill 内容。 */
  inlined: Array<{ name: string; filePath: string; content: string; truncated: boolean }>;
  /** 是否因数量或字符预算发生截断。 */
  truncated: boolean;
}

/**
 * 构建父代理 Skill 桥接上下文。
 *
 * 该函数只读取本机文件系统中的 Agent Skills / Claude Code Skills 目录，
 * 不尝试调用主 agent 私有运行时。这样可以兼容所有 ACP 子代理，同时保持安全边界清晰。
 */
export async function buildSkillPromptContext(options: {
  /** 应用配置。 */
  config: AppConfig;
  /** 原始项目工作目录。 */
  cwd: string;
  /** 本次任务的 Skill 选项。 */
  input?: SubagentSkillOptions;
}): Promise<SkillPromptContext> {
  const config = options.config.skills;
  if (!config.enabled) return emptySkillContext("off");

  const mode = options.input?.mode ?? config.default_mode;
  if (mode === "off") return emptySkillContext("off");

  const includeProject = options.input?.include_project ?? config.include_project_skills;
  const includeUser = options.input?.include_user ?? config.include_user_skills;
  const discovered = await discoverSkills({
    cwd: options.cwd,
    includeProject,
    includeUser,
    extraRoots: config.discovery_roots
  });

  const explicitNames = normalizeNames(options.input?.names);
  const configuredNames = normalizeNames(config.default_names);
  const namesForListing = explicitNames.length ? explicitNames : undefined;
  const namesForInline = explicitNames.length ? explicitNames : configuredNames;

  const visible = discovered.filter((skill) => {
    if (namesForListing?.includes(skill.name)) return true;
    return !skill.disableModelInvocation;
  });
  const selectedForList = namesForListing ? visible.filter((skill) => namesForListing.includes(skill.name)) : visible;
  const listed = selectedForList.slice(0, config.max_skills).map((skill) => ({
    name: skill.name,
    description: truncate(joinDescription(skill.description, skill.whenToUse), config.max_description_chars),
    whenToUse: skill.whenToUse ? truncate(skill.whenToUse, config.max_description_chars) : undefined,
    source: skill.source
  }));

  const inlined: SkillPromptContext["inlined"] = [];
  let totalInlineChars = 0;
  let truncated = selectedForList.length > listed.length;

  if (mode === "inline" && namesForInline.length > 0) {
    const selected = discovered.filter((skill) => namesForInline.includes(skill.name));
    for (const skill of selected) {
      const raw = skill.content ?? await readFile(skill.filePath, "utf8");
      const perSkillMax = options.input?.max_skill_chars ?? config.max_skill_chars;
      const totalMax = options.input?.max_total_chars ?? config.max_total_skill_chars;
      const remaining = Math.max(0, totalMax - totalInlineChars);
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const maxChars = Math.min(perSkillMax, remaining);
      const content = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n[TRUNCATED]` : raw;
      totalInlineChars += content.length;
      inlined.push({ name: skill.name, filePath: skill.filePath, content, truncated: raw.length > maxChars });
      if (raw.length > maxChars) truncated = true;
    }
  }

  return {
    mode,
    discoveredCount: discovered.length,
    listed,
    inlined,
    truncated
  };
}


/**
 * 以低 token 形式列出当前 cwd 可见的 Skills。
 */
export async function listVisibleSkills(options: {
  /** 应用配置。 */
  config: AppConfig;
  /** 原始项目工作目录。 */
  cwd: string;
  /** 是否包含项目级 Skills。 */
  includeProject?: boolean;
  /** 是否包含用户级 Skills。 */
  includeUser?: boolean;
  /** 最多返回多少个 Skill。 */
  limit?: number;
}): Promise<Array<Pick<DiscoveredSkill, "name" | "description" | "whenToUse" | "source" | "disableModelInvocation">>> {
  const skillConfig = options.config.skills;
  if (!skillConfig.enabled) return [];
  const discovered = await discoverSkills({
    cwd: options.cwd,
    includeProject: options.includeProject ?? skillConfig.include_project_skills,
    includeUser: options.includeUser ?? skillConfig.include_user_skills,
    extraRoots: skillConfig.discovery_roots
  });
  return discovered.slice(0, options.limit ?? skillConfig.max_skills).map((skill) => ({
    name: skill.name,
    description: truncate(joinDescription(skill.description, skill.whenToUse), skillConfig.max_description_chars),
    whenToUse: skill.whenToUse ? truncate(skill.whenToUse, skillConfig.max_description_chars) : undefined,
    source: skill.source,
    disableModelInvocation: skill.disableModelInvocation
  }));
}

/**
 * 发现项目、用户和额外目录中的 Skills。
 */
async function discoverSkills(options: {
  cwd: string;
  includeProject: boolean;
  includeUser: boolean;
  extraRoots: string[];
}): Promise<DiscoveredSkill[]> {
  const byName = new Map<string, DiscoveredSkill>();

  if (options.includeProject) {
    for (const root of projectSkillRoots(options.cwd).reverse()) {
      for (const skill of await scanSkillRoot(root, "project")) byName.set(skill.name, skill);
    }
  }

  if (options.includeUser) {
    for (const skill of await scanSkillRoot(path.join(os.homedir(), ".claude", "skills"), "user")) {
      byName.set(skill.name, skill);
    }
  }

  for (const root of options.extraRoots) {
    for (const skill of await scanSkillRoot(expandHome(root), "extra")) byName.set(skill.name, skill);
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 计算从 cwd 到根目录沿途的 .claude/skills 目录。
 */
function projectSkillRoots(cwd: string): string[] {
  const roots: string[] = [];
  let current = path.resolve(cwd);
  while (true) {
    roots.push(path.join(current, ".claude", "skills"));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

/**
 * 扫描一个 Skill 根目录。根目录可以是包含多个 Skill 子目录的目录，也可以是单个 Skill 目录。
 */
async function scanSkillRoot(root: string, source: DiscoveredSkill["source"]): Promise<DiscoveredSkill[]> {
  if (!await exists(root)) return [];

  const rootSkill = await readSkillDirectory(root, source);
  if (rootSkill) return [rootSkill];

  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const skills: DiscoveredSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skill = await readSkillDirectory(path.join(root, entry.name), source);
    if (skill) skills.push(skill);
  }
  return skills;
}

/**
 * 读取单个 Skill 目录。支持 SKILL.md 和 skill.md。 */
async function readSkillDirectory(dir: string, source: DiscoveredSkill["source"]): Promise<DiscoveredSkill | undefined> {
  const filePath = await findSkillFile(dir);
  if (!filePath) return undefined;

  const raw = await readFile(filePath, "utf8").catch(() => undefined);
  if (!raw) return undefined;

  const frontmatter = parseFrontmatter(raw);
  const directoryName = path.basename(dir);
  const name = sanitizeSkillName(String(frontmatter.fields.name ?? directoryName)) ?? directoryName;
  const description = String(frontmatter.fields.description ?? firstParagraph(frontmatter.body) ?? "无描述");
  const whenToUse = frontmatter.fields.when_to_use ? String(frontmatter.fields.when_to_use) : undefined;
  const disableModelInvocation = toBoolean(frontmatter.fields["disable-model-invocation"]);

  return {
    name,
    description,
    whenToUse,
    filePath,
    dir,
    source,
    disableModelInvocation,
    content: raw
  };
}

/**
 * 查找 Skill 入口文件。
 */
async function findSkillFile(dir: string): Promise<string | undefined> {
  for (const name of ["SKILL.md", "skill.md"]) {
    const candidate = path.join(dir, name);
    if (await isFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 解析简化 YAML frontmatter。这里只处理常见的一行标量，避免引入 YAML 依赖。 */
function parseFrontmatter(raw: string): { fields: Record<string, unknown>; body: string } {
  if (!raw.startsWith("---")) return { fields: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { fields: {}, body: raw };

  const header = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).trimStart();
  const fields: Record<string, unknown> = {};
  for (const line of header.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();
    fields[key] = parseScalar(value);
  }
  return { fields, body };
}

/**
 * 解析 frontmatter 简单标量。
 */
function parseScalar(value: string): unknown {
  const unquoted = value.replace(/^['"]|['"]$/g, "");
  if (unquoted === "true") return true;
  if (unquoted === "false") return false;
  return unquoted;
}

/**
 * 首段文本作为描述降级来源。 */
function firstParagraph(markdown: string): string | undefined {
  return markdown.split(/\n\s*\n/).map((block) => block.trim()).find(Boolean);
}

/**
 * 清理 Skill 名称。 */
function sanitizeSkillName(name: string): string | undefined {
  const normalized = name.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(normalized) ? normalized : undefined;
}

/**
 * 判断值是否为 true。 */
function toBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * 合并描述和触发条件。 */
function joinDescription(description: string, whenToUse?: string): string {
  return whenToUse ? `${description} 适用场景：${whenToUse}` : description;
}

/**
 * 标准化名称列表。 */
function normalizeNames(names?: string[]): string[] {
  return Array.from(new Set((names ?? []).map((name) => sanitizeSkillName(name)).filter((name): name is string => Boolean(name))));
}

/**
 * 截断文本。 */
function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

/**
 * 空上下文。 */
function emptySkillContext(mode: SubagentSkillMode): SkillPromptContext {
  return { mode, discoveredCount: 0, listed: [], inlined: [], truncated: false };
}

/**
 * 展开用户主目录。 */
function expandHome(value: string): string {
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

/**
 * 判断路径是否存在。 */
async function exists(targetPath: string): Promise<boolean> {
  return stat(targetPath).then(() => true).catch(() => false);
}

/**
 * 判断路径是否为文件。 */
async function isFile(targetPath: string): Promise<boolean> {
  return stat(targetPath).then((item) => item.isFile()).catch(() => false);
}
