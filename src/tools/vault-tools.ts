import { App, TFile, TFolder, MarkdownView, normalizePath } from "obsidian";
import type { VaultEntry } from "../types";

export class VaultTools {
  constructor(private app: App) {}

  async createNote(path: string, content: string): Promise<TFile> {
    const normalized = normalizePath(path);
    const dir = normalized.substring(0, normalized.lastIndexOf("/"));
    if (dir) {
      await this.ensureFolder(dir);
    }
    return await this.app.vault.create(normalized, content);
  }

  async readNote(path: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) {
      throw new Error(`File not found: ${path}`);
    }
    return await this.app.vault.read(file);
  }

  async editNote(path: string, content: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) {
      throw new Error(`File not found: ${path}`);
    }
    await this.app.vault.modify(file, content);
  }

  async appendToNote(path: string, content: string): Promise<void> {
    const existing = await this.readNote(path);
    await this.editNote(path, existing + "\n" + content);
  }

  async moveNote(fromPath: string, toPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(fromPath));
    if (!(file instanceof TFile)) {
      throw new Error(`File not found: ${fromPath}`);
    }
    const normalizedTo = normalizePath(toPath);
    const dir = normalizedTo.substring(0, normalizedTo.lastIndexOf("/"));
    if (dir) {
      await this.ensureFolder(dir);
    }
    await this.app.fileManager.renameFile(file, normalizedTo);
  }

  async deleteNote(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) {
      throw new Error(`File not found: ${path}`);
    }
    await this.app.vault.trash(file, false);
  }

  async linkNotes(sourcePath: string, targetPath: string): Promise<void> {
    const content = await this.readNote(sourcePath);
    const targetFile = this.app.vault.getAbstractFileByPath(normalizePath(targetPath));
    if (!(targetFile instanceof TFile)) {
      throw new Error(`Target file not found: ${targetPath}`);
    }
    const linkText = this.app.fileManager.generateMarkdownLink(
      targetFile,
      sourcePath,
    );
    await this.editNote(sourcePath, content + "\n" + linkText);
  }

  listNotes(folder?: string): string[] {
    const files = this.app.vault.getMarkdownFiles();
    if (folder) {
      const normalized = normalizePath(folder);
      return files
        .filter((f) => f.path.startsWith(normalized))
        .map((f) => f.path);
    }
    return files.map((f) => f.path);
  }

  /**
   * Rich vault listing for use as LLM context. Pulls from Obsidian's
   * MetadataCache (the same index that powers Graph View, tag pane, and
   * backlinks) — so tags and headings come for free, already parsed and
   * kept fresh by Obsidian.
   *
   * Paths under any of `excludePrefixes` are skipped (prefix match on
   * folder boundaries, so "gtfo-debug" excludes "gtfo-debug/foo.md" but
   * not "gtfo-debug-archive/foo.md").
   */
  listVaultEntries(
    opts: { excludePrefixes?: string[] } = {},
  ): VaultEntry[] {
    const raw = opts.excludePrefixes ?? [];
    const prefixes = raw
      .map((p) => p.trim().replace(/\/+$/, ""))
      .filter(Boolean)
      .map((p) => p + "/");

    const files = this.app.vault.getMarkdownFiles();
    const entries: VaultEntry[] = [];
    for (const file of files) {
      if (prefixes.some((p) => file.path.startsWith(p))) continue;
      entries.push(this.entryFor(file));
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return entries;
  }

  private entryFor(file: TFile): VaultEntry {
    const cache = this.app.metadataCache.getFileCache(file);

    const tags = new Set<string>();
    // Inline #tag occurrences in the body
    cache?.tags?.forEach((t) => {
      if (t?.tag) tags.add(t.tag.replace(/^#/, ""));
    });
    // Frontmatter `tags:` (string or array form)
    const fmTags = cache?.frontmatter?.tags;
    if (Array.isArray(fmTags)) {
      for (const t of fmTags) tags.add(String(t).replace(/^#/, ""));
    } else if (typeof fmTags === "string") {
      // Support "tag1, tag2" as well as single values
      for (const t of fmTags.split(/[,\s]+/)) {
        if (t) tags.add(t.replace(/^#/, ""));
      }
    }

    const h1 = cache?.headings?.[0]?.heading ?? null;
    const parentPath = file.parent?.path;
    const folder = !parentPath || parentPath === "/" ? "" : parentPath;

    return {
      path: file.path,
      name: file.basename,
      folder,
      tags: [...tags].sort(),
      h1,
      mtime: file.stat.mtime,
    };
  }

  async insertAtCursor(content: string): Promise<boolean> {
    const view = this.findActiveMarkdownView();
    if (!view) return false;

    const editor = view.editor;
    const cursor = editor.getCursor();
    editor.replaceRange(content, cursor);
    return true;
  }

  /**
   * Locate the markdown view the user is actually editing. Previously
   * we called `getActiveViewOfType(MarkdownView)` directly, but that
   * returns null the moment focus moves into a non-markdown leaf — which
   * is exactly what happens when the user clicks a button inside the
   * GTFO sidebar. `getActiveFile()` stays pinned to the last focused
   * markdown file across sidebar interactions, so we locate the
   * MarkdownView leaf showing it and use its editor. Falls back to any
   * open MarkdownView as a last resort.
   */
  private findActiveMarkdownView(): MarkdownView | null {
    const direct = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (direct) return direct;

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) {
      const leaves = this.app.workspace.getLeavesOfType("markdown");
      for (const leaf of leaves) {
        const v = leaf.view;
        if (v instanceof MarkdownView && v.file?.path === activeFile.path) {
          return v;
        }
      }
    }

    const fallbackLeaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of fallbackLeaves) {
      const v = leaf.view;
      if (v instanceof MarkdownView) return v;
    }

    return null;
  }

  /**
   * Lightweight metadata for the currently active markdown file. Pulled
   * from the workspace, not the metadata cache, so it tracks the file
   * the user is actually looking at right now (including unfocused
   * markdown leaves). Returns null when no markdown file is active —
   * the chat chip stays hidden in that case.
   */
  getActiveFileInfo(): { path: string; basename: string } | null {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return null;
    return { path: file.path, basename: file.basename };
  }

  /**
   * Read the currently active markdown file's body. Returns null when
   * no markdown file is active. The disk read is async because Obsidian's
   * Vault.read() can hit the filesystem if the file isn't already
   * cached in the editor.
   */
  async readActiveFile(): Promise<{ path: string; content: string } | null> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return null;
    const content = await this.app.vault.read(file);
    return { path: file.path, content };
  }

  /**
   * Overwrite the currently active markdown file with `content` and
   * return { path, previousContent } so the caller can wire a Restore.
   * Returns null when no markdown file is active (the UI should hide
   * the affordance in that case). Unlike `insertAtCursor`, this uses
   * Vault.modify so the change persists even if the file isn't the
   * focused leaf.
   */
  async overwriteActiveFile(
    content: string,
  ): Promise<{ path: string; previousContent: string } | null> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return null;
    const previousContent = await this.app.vault.read(file);
    await this.app.vault.modify(file, content);
    return { path: file.path, previousContent };
  }

  private async ensureFolder(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFolder) return;

    await this.app.vault.createFolder(normalized);
  }
}
