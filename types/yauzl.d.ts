// yauzl ships no types of its own, and @types/yauzl only covers the 2.x line
// (yauzl is pinned at 3.4.0 in package.json — see package.json) — same API
// shape for the callback-based open/fromBuffer + lazyEntries walk this
// codebase uses (src/services/itemRegistry.ts), so a minimal hand-rolled
// declaration beats installing a mismatched-major @types package.
declare module 'yauzl' {
  import type { Readable } from 'node:stream';

  export interface Entry {
    fileName: string;
    uncompressedSize: number;
  }

  export interface ZipFile extends NodeJS.EventEmitter {
    readEntry(): void;
    openReadStream(entry: Entry, callback: (err: Error | null, stream: Readable) => void): void;
    close(): void;
    /** Not part of yauzl's real API — some call sites defensively call this in a
     *  try/catch expecting it to no-op or throw; kept optional so both compile. */
    destroy?(): void;
    on(event: 'entry', listener: (entry: Entry) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export interface Options {
    lazyEntries?: boolean;
    autoClose?: boolean;
  }

  export function open(path: string, options: Options, callback: (err: Error | null, zipFile: ZipFile) => void): void;
  export function fromBuffer(
    buffer: Buffer,
    options: Options,
    callback: (err: Error | null, zipFile: ZipFile) => void
  ): void;
}
