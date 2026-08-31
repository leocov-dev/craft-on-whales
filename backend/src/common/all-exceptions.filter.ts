import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * Catches everything (Nest's default filter only formats HttpExceptions
 * cleanly; anything else becomes an opaque 500 with nothing in the
 * console). This logs the full stack trace for every unhandled error so a
 * crash is diagnosable from the console alone, then still returns a
 * well-formed JSON error response.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionsHandler');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const message = isHttpException
      ? exception.message
      : exception instanceof Error
        ? exception.message
        : 'Internal server error';

    const stack = exception instanceof Error ? exception.stack : undefined;
    const header = `${req.method} ${req.originalUrl} -> ${status} ${message}`;
    this.logger.error(header, stack);

    const body = isHttpException
      ? exception.getResponse()
      : { statusCode: status, message: 'Internal server error' };

    res.status(status).json(
      typeof body === 'object' && body !== null
        ? body
        : { statusCode: status, message: body },
    );
  }
}
