export class DomainValidationError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 422) {
    super(message);
    this.name = "DomainValidationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}
