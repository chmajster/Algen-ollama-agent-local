import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Dirent } from "node:fs";
import { readFile as readFileFromDisk, readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

import { minimatch } from "minimatch";
import safeRegex from "safe-regex2";

import { isBinaryFile } from "./binaryDetector.js";
import {
  FileTooLargeError,
  GitNotAvailableError,
  GitTimeoutError,
  InvalidLineRangeError,
  SearchLimitError,
  SearchPatternError,
  SensitiveFileAccessError,
  UnsupportedEncodingError,
  WorkspaceAccessError,
  WorkspaceError,
} from "./errors.js";
import { detectLanguage, extensionOf, isSensitiveFile } from "./fileClassifier.js";
import { DefaultGitCommandRunner, readGitStatus } from "./gitStatus.js";
import { IgnoreService } from "./ignoreService.js";
import { PathSecurity } from "./pathSecurity.js";
import { detectTechnologies } from "./technologyDetector.js";
import type {
  BinaryFileResult,
  FindFilesOptions,
  FindFilesResult,
  GitStatusResult,
  ListFilesOptions,
  ListFilesResult,
  ProjectTechnologyResult,
  ReadFileOptions,
  ReadFileRangeOptions,
  ReadFileRangeResult,
  ReadFileResult,
  RepositoryMapOptions,
  RepositoryMapResult,
  SearchMatch,
  SearchTextOptions,
  SearchTextResult,
  TextFileResult,
  WorkspaceEntry,
  WorkspaceInfo,
  WorkspaceService,
  WorkspaceServiceOptions,
} from "./workspaceTypes.js";

interface CollectedEntries {
  entries: WorkspaceEntry[];
  truncated: boolean;
}

interface CollectOptions {
  recursive: boolean;
  maxDepth: number;
  includeDirectories: boolean;
  extensions: Set<string> | undefined;
  limit: number;
}

interface TextLine {
  text: string;
  raw: string;
}

interface StreamedLines {
  content: string;
  totalLines: number;
  contentTruncated: boolean;
}

interface TreeNode {
  name: string;
  entry?: WorkspaceEntry;
  children: Map<string, TreeNode>;
}

interface CachedTextFile {
  size: number;
  modifiedMs: number;
  result: TextFileResult;
}

const BINARY_MESSAGE = "Plik binarny nie może zostać odczytany jako tekst.";

function normalizeExtensions(extensions?: string[]): Set<string> | undefined {
  if (extensions === undefined || extensions.length === 0) {
    return undefined;
  }
  return new Set(extensions.map((extension) => extension.replace(/^\./u, "").toLowerCase()));
}

function compareEntries(left: WorkspaceEntry, right: WorkspaceEntry): number {
  const rank: Readonly<Record<WorkspaceEntry["type"], number>> = {
    directory: 0,
    symlink: 1,
    file: 2,
  };
  return (
    rank[left.type] - rank[right.type] ||
    left.path.localeCompare(right.path, undefined, { sensitivity: "base" })
  );
}

function decodeUtf8(buffer: Uint8Array, path: string): string {
  const withoutBom =
    buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
      ? buffer.subarray(3)
      : buffer;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(withoutBom);
  } catch (error: unknown) {
    throw new UnsupportedEncodingError(path, { cause: error });
  }
}

function splitText(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== "\n" && character !== "\r") {
      continue;
    }
    const endLength = character === "\r" && text[index + 1] === "\n" ? 2 : 1;
    const end = index + endLength;
    lines.push({ text: text.slice(start, index), raw: text.slice(start, end) });
    start = end;
    index = end - 1;
  }
  if (start < text.length) {
    lines.push({ text: text.slice(start), raw: text.slice(start) });
  }
  return lines;
}

function platformName(): WorkspaceInfo["platform"] {
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return "linux";
  if (process.platform === "darwin") return "macos";
  return "other";
}

function logicalJoin(parent: string, child: string): string {
  return parent === "." ? child : `${parent}/${child}`;
}

function relativeLogical(base: string, path: string): string {
  if (base === ".") return path;
  if (path === base) return "";
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function clippedLine(value: string): string {
  return value.length <= 1_000 ? value : `${value.slice(0, 1_000)}… [skrócono]`;
}

function hashBytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  try {
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    stream.destroy();
  }
}

