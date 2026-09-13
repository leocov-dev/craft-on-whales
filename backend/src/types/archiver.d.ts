// archiver v8 exports class-based archives (ZipArchive, TarArchive, etc.)
// with no default factory function.
declare module 'archiver' {
  import { Transform } from 'node:stream';

  export interface ArchiverOptions {
    zlib?: {
      level?: number;
    };
    [key: string]: unknown;
  }

  export class Archiver extends Transform {
    on(event: 'error', listener: (err: Error) => void): this;
    on(
      event: 'progress',
      listener: (data: { fs: { processedBytes: number } }) => void,
    ): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
    pipe<T extends NodeJS.WritableStream>(destination: T): T;
    directory(dirpath: string, destpath: string | false): this;
    append(
      source: string | Buffer | NodeJS.ReadableStream,
      data: { name: string } & Record<string, unknown>,
    ): this;
    file(
      filepath: string,
      data: { name: string } & Record<string, unknown>,
    ): this;
    // Kicks off the async write; completion is signaled via the 'close'/'end'
    // stream events (or 'error'), not by this call's return value.
    finalize(): void;
  }

  export class ZipArchive extends Archiver {
    constructor(options?: ArchiverOptions);
  }

  export class TarArchive extends Archiver {
    constructor(options?: ArchiverOptions);
  }

  export class JsonArchive extends Archiver {
    constructor(options?: ArchiverOptions);
  }
}
