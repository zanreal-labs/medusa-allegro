import type { AllegroErrorBody } from "./types";

export class AllegroApiError extends Error {
  readonly httpStatus: number;
  readonly errors: NonNullable<AllegroErrorBody["errors"]>;
  readonly raw: AllegroErrorBody | string | undefined;
  readonly requestId?: string;

  constructor(opts: {
    message: string;
    httpStatus: number;
    body?: AllegroErrorBody | string;
    requestId?: string;
  }) {
    super(opts.message);
    this.name = "AllegroApiError";
    this.httpStatus = opts.httpStatus;
    this.raw = opts.body;
    this.requestId = opts.requestId;
    this.errors =
      typeof opts.body === "object" && opts.body && Array.isArray(opts.body.errors)
        ? opts.body.errors
        : [];
  }

  /**
   * Allegro rate-limit response (HTTP 429). Callers treating rate limits as a
   * systemic condition (e.g. the price-automation monitor, which aborts the
   * whole sweep rather than recording per-offer failures) key off this.
   */
  isRateLimit(): boolean {
    return this.httpStatus === 429;
  }

  /**
   * Allegro server-side failure (HTTP >= 500). Like `isRateLimit`, this signals
   * a systemic outage the caller should back off from, not a per-item error.
   */
  isServerError(): boolean {
    return this.httpStatus >= 500;
  }

  /** True for either a rate limit or a 5xx - the systemic-failure shorthand. */
  isSystemic(): boolean {
    return this.isRateLimit() || this.isServerError();
  }

  /**
   * Allegro "forbidden" response (HTTP 403). On the write-only
   * offer-price-automation command endpoint this is how a token that lacks
   * `allegro:api:sale:offers:write` reports itself: the price-sync loop treats a
   * 403 there as a systemic write-scope gap (a circuit-breaker condition that
   * holds the whole run and raises the reconnect banner) rather than a per-offer
   * failure. Distinct from `isSystemic()` on purpose - a 403 is not a rate limit
   * or an outage, and only the command path knows to read it as a scope gap.
   */
  isForbidden(): boolean {
    return this.httpStatus === 403;
  }
}