async function binaryResult(
  path: string,
  realPath: string,
  sizeBytes: number,
): Promise<BinaryFileResult> {
  return {
    path,
    binary: true,
    sha256: await hashFile(realPath),
    sizeBytes,
    message: BINARY_MESSAGE,
  };
}

function assertGlobIsSafe(pattern: string): void {
  const logical = pattern.replaceAll("\\", "/");
  if (isAbsolute(pattern) || logical.split("/").includes("..")) {
    throw new SearchPatternError("Wzorzec glob nie może wychodzić poza workspace.");
  }
}

export class LocalWorkspaceService implements WorkspaceService {
  private readonly textFileCache = new Map<string, CachedTextFile>();

  private constructor(
    private readonly options: WorkspaceServiceOptions,
    private readonly paths: PathSecurity,
    private readonly ignores: IgnoreService,
  ) {}

  public static async create(options: WorkspaceServiceOptions): Promise<LocalWorkspaceService> {
    const paths = await PathSecurity.create(options.root);
    const normalizedOptions = { ...options, root: paths.root };
    return new LocalWorkspaceService(
      normalizedOptions,
      paths,
      new IgnoreService({
        root: paths.root,
        respectGitignore: options.respectGitignore,
        includeHiddenFiles: options.includeHiddenFiles,
      }),
    );
  }

  private assertDirectReadAllowed(path: string): void {
    if (this.ignores.isAlwaysBlockedPath(path)) {
      throw new WorkspaceAccessError("Bezpośredni odczyt katalogu .git jest zablokowany.");
    }
    if (!this.options.allowSensitiveFiles && isSensitiveFile(path)) {
      throw new SensitiveFileAccessError(path);
    }
  }

  private async collectEntries(path: string, options: CollectOptions): Promise<CollectedEntries> {
    const start = await this.paths.resolveDirectory(path);
    const entries: WorkspaceEntry[] = [];
    let truncated = false;

    const visit = async (
      absoluteDirectory: string,
      relativeDirectory: string,
      depth: number,
    ): Promise<void> => {
      if (entries.length >= options.limit) {
        truncated = true;
        return;
      }
      await this.ignores.loadRulesForDirectory(absoluteDirectory, relativeDirectory);
      let children: Dirent[];
      try {
        children = await readdir(absoluteDirectory, { withFileTypes: true });
      } catch (error: unknown) {
        throw new WorkspaceAccessError("Nie można odczytać katalogu w workspace.", {
          cause: error,
        });
      }
      children.sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
      );

      for (const child of children) {
        const childRelative = logicalJoin(relativeDirectory, child.name);
        const isDirectory = child.isDirectory();
        if (this.ignores.isIgnored(childRelative, isDirectory)) {
          continue;
        }
        if (entries.length >= options.limit) {
          truncated = true;
          return;
        }

        const childAbsolute = join(absoluteDirectory, child.name);
        if (child.isSymbolicLink()) {
          entries.push({ path: childRelative, type: "symlink" });
          continue;
        }
        if (isDirectory) {
          if (options.includeDirectories) {
            entries.push({ path: childRelative, type: "directory" });
          }
          if (options.recursive && depth < options.maxDepth) {
            await visit(childAbsolute, childRelative, depth + 1);
          }
          continue;
        }
        if (!child.isFile()) {
          continue;
        }
        const extension = extensionOf(child.name);
        if (options.extensions !== undefined && !options.extensions.has(extension ?? "")) {
          continue;
        }
        const fileStats = await stat(childAbsolute);
        entries.push({
          path: childRelative,
          type: "file",
          sizeBytes: fileStats.size,
          ...(extension === undefined ? {} : { extension }),
        });
      }
    };

