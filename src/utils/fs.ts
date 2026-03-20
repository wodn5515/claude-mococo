import fs from 'node:fs';

/** Atomic write: write to temp file then rename to avoid corruption on crash. */
export function atomicWriteSync(filePath: string, content: string): void {
  const tmp = filePath + '.tmp';
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

const fileLocks = new Map<string, Promise<void>>();

/** In-process mutex keyed by file path. Serializes async operations on the same file. */
export async function withFileLock<T>(filePath: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = fileLocks.get(filePath) ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>(r => { resolve = r; });
  fileLocks.set(filePath, next);
  try {
    await prev;
    return await fn();
  } finally {
    resolve();
    if (fileLocks.get(filePath) === next) fileLocks.delete(filePath);
  }
}
