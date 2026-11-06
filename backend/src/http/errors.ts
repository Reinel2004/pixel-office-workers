import type { ErrorCode, LiveError, SystemId } from '../../shared/live';

const RETRYABLE: ErrorCode[] = ['RATE_LIMITED', 'TIMEOUT', 'NETWORK', 'UPSTREAM_ERROR'];

/** Every integration failure is converted to one of these, so the UI can tell them apart. */
export class IntegrationError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public system?: SystemId,
    public httpStatus?: number,
  ) {
    super(message);
    this.name = 'IntegrationError';
  }

  toLive(): LiveError {
    return {
      code: this.code,
      message: this.message,
      system: this.system,
      httpStatus: this.httpStatus,
      retryable: RETRYABLE.includes(this.code),
    };
  }
}

export function toLiveError(err: unknown, system?: SystemId): LiveError {
  if (err instanceof IntegrationError) return err.toLive();
  // Unknown errors are reported generically; details stay out of the UI and logs.
  return { code: 'INTERNAL', message: 'Unexpected server error while processing this task.', system, retryable: false };
}
