import { basename, extname } from "node:path";

const SAFE_ENV_FILES = new Set([".env.example", ".env.template", ".env.sample"]);
const SENSITIVE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx"]);
const SENSITIVE_NAMES = new Set(["id_rsa", "id_ed25519", "credentials", "secrets"]);

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript JSX",
  ".js": "JavaScript",
  ".jsx": "JavaScript JSX",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".json": "JSON",
  ".md": "Markdown",
  ".py": "Python",
  ".java": "Java",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".go": "Go",
  ".rs": "Rust",
  ".php": "PHP",
  ".cs": "C#",
  ".fs": "F#",
  ".vb": "Visual Basic",
  ".html": "HTML",
  ".css": "CSS",
  ".scss": "SCSS",
  ".vue": "Vue",
  ".sh": "Bash",
  ".bash": "Bash",
  ".ps1": "PowerShell",
  ".psm1": "PowerShell",
  ".yml": "YAML",
  ".yaml": "YAML",
  ".xml": "XML",
  ".toml": "TOML",
  ".tf": "Terraform",
  ".sql": "SQL",
};

const LANGUAGE_BY_NAME: Readonly<Record<string, string>> = {
  dockerfile: "Dockerfile",
  makefile: "Makefile",
  "docker-compose.yml": "Docker Compose",
  "docker-compose.yaml": "Docker Compose",
};

export function extensionOf(path: string): string | undefined {
  const extension = extname(path).toLowerCase();
  return extension === "" ? undefined : extension.slice(1);
}

export function detectLanguage(path: string): string | undefined {
  const fileName = basename(path).toLowerCase();
  return LANGUAGE_BY_NAME[fileName] ?? LANGUAGE_BY_EXTENSION[extname(fileName)];
}

export function isSensitiveFile(path: string): boolean {
  const fileName = basename(path).toLowerCase();
  if (SAFE_ENV_FILES.has(fileName)) {
    return false;
  }
  if (fileName === ".env" || fileName.startsWith(".env.")) {
    return true;
  }
  if (SENSITIVE_EXTENSIONS.has(extname(fileName))) {
    return true;
  }
  if (SENSITIVE_NAMES.has(fileName)) {
    return true;
  }
  return fileName.startsWith("credentials.") || fileName.startsWith("secrets.");
}
