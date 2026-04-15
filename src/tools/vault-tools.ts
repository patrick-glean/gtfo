import { App, TFile, TFolder, MarkdownView, normalizePath } from "obsidian";

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

  async insertAtCursor(content: string): Promise<boolean> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return false;

    const editor = view.editor;
    const cursor = editor.getCursor();
    editor.replaceRange(content, cursor);
    return true;
  }

  private async ensureFolder(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFolder) return;

    await this.app.vault.createFolder(normalized);
  }
}
