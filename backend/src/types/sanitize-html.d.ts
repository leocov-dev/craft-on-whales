// sanitize-html ships no types of its own and none are installed for it —
// a minimal hand-rolled declaration for the surface area actually used in
// this codebase (backend/src/api/packs.controller.ts), matching the
// reasoning already used for archiver.d.ts alongside this file.
declare module 'sanitize-html' {
  interface IOptions {
    allowedTags?: string[];
    allowedAttributes?: Record<string, string[]>;
    allowedSchemes?: string[];
    transformTags?: Record<string, unknown>;
  }

  interface SanitizeHtml {
    (html: string, options?: IOptions): string;
    simpleTransform: (
      tagName: string,
      attribs: Record<string, string>,
    ) => unknown;
  }

  const sanitizeHtml: SanitizeHtml;
  export = sanitizeHtml;
}
