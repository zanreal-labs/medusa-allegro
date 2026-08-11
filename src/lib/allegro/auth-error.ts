export class AllegroAuthError extends Error {
  readonly code: string;
  readonly httpStatus?: number;

  constructor(message: string, code: string, httpStatus?: number) {
    super(message);
    this.name = "AllegroAuthError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
