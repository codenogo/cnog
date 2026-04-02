import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

export function resolveProjectPath(relativePath: string, projectRoot: string): string {
  return join(projectRoot, relativePath);
}

export function fileSize(path: string): number {
  if (!existsSync(path)) return 0;
  const fd = openSync(path, "r");
  try {
    return fstatSync(fd).size;
  } finally {
    closeSync(fd);
  }
}

export function readFileTail(path: string, maxBytes: number = 8_192): string | null {
  if (!existsSync(path)) return null;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= 0) return null;
    const bytes = Math.min(size, maxBytes);
    const start = size - bytes;
    const buffer = Buffer.alloc(bytes);
    readSync(fd, buffer, 0, bytes, start);
    const content = buffer.toString("utf-8");
    if (start === 0) {
      return content.length > 0 ? content : null;
    }
    const firstNewline = content.indexOf("\n");
    const trimmed = firstNewline >= 0 ? content.slice(firstNewline + 1) : content;
    return trimmed.length > 0 ? trimmed : null;
  } finally {
    closeSync(fd);
  }
}

export function readProjectFileTail(
  relativePath: string | null,
  projectRoot: string,
  maxBytes: number = 8_192,
): string | null {
  if (!relativePath) return null;
  return readFileTail(resolveProjectPath(relativePath, projectRoot), maxBytes);
}

export function projectFileSize(relativePath: string | null, projectRoot: string): number {
  if (!relativePath) return 0;
  return fileSize(resolveProjectPath(relativePath, projectRoot));
}
