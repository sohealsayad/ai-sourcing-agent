export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export class NotFoundError extends HttpError {
  constructor(message = 'Not found') {
    super(404, message);
  }
}

export class InvalidTransitionError extends HttpError {
  constructor(from, to) {
    super(409, `Cannot move request from ${from} to ${to}`);
    this.from = from;
    this.to = to;
  }
}
