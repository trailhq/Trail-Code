/**
 * Streamed, atomic file writes and line iteration over a Buffer.
 *
 * Every graft artifact used to be one `JSON.stringify` and one `JSON.parse`.
 * V8 caps a string at ~512 MiB (`buffer.constants.MAX_STRING_LENGTH`); a
 * 65k-file repo's extract cache is ~1 GB and its wiring.json ~0.5 GB, so the
 * cold build threw `Invalid string length` at the very end, and a graph that
 * did get written threw `ERR_STRING_TOO_LONG` on read. The writers here take
 * one element at a time; the reader decodes one line at a time.
 */
import { closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export interface AtomicWriter {
  write(chunk: string): void;
  commit(): void;
  abort(): void;
}

/** Write to `<path>.<pid>.tmp`, then rename over `path` on commit(). The pid keeps
 * two concurrent writers off each other's scratch file, the same discipline as
 * `writeJsonAtomic` in util/state.ts. */
export function openAtomic(path: string): AtomicWriter {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  let fd: number | null = openSync(tmp, "w");
  const cleanup = (): void => {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } fd = null; }
    try { rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
  };
  return {
    write(chunk) {
      if (fd === null) throw new Error("atomic writer is closed");
      // writeSync may write fewer bytes than asked (pipes, some filesystems):
      // loop on the byte count, so a multi-megabyte element is never truncated.
      const bytes = Buffer.from(chunk, "utf8");
      let off = 0;
      while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    },
    commit() {
      if (fd === null) throw new Error("atomic writer is closed");
      try {
        closeSync(fd);
        fd = null;
        renameSync(tmp, path);
      } catch (e) {
        cleanup();
        throw e;
      }
    },
    abort() { cleanup(); },
  };
}

/** Decode `buf[start, end)` as one line, dropping a trailing "\r" (a CRLF file). */
function decodeLine(buf: Buffer, start: number, end: number): string {
  if (end > start && buf[end - 1] === 0x0d) end--;
  return buf.toString("utf8", start, end);
}

/** Feeds `fn` each line of some source, in order: {@link forEachLine} over a
 * Buffer, {@link forEachFileLine} over a file. */
export type LineWalker = (fn: (line: string, index: number) => void) => void;

/** Call `fn` for each line of `buf`. A trailing line without "\n" is still a line;
 * an empty buffer yields none. Each line is decoded on its own, so the Buffer may
 * be larger than any string V8 can hold. */
export function forEachLine(buf: Buffer, fn: (line: string, index: number) => void): void {
  let start = 0;
  let index = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end === -1) end = buf.length;
    fn(decodeLine(buf, start, end), index++);
    start = end + 1;
  }
}

const LINE_CHUNK_BYTES = 32 * 1024 * 1024;

/** {@link forEachLine} over a file, read `chunkBytes` at a time: the file is never
 * one Buffer either, so it may exceed Node's 2 GiB `readFileSync` limit
 * (`ERR_FS_FILE_TOO_LARGE`). A line split across chunks is carried over and
 * joined before it is decoded, so a multibyte character is never cut. */
export function forEachFileLine(
  path: string,
  fn: (line: string, index: number) => void,
  chunkBytes = LINE_CHUNK_BYTES,
): void {
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.allocUnsafe(chunkBytes);
    let carry: Buffer[] = []; // the current line's bytes from earlier chunks
    let index = 0;
    const emit = (tail: Buffer): void => {
      const line = carry.length === 0 ? tail : Buffer.concat([...carry, tail]);
      carry = [];
      fn(decodeLine(line, 0, line.length), index++);
    };
    for (;;) {
      const n = readSync(fd, chunk, 0, chunkBytes, null);
      if (n === 0) break;
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, start);
        if (nl === -1 || nl >= n) {
          // `chunk` is reused by the next read: keep a copy of the partial line.
          if (start < n) carry.push(Buffer.from(chunk.subarray(start, n)));
          break;
        }
        emit(chunk.subarray(start, nl));
        start = nl + 1;
      }
    }
    if (carry.length > 0) emit(Buffer.alloc(0));
  } finally {
    closeSync(fd);
  }
}
