export interface WorkspaceServiceOptions {
  root: string;
  maxFileSizeBytes: number;
  maxReadLines: number;
  maxSearchResults: number;
  maxDirectoryDepth: number;
  includeHiddenFiles: boolean;
  respectGitignore: boolean;
  allowSensitiveFiles: boolean;
  gitRunner?: GitCommandRunner;
}

export interface WorkspaceInfo {
  root: string;
  name: string;
  platform: "windows" | "linux" | "macos" | "other";
  gitRepository: boolean;
  gitRoot?: string;
  caseSensitiveFileSystem: boolean;
  respectGitignore: boolean;
  includeHiddenFiles: boolean;
}

export interface ListFilesOptions {
  path?: string;
  recursive?: boolean;
  maxDepth?: number;
  includeDirectories?: boolean;
  extensions?: string[];
}

export interface WorkspaceEntry {
  path: string;
  type: "file" | "directory" | "symlink";
  sizeBytes?: number;
  extension?: string;
}

export interface ListFilesResult {
  path: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
}

export interface ReadFileOptions {
  path: string;
}

export interface ReadFileRangeOptions {
  path: string;
  startLine: number;
  endLine: number;
}

export interface TextFileResult {
  path: string;
  binary: false;
  sha256: string;
  language?: string;
  sizeBytes: number;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  content: string;
}

export interface BinaryFileResult {
  path: string;
  binary: true;
  sha256: string;
  sizeBytes: number;
  message: string;
}

export type ReadFileResult = TextFileResult | BinaryFileResult;
export type ReadFileRangeResult = TextFileResult | BinaryFileResult;

export interface SearchTextOptions {
  query: string;
  path?: string;
  useRegex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  extensions?: string[];
  maxResults?: number;
  contextLines?: number;
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  match: string;
  preview: string;
  before?: string[];
  after?: string[];
}

export interface SearchTextResult {
  query: string;
  matches: SearchMatch[];
  searchedFiles: number;
  skippedFiles: number;
  truncated: boolean;
}

export interface FindFilesOptions {
  name?: string;
  pattern?: string;
  extensions?: string[];
  path?: string;
  maxResults?: number;
}

export interface FindFilesResult {
  files: WorkspaceEntry[];
  truncated: boolean;
}

export interface RepositoryMapOptions {
  path?: string;
  maxDepth?: number;
  includeFileSizes?: boolean;
  includeDetectedLanguages?: boolean;
}

export interface RepositoryMapResult {
  map: string;
  directories: number;
  files: number;
  languages: Record<string, number>;
  truncated: boolean;
}

export type TechnologyConfidence = "high" | "medium" | "low";

export interface DetectedTechnology {
  name: string;
  confidence: TechnologyConfidence;
  evidence: string[];
}

export interface ProjectTechnologyResult {
  technologies: DetectedTechnology[];
}

export interface GitStatusFile {
  path: string;
  indexStatus: string;
  workingTreeStatus: string;
}

export interface GitStatusResult {
  isRepository: boolean;
  root?: string;
  branch?: string;
  head?: string;
  detachedHead?: boolean;
  clean?: boolean;
  ahead?: number;
  behind?: number;
  files?: GitStatusFile[];
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitCommandRunner {
  run(cwd: string, args: readonly string[]): Promise<GitCommandResult>;
}

export interface WorkspaceService {
  getWorkspaceInfo(): Promise<WorkspaceInfo>;
  listFiles(options?: ListFilesOptions): Promise<ListFilesResult>;
  readFile(options: ReadFileOptions): Promise<ReadFileResult>;
  readFileRange(options: ReadFileRangeOptions): Promise<ReadFileRangeResult>;
  searchText(options: SearchTextOptions): Promise<SearchTextResult>;
  findFiles(options?: FindFilesOptions): Promise<FindFilesResult>;
  getRepositoryMap(options?: RepositoryMapOptions): Promise<RepositoryMapResult>;
  detectProjectTechnologies(): Promise<ProjectTechnologyResult>;
  getGitStatus(): Promise<GitStatusResult>;
}
