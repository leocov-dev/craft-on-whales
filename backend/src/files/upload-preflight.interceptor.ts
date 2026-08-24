import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { FilesService } from './files.service';

// Hard ceiling on a single upload request. Without this, multer's own limits
// allow up to 4 GB × 20 files = 80 GB to be streamed to data/tmp BEFORE the
// quota check below runs.
const MAX_UPLOAD_REQUEST_BYTES = 8 * 1024 ** 3;

/**
 * Rejects oversized / quota-busting / disk-filling uploads from the
 * Content-Length header BEFORE the multer interceptor (declared after this
 * one in `@UseInterceptors(...)`) streams a single byte to disk. Ports
 * legacy `uploadPreflight()`.
 */
@Injectable()
export class UploadPreflightInterceptor implements NestInterceptor {
  constructor(private readonly files: FilesService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<Request>();
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_UPLOAD_REQUEST_BYTES) {
      throw new PayloadTooLargeException(
        `Upload too large (limit ${Math.round(MAX_UPLOAD_REQUEST_BYTES / 1024 ** 3)} GB per request).`,
      );
    }
    if (declared > 0) {
      const serverId = (req.params.id as string | undefined) || null;
      await this.files.assertRoom(serverId, declared);
      await this.files.assertDiskFree(declared);
    }
    return next.handle();
  }
}
