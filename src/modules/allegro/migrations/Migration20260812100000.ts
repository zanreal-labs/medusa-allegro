import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Adds `allegro_invoice_id` / `invoice_attached_at` to `allegro_order`, for the
 * invoice chain.
 *
 * Both exist because Allegro's invoice endpoints have no idempotency key. Attaching an
 * invoice is two calls - register the document, then upload the PDF - and every crash
 * point between them has to be recoverable from the row alone:
 *
 * - `allegro_invoice_id` is written the moment the create returns, before the upload.
 *   Without it, a retry after a crash registers a SECOND document for the same invoice
 *   number, and an order accepts only ten.
 * - `invoice_attached_at` is stamped last, after Allegro accepted the file, so it means
 *   "the buyer can download this" rather than "we started". Null with an invoice already
 *   issued is what the sweep in the orders job looks for.
 *
 * Both columns are nullable with no default: every existing row simply has no attached
 * invoice, which is the correct reading until the chain runs for it. Nothing is
 * backfilled - an order invoiced before this shipped was attached by the pipeline this
 * plugin replaces, and inventing a timestamp for it would claim a fact this plugin
 * cannot verify.
 */
export class Migration20260812100000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "allegro_order" add column if not exists "allegro_invoice_id" text null, add column if not exists "invoice_attached_at" timestamptz null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "allegro_order" drop column if exists "allegro_invoice_id", drop column if exists "invoice_attached_at";`,
    );
  }
}
