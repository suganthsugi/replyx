import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';

import { AppError, type ErrorDetail } from './app-error.js';

import type { Response } from 'express';

interface ErrorBody {
  error: { code: string; message: string; details?: readonly ErrorDetail[]; retryAfter?: number };
}

/** Codes for errors raised by Nest or Express itself (unknown route, body parser, ...). */
const STATUS_CODES: Record<number, { code: string; message: string }> = {
  400: { code: 'VALIDATION_FAILED', message: 'The request is invalid' },
  401: { code: 'UNAUTHENTICATED', message: 'Sign in to continue' },
  403: { code: 'PERMISSION_DENIED', message: 'You do not have permission to do this' },
  404: { code: 'NOT_FOUND', message: 'Not found' },
  405: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'The request is too large' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported content type' },
  429: { code: 'RATE_LIMITED', message: 'Too many requests, try again later' },
};

const INTERNAL: ErrorBody = { error: { code: 'INTERNAL', message: 'Something went wrong' } };

/**
 * Every HTTP error leaves as `{ error: { code, message, details? } }` (constitution IX). Only
 * `AppError` carries its own code and message; anything else is mapped by status, and unknown
 * errors become 500 `INTERNAL` with no stack, SQL or class names in the body.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ErrorFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw exception;
    }
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.toResponse(exception);
    if (status >= 500) {
      // The stack goes to the log only; request/tenant ids come from the request logger.
      this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : 'Non-error thrown');
    }
    if (response.headersSent) {
      return;
    }
    if (body.error.retryAfter !== undefined) {
      response.setHeader('Retry-After', String(body.error.retryAfter));
    }
    response.status(status).json(body);
  }

  private toResponse(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof AppError) {
      return {
        status: exception.httpStatus,
        body: {
          error: {
            code: exception.code,
            message: exception.message,
            ...(exception.details === undefined ? {} : { details: exception.details }),
            ...(exception.retryAfter === undefined ? {} : { retryAfter: exception.retryAfter }),
          },
        },
      };
    }
    const status = statusOf(exception);
    const known = status === undefined ? undefined : STATUS_CODES[status];
    if (status === undefined || status >= 500 || known === undefined) {
      return { status: status !== undefined && status >= 500 ? status : 500, body: INTERNAL };
    }
    return { status, body: { error: { ...known } } };
  }
}

/** Nest HttpExceptions and body-parser errors (`status` + `expose`) carry a client status. */
function statusOf(exception: unknown): number | undefined {
  if (exception instanceof HttpException) {
    return exception.getStatus();
  }
  if (typeof exception === 'object' && exception !== null) {
    const { status, expose } = exception as { status?: unknown; expose?: unknown };
    if (typeof status === 'number' && expose === true && status >= 400 && status < 500) {
      return status;
    }
  }
  return undefined;
}
