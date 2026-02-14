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
