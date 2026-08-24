// archiver ships no types, and @types/archiver only covers the Archiver
// class, not the factory-function call signature this codebase actually
// uses — a minimal hand-rolled declaration for the surface area used here
// beats installing a mismatched types package.
declare module 'archiver' {
  export interface Archiver {
    on(event: 'error', listener: (err: Error) => void): Archiver;
    on(
      event: 'progress',
      listener: (data: { fs: { processedBytes: number } }) => void,
    ): Archiver;
    on(event: string, listener: (...args: unknown[]) => void): Archiver;
    pipe<T extends NodeJS.WritableStream>(destination: T): T;
    directory(dirpath: string, destpath: string | false): Archiver;
    append(
      source: string | Buffer | NodeJS.ReadableStream,
      data: { name: string } & Record<string, unknown>,
    ): Archiver;
    file(
      filepath: string,
      data: { name: string } & Record<string, unknown>,
    ): Archiver;
    // Kicks off the async write; completion is signaled via the 'close'/'end'
    // stream events (or 'error'), not by this call's return value.
    finalize(): void;
  }

  export default function archiver(
    format: 'zip' | 'tar',
    options?: Record<string, unknown>,
  ): Archiver;
}