    await visit(start.realPath, start.relativePath, 1);
    entries.sort(compareEntries);
    return { entries, truncated };
  }

  private async readSmallText(path: string): Promise<string | undefined> {
    try {
      const resolved = await this.paths.resolveFile(path);
      this.assertDirectReadAllowed(resolved.relativePath);
      const fileStats = await stat(resolved.realPath);
      if (fileStats.size > Math.min(this.options.maxFileSizeBytes, 128 * 1024)) {
        return undefined;
      }
      if (await isBinaryFile(resolved.realPath)) {
        return undefined;
      }
      return decodeUtf8(await readFileFromDisk(resolved.realPath), resolved.relativePath);
    } catch (error: unknown) {
      if (error instanceof WorkspaceError) {
        return undefined;
      }
      throw error;
    }
  }

  private async knownHiddenTechnologyFiles(): Promise<string[]> {
    const files: string[] = [];
    for (const path of [".gitlab-ci.yml", ".gitlab-ci.yaml"]) {
      try {
        files.push((await this.paths.resolveFile(path)).relativePath);
      } catch (error: unknown) {
        if (!(error instanceof WorkspaceError)) throw error;
      }
    }
    try {
      const workflows = await this.paths.resolveDirectory(".github/workflows");
      const entries = await readdir(workflows.realPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && /\.ya?ml$/iu.test(entry.name)) {
          files.push(logicalJoin(workflows.relativePath, entry.name));
        }
      }
    } catch (error: unknown) {
      if (!(error instanceof WorkspaceError)) throw error;
    }
    return files;
  }

  private async streamLineRange(
    path: string,
    displayPath: string,
    startLine: number,
    endLine: number,
  ): Promise<StreamedLines> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
    const maxSelectedChars = this.options.maxFileSizeBytes;
    let carry = "";
    let currentLine = 1;
    let totalLines = 0;
    let selected = "";
    let lineHasContent = false;
    let contentTruncated = false;

    const appendSelected = (value: string): void => {
      if (currentLine < startLine || currentLine > endLine || value === "") return;
      const remaining = maxSelectedChars - selected.length;
      if (remaining <= 0) {
        contentTruncated = true;
        return;
      }
      selected += value.slice(0, remaining);
      if (value.length > remaining) contentTruncated = true;
    };

    const consume = (decoded: string, final: boolean): void => {
      let value = carry + decoded;
      carry = "";
      if (!final && value.endsWith("\r")) {
        carry = "\r";
        value = value.slice(0, -1);
      }

      const endings = /\r\n|\r|\n/gu;
      let cursor = 0;
      let ending: RegExpExecArray | null;
      while ((ending = endings.exec(value)) !== null) {
        const segment = value.slice(cursor, ending.index);
        if (segment !== "") lineHasContent = true;
        appendSelected(segment);
        appendSelected(ending[0]);
        totalLines += 1;
        currentLine += 1;
        lineHasContent = false;
        cursor = ending.index + ending[0].length;
      }

      const remainder = value.slice(cursor);
      if (remainder !== "") lineHasContent = true;
      appendSelected(remainder);
      if (final && lineHasContent) {
        totalLines += 1;
      }
    };

    try {
      for await (const chunk of stream) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        consume(decoder.decode(bytes, { stream: true }), false);
      }
      consume(decoder.decode(), true);
      return { content: selected, totalLines, contentTruncated };
    } catch (error: unknown) {
      if (error instanceof TypeError) {
        throw new UnsupportedEncodingError(displayPath, { cause: error });
      }
      throw new WorkspaceAccessError("Nie można odczytać wskazanego zakresu pliku.", {
        cause: error,
      });
    } finally {
      stream.destroy();
    }
  }

  public async getWorkspaceInfo(): Promise<WorkspaceInfo> {
    let gitStatus: GitStatusResult = { isRepository: false };
    try {
      gitStatus = await this.getGitStatus();
    } catch (error: unknown) {
      if (!(error instanceof GitNotAvailableError) && !(error instanceof GitTimeoutError)) {
        throw error;
      }
    }
    return {
      root: this.options.root,
      name: basename(this.options.root),
      platform: platformName(),
      gitRepository: gitStatus.isRepository,
      ...(gitStatus.root === undefined ? {} : { gitRoot: gitStatus.root }),
      caseSensitiveFileSystem: process.platform !== "win32" && process.platform !== "darwin",
      respectGitignore: this.options.respectGitignore,
      includeHiddenFiles: this.options.includeHiddenFiles,
    };
  }

  public async listFiles(options: ListFilesOptions = {}): Promise<ListFilesResult> {
    const path = options.path ?? ".";
    const recursive = options.recursive ?? false;
    const maxDepth = Math.min(
      options.maxDepth ?? (recursive ? 3 : 1),
      this.options.maxDirectoryDepth,
    );
    const result = await this.collectEntries(path, {
      recursive,
      maxDepth,
      includeDirectories: options.includeDirectories ?? true,
      extensions: normalizeExtensions(options.extensions),
      limit: this.options.maxSearchResults,
    });
    return { path: (await this.paths.resolveDirectory(path)).relativePath, ...result };
  }

  public async readFile(options: ReadFileOptions): Promise<ReadFileResult> {
    const resolved = await this.paths.resolveFile(options.path);
    this.assertDirectReadAllowed(resolved.relativePath);
    const fileStats = await stat(resolved.realPath);
    if (await isBinaryFile(resolved.realPath)) {
      return binaryResult(resolved.relativePath, resolved.realPath, fileStats.size);
    }
    if (fileStats.size > this.options.maxFileSizeBytes) {
      throw new FileTooLargeError(
        resolved.relativePath,
        fileStats.size,
        this.options.maxFileSizeBytes,
      );
    }

    const cached = this.textFileCache.get(resolved.relativePath);
    if (
      cached !== undefined &&
      cached.size === fileStats.size &&
      cached.modifiedMs === fileStats.mtimeMs
    ) {
      return { ...cached.result };
    }

    const bytes = await readFileFromDisk(resolved.realPath);
    const text = decodeUtf8(bytes, resolved.relativePath);
    const lines = splitText(text);
    const selectedLines = lines.slice(0, this.options.maxReadLines);
    const language = detectLanguage(resolved.relativePath);
    const result: TextFileResult = {
      path: resolved.relativePath,
      binary: false,
      sha256: hashBytes(bytes),
      ...(language === undefined ? {} : { language }),
      sizeBytes: fileStats.size,
      totalLines: lines.length,
      startLine: lines.length === 0 ? 0 : 1,
      endLine: selectedLines.length,
      truncated: selectedLines.length < lines.length,
      content: selectedLines.map((line) => line.raw).join(""),
    };
    this.textFileCache.delete(resolved.relativePath);
    this.textFileCache.set(resolved.relativePath, {
      size: fileStats.size,
      modifiedMs: fileStats.mtimeMs,
      result,
    });
    if (this.textFileCache.size > 32) {
      const oldest = this.textFileCache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.textFileCache.delete(oldest);
    }
    return { ...result };
  }

  public async readFileRange(options: ReadFileRangeOptions): Promise<ReadFileRangeResult> {
    if (options.startLine < 1 || options.endLine < options.startLine) {
      throw new InvalidLineRangeError(
        "Zakres linii jest nieprawidłowy: startLine musi być >= 1, a endLine >= startLine.",
      );
    }
    if (options.endLine - options.startLine + 1 > this.options.maxReadLines) {
      throw new InvalidLineRangeError(
        `Zakres nie może przekraczać ${this.options.maxReadLines} linii.`,
      );
    }

    const resolved = await this.paths.resolveFile(options.path);
    this.assertDirectReadAllowed(resolved.relativePath);
    const fileStats = await stat(resolved.realPath);
    if (await isBinaryFile(resolved.realPath)) {
      return binaryResult(resolved.relativePath, resolved.realPath, fileStats.size);
    }
    const streamed = await this.streamLineRange(
      resolved.realPath,
      resolved.relativePath,
      options.startLine,
      options.endLine,
    );
    const actualStart =
      streamed.totalLines === 0 ? 0 : Math.min(options.startLine, streamed.totalLines);
    const actualEnd = Math.min(options.endLine, streamed.totalLines);
    const language = detectLanguage(resolved.relativePath);
    return {
      path: resolved.relativePath,
      binary: false,
      sha256: await hashFile(resolved.realPath),
      ...(language === undefined ? {} : { language }),
      sizeBytes: fileStats.size,
      totalLines: streamed.totalLines,
      startLine: actualStart,
      endLine: actualEnd,
      truncated: actualStart > 1 || actualEnd < streamed.totalLines || streamed.contentTruncated,
      content: streamed.content,
    };
  }

  public async searchText(options: SearchTextOptions): Promise<SearchTextResult> {
    if (options.query === "") {
      throw new SearchPatternError("Wzorzec wyszukiwania nie może być pusty.");
    }
    const requestedLimit = options.maxResults ?? 50;
    if (requestedLimit < 1) {
      throw new SearchLimitError(this.options.maxSearchResults);
    }
    const maxResults = Math.min(requestedLimit, this.options.maxSearchResults);
    const contextLines = Math.min(Math.max(options.contextLines ?? 1, 0), 10);
    const source =
      options.useRegex === true ? options.query : escapeRegularExpression(options.query);
    const expression = options.wholeWord === true ? `\\b(?:${source})\\b` : source;
    if (expression.length > 500 || (options.useRegex === true && !safeRegex(expression))) {
      throw new SearchPatternError(
        "Wyrażenie regularne jest zbyt złożone lub potencjalnie kosztowne.",
      );
    }

    let regex: RegExp;
    try {
      regex = new RegExp(expression, options.caseSensitive === true ? "gu" : "giu");
    } catch (error: unknown) {
      throw new SearchPatternError("Wyrażenie regularne jest nieprawidłowe.", { cause: error });
    }

    const candidates = await this.collectEntries(options.path ?? ".", {
      recursive: true,
      maxDepth: this.options.maxDirectoryDepth,
      includeDirectories: false,
      extensions: normalizeExtensions(options.extensions),
      limit: 10_000,
    });
    const matches: SearchMatch[] = [];
    let searchedFiles = 0;
    let skippedFiles = 0;
    let truncated = candidates.truncated;

    for (const entry of candidates.entries) {
      if (entry.type !== "file") continue;
      if (
        (!this.options.allowSensitiveFiles && isSensitiveFile(entry.path)) ||
        (entry.sizeBytes ?? 0) > this.options.maxFileSizeBytes
      ) {
        skippedFiles += 1;
        continue;
      }
      const resolved = await this.paths.resolveFile(entry.path);
      if (await isBinaryFile(resolved.realPath)) {
        skippedFiles += 1;
        continue;
      }
      let text: string;
      try {
        text = decodeUtf8(await readFileFromDisk(resolved.realPath), entry.path);
      } catch (error: unknown) {
        if (error instanceof UnsupportedEncodingError) {
          skippedFiles += 1;
          continue;
        }
        throw error;
      }
      searchedFiles += 1;
      const lines = splitText(text).map((line) => line.text);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex] ?? "";
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(line)) !== null) {
          const before = lines
            .slice(Math.max(0, lineIndex - contextLines), lineIndex)
            .map(clippedLine);
          const after = lines.slice(lineIndex + 1, lineIndex + contextLines + 1).map(clippedLine);
          if (line.length > 1_000 || match[0].length > 1_000) truncated = true;
          matches.push({
            path: entry.path,
            line: lineIndex + 1,
            column: match.index + 1,
            match: clippedLine(match[0]),
            preview: clippedLine(line),
            ...(before.length === 0 ? {} : { before }),
            ...(after.length === 0 ? {} : { after }),
          });
          if (matches.length >= maxResults) {
            truncated = true;
            return { query: options.query, matches, searchedFiles, skippedFiles, truncated };
          }
          if (match[0] === "") regex.lastIndex += 1;
        }
      }
    }
    return { query: options.query, matches, searchedFiles, skippedFiles, truncated };
  }

  public async findFiles(options: FindFilesOptions = {}): Promise<FindFilesResult> {
    if (options.pattern !== undefined) assertGlobIsSafe(options.pattern);
    const requestedLimit = options.maxResults ?? 50;
    if (requestedLimit < 1) throw new SearchLimitError(this.options.maxSearchResults);
    const limit = Math.min(requestedLimit, this.options.maxSearchResults);
    const candidates = await this.collectEntries(options.path ?? ".", {
      recursive: true,
      maxDepth: this.options.maxDirectoryDepth,
      includeDirectories: false,
      extensions: normalizeExtensions(options.extensions),
      limit: 10_000,
    });
    const name = options.name?.toLowerCase();
    const files = candidates.entries
      .filter((entry) => entry.type === "file")
      .filter((entry) => name === undefined || basename(entry.path).toLowerCase().includes(name))
      .filter(
        (entry) =>
          options.pattern === undefined ||
          minimatch(entry.path, options.pattern, {
            dot: this.options.includeHiddenFiles,
            nocase: process.platform === "win32",
          }),
      );
    const truncated = candidates.truncated || files.length > limit;
    return { files: files.slice(0, limit), truncated };
  }

  public async getRepositoryMap(options: RepositoryMapOptions = {}): Promise<RepositoryMapResult> {
    const path = options.path ?? ".";
    const root = await this.paths.resolveDirectory(path);
    const result = await this.collectEntries(path, {
      recursive: true,
      maxDepth: Math.min(options.maxDepth ?? 4, this.options.maxDirectoryDepth),
      includeDirectories: true,
      extensions: undefined,
      limit: Math.max(this.options.maxSearchResults, 500),
    });
    const tree: TreeNode = { name: basename(root.realPath), children: new Map() };
    for (const entry of result.entries) {
      const localPath = relativeLogical(root.relativePath, entry.path);
      if (localPath === "") continue;
      const components = localPath.split("/");
      let current = tree;
      for (const component of components) {
        let child = current.children.get(component);
        if (child === undefined) {
          child = { name: component, children: new Map() };
          current.children.set(component, child);
        }
        current = child;
      }
      current.entry = entry;
    }

    const render = (node: TreeNode, prefix = ""): string[] => {
      const children = [...node.children.values()].sort((left, right) => {
        const leftDirectory = left.entry?.type === "directory" || left.children.size > 0;
        const rightDirectory = right.entry?.type === "directory" || right.children.size > 0;
        return (
          Number(rightDirectory) - Number(leftDirectory) ||
          left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
        );
      });
      return children.flatMap((child, index) => {
        const last = index === children.length - 1;
        const connector = last ? "└── " : "├── ";
        const size =
          options.includeFileSizes === true && child.entry?.sizeBytes !== undefined
            ? ` (${child.entry.sizeBytes} B)`
            : "";
        const language =
          options.includeDetectedLanguages === true && child.entry?.type === "file"
            ? ` [${detectLanguage(child.entry.path) ?? "tekst"}]`
            : "";
        const symlink = child.entry?.type === "symlink" ? "@" : "";
        return [
          `${prefix}${connector}${child.name}${symlink}${size}${language}`,
          ...render(child, `${prefix}${last ? "    " : "│   "}`),
        ];
      });
    };

    const languages: Record<string, number> = {};
    let directories = 0;
    let files = 0;
    for (const entry of result.entries) {
      if (entry.type === "directory") directories += 1;
      if (entry.type === "file") {
        files += 1;
        const language = detectLanguage(entry.path);
        if (language !== undefined) languages[language] = (languages[language] ?? 0) + 1;
      }
    }
    return {
      map: [`${tree.name}/`, ...render(tree)].join("\n"),
      directories,
      files,
      languages: Object.fromEntries(
        Object.entries(languages).sort(([left], [right]) => left.localeCompare(right)),
      ),
      truncated: result.truncated,
    };
  }

  public async detectProjectTechnologies(): Promise<ProjectTechnologyResult> {
    const candidates = await this.collectEntries(".", {
      recursive: true,
      maxDepth: this.options.maxDirectoryDepth,
      includeDirectories: false,
      extensions: undefined,
      limit: 10_000,
    });
    const hiddenTechnologyFiles = await this.knownHiddenTechnologyFiles();
    return detectTechnologies({
      files: [
        ...new Set([
          ...candidates.entries.filter((entry) => entry.type === "file").map((entry) => entry.path),
          ...hiddenTechnologyFiles,
        ]),
      ],
      readSmallText: (path) => this.readSmallText(path),
    });
  }

  public async getGitStatus(): Promise<GitStatusResult> {
    return readGitStatus(
      this.options.root,
      this.options.gitRunner ?? new DefaultGitCommandRunner(),
    );
  }
}
