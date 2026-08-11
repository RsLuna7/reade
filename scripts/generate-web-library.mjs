import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_SOURCE_DIRECTORY = resolve(PROJECT_ROOT, "examples", "demo-library");
const DEFAULT_OUTPUT_DIRECTORY = resolve(PROJECT_ROOT, "public", "reade-web");
const DEFAULT_SITE_TITLE = "Reade 阅读库";
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);
// Keep publishing explicit. A content directory can contain notes, credentials,
// or editor state that must never become a Pages artifact by accident.
const PUBLIC_ASSET_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".vite",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

const documentCollator = new Intl.Collator(["zh-CN", "en"], {
  numeric: true,
  sensitivity: "base",
});

function portablePath(path) {
  return path.split(sep).join("/");
}

function isInside(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent !== "" && !pathFromParent.startsWith(`..${sep}`) && pathFromParent !== ".." && !isAbsolute(pathFromParent);
}

function validateDirectories(sourceDirectory, outputDirectory) {
  const source = resolve(sourceDirectory);
  const output = resolve(outputDirectory);
  if (output === parse(output).root) {
    throw new Error("Refusing to generate a web library at a filesystem root");
  }
  if (source === output || isInside(source, output) || isInside(output, source)) {
    throw new Error("Source and output directories must not contain each other");
  }
  return { source, output };
}

function fallbackTitle(relativePath) {
  const fileName = basename(relativePath, extname(relativePath));
  return fileName || relativePath;
}

export function extractMarkdownTitle(content, relativePath) {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  let fence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      fence = fence === marker ? null : fence ?? marker;
      continue;
    }
    if (fence) continue;

    const atxHeading = line.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/);
    if (atxHeading?.[1]) return atxHeading[1].trim();

    const nextLine = lines[index + 1];
    if (line.trim() && nextLine && /^\s{0,3}=+\s*$/.test(nextLine)) {
      return line.trim();
    }
  }

  return fallbackTitle(relativePath);
}

function generatedAtValue(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new Error("generatedAt must be a valid date");
  return date.toISOString();
}

async function collectFiles(sourceDirectory) {
  const files = [];

  async function visit(directory, directoryRelativePath = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => documentCollator.compare(left.name, right.name));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) continue;

      const absolutePath = resolve(directory, entry.name);
      const relativePath = directoryRelativePath
        ? `${directoryRelativePath}/${entry.name}`
        : entry.name;

      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        const extension = extname(entry.name).toLowerCase();
        if (MARKDOWN_EXTENSIONS.has(extension) || PUBLIC_ASSET_EXTENSIONS.has(extension)) {
          files.push({ absolutePath, relativePath: portablePath(relativePath) });
        }
      }
    }
  }

  await visit(sourceDirectory);
  return files;
}

/**
 * Build a host-agnostic static library. The function is exported so tests and
 * deployment tooling can supply isolated source/output directories.
 */
export async function generateWebLibrary(options = {}) {
  const sourceCandidate = options.sourceDirectory ?? process.env.READE_CONTENT_DIR ?? DEFAULT_SOURCE_DIRECTORY;
  const outputCandidate = options.outputDirectory ?? process.env.READE_WEB_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIRECTORY;
  const { source, output } = validateDirectories(sourceCandidate, outputCandidate);
  const sourceMetadata = await stat(source).catch(() => null);
  if (!sourceMetadata?.isDirectory()) {
    throw new Error(`Markdown content directory does not exist: ${source}`);
  }

  const title = String(options.title ?? process.env.READE_SITE_TITLE ?? DEFAULT_SITE_TITLE).trim() || DEFAULT_SITE_TITLE;
  const files = await collectFiles(source);
  const staging = `${output}.tmp-${process.pid}-${Date.now()}`;
  const stagingLibrary = resolve(staging, "library");
  const documents = [];
  const searchDocuments = [];

  await rm(staging, { recursive: true, force: true });
  await mkdir(stagingLibrary, { recursive: true });

  try {
    for (const file of files) {
      const bytes = await readFile(file.absolutePath);
      const outputPath = resolve(stagingLibrary, ...file.relativePath.split("/"));
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, bytes);

      const extension = extname(file.relativePath).toLowerCase();
      if (!MARKDOWN_EXTENSIONS.has(extension)) continue;

      const metadata = await stat(file.absolutePath);
      const content = bytes.toString("utf8");
      const document = {
        relativePath: file.relativePath,
        title: extractMarkdownTitle(content, file.relativePath),
        size: metadata.size,
        modified: Math.trunc(metadata.mtimeMs),
        format: extension === ".mdx" ? "mdx" : "markdown",
        indexStatus: "ready",
        indexError: null,
      };
      documents.push(document);
      searchDocuments.push({
        relativePath: document.relativePath,
        title: document.title,
        content,
      });
    }

    documents.sort((left, right) => documentCollator.compare(left.relativePath, right.relativePath));
    searchDocuments.sort((left, right) => documentCollator.compare(left.relativePath, right.relativePath));

    const manifest = {
      schemaVersion: 2,
      title,
      generatedAt: generatedAtValue(options.generatedAt),
      documents,
    };
    const searchIndex = {
      schemaVersion: 2,
      documents: searchDocuments,
    };

    await writeFile(resolve(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(resolve(staging, "search.json"), `${JSON.stringify(searchIndex)}\n`, "utf8");

    await rm(output, { recursive: true, force: true });
    await mkdir(dirname(output), { recursive: true });
    await rename(staging, output);

    return {
      sourceDirectory: source,
      outputDirectory: output,
      manifest,
      searchIndex,
      copiedFileCount: files.length,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  generateWebLibrary()
    .then((result) => {
      console.log(
        `Generated ${result.manifest.documents.length} documents and ${result.copiedFileCount} files in ${result.outputDirectory}`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
