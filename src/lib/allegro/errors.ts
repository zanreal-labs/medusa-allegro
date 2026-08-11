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

  /**
   * The request never reached Allegro at all: DNS failure, connection refused, a TLS
   * error, or the client's own abort timeout. `AllegroClient.send` reports every one of
   * these as `httpStatus: 0`, because there is no HTTP status to report.
   */
  isTransportFailure(): boolean {
    return this.httpStatus === 0;
  }

  /**
   * True for any condition that is about the PIPELINE rather than about the item being
   * written.
   *
   * This decides whether a failing item's quarantine streak grows, so getting it too
   * narrow is expensive. Quarantine is only safe on the evidence that the rest of the
   * pipeline works: during an outage every active item fails together, and without a
   * systemic verdict they all cross the threshold on the same tick and are set aside -
   * turning a five-minute outage into bulk silently-skipped work, each piece needing
   * manual repair.
   *
   * Three cases beyond the original rate-limit-or-5xx shorthand, each of which was being
   * counted against whichever offer or order it happened to hit:
   *
   * - **Transport failure** (`httpStatus: 0`). Allegro being unreachable is the textbook
   *   systemic condition, and it was the one most likely to quarantine a whole working set.
   * - **408 Request Timeout.** Server-side slowness, indistinguishable in kind from a 5xx.
   * - **401 Unauthorized.** Reachable as an `AllegroApiError` only when there is no refresh
   *   token to retry with - a rejected refresh throws `AllegroAuthError` instead - so it
   *   means the stored connection is dead, which is true of every item rather than of this
   *   one.
   *
   * 403 stays deliberately OUT: it is the write-scope gap, and only the command paths know
   * to read it that way. See `isForbidden`.
   */
  isSystemic(): boolean {
    return (
      this.isRateLimit() ||
      this.isServerError() ||
      this.isTransportFailure() ||
      this.httpStatus === 408 ||
      this.httpStatus === 401
    );
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
