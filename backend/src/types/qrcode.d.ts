// qrcode ships no types of its own and none are installed for it — a
// minimal hand-rolled declaration for the surface area actually used in
// this codebase (backend/src/auth/auth.controller.ts), matching the
// reasoning already used for archiver.d.ts alongside this file.
declare module 'qrcode' {
  interface QRCodeToDataURLOptions {
    margin?: number;
    width?: number;
    [key: string]: unknown;
  }

  const QRCode: {
    toDataURL: (
      text: string,
      options?: QRCodeToDataURLOptions,
    ) => Promise<string>;
  };
  export = QRCode;
}
