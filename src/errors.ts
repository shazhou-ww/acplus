export class ConfigurationError extends Error {}

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    readonly status = 502,
    message = code.replaceAll("_", " "),
  ) {
    super(message);
  }
}
