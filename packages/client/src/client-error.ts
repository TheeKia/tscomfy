/**
 * The server couldn't be reached, or answered in a way the protocol doesn't allow. Thrown by the
 * HTTP functions and used to reject a job's outcome; what the server decides about a job (a
 * rejection, a failure) is data instead, in the {@link Outcome}. The underlying error, if any, is
 * the `cause`.
 */
export class ClientError extends Error {
  /** The HTTP status of the answer that caused it, when there was one. */
  readonly status: number | undefined;

  constructor(
    message: string,
    options: { readonly cause?: unknown; readonly status?: number } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ClientError";
    this.status = options.status;
  }
}
