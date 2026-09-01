/**
 * Polish copy for the Allegro promotion preview widget.
 *
 * Every string the widget renders lives here, so a future locale pass has exactly
 * one file to touch. The Medusa admin shell around the widget is English and stays
 * that way; this covers only what this plugin draws.
 *
 * ## What belongs here, and what does not
 *
 * The widget answers one question: what will this promotion do to my prices on
 * Allegro. So every string is about the operator's promotion and the resulting
 * price, never about how the plugin achieves it. Rule names, the plugin's rule-name
 * prefix, "attach" / "switch" / "override" and the rest of the mechanism vocabulary
 * are deliberately absent: they explain our implementation, not his outcome, and a
 * reader who has to learn them to read a price is being taxed for our convenience.
 *
 * That is a rule with a scar behind it. An earlier version carried a note about the
 * account's "Bitdefender Sale" rule being Allegro's paid Wyroznienie highlight
 * rather than a discount. It is true, and it is genuinely useful to a developer
 * resolving rule names, but on this screen it read as though the feature had built
 * auction highlighting instead of the price reduction that was asked for. Developer
 * context belongs next to the code it explains (see `resolveExpectedRuleIds` in
 * `src/lib/sync/price-automation.ts`), not in front of an operator.
 *
 * The wording is written for a Polish operator rather than translated phrase by
 * phrase, which is why the counts decline properly (1 aukcje, 2 aukcje, 5 aukcji)
 * and the reason codes read as sentences somebody can act on.
 */

/**
 * The Polish plural of "aukcja" for a count, in the accusative the headline needs
 * ("Zmieni 1 aukcje", "Zmieni 2 aukcje", "Zmieni 5 aukcji").
 *
 * Three forms, which is why a bare `${n} aukcji` reads wrong at the two counts an
 * operator meets most often: exactly one, and small numbers. The teens are the
 * exception a last-digit rule alone gets wrong, since 12 takes the same form as 5
 * rather than the same form as 2.
 */
export const auctionsPl = (count: number): string => {
  const withinHundred = Math.abs(count) % 100;
  const lastDigit = withinHundred % 10;
  if (withinHundred === 1) {
    return "aukcję";
  }
  if (lastDigit >= 2 && lastDigit <= 4 && !(withinHundred >= 12 && withinHundred <= 14)) {
    return "aukcje";
  }
  return "aukcji";
};

/** Static strings, and the few that take a value. */
export const PROMO_COPY = {
  /** The two ways a discount can be worked out, named by what they mean commercially. */
  baseCompetitor: "Rabat względem cen konkurencji (działa, gdy jest konkurencja)",
  baseNone: "Nie wybrano (tylko podgląd)",
  baseSrp: "Rabat liczony od SRP (gwarantowany)",
  blockedTitle: "Ta promocja nie zmieni cen na Allegro:",
  // Kept short on purpose: this sits in a table cell, not a paragraph.
  clampedToFloor: "ograniczone progiem opłacalności",
  armLabel: "Uzbrojona",
  emptyRows: "Żadna aukcja objęta tą promocją nie kwalifikuje się do zmiany ceny.",
  heading: "Podgląd cen na Allegro",
  loadError: "Nie udało się wczytać podglądu Allegro.",
  loading: "Wczytywanie podglądu...",
  /** The whole reassurance, in one line. The explainer that used to follow was noise. */
  noWriteLine: "Nic tu nie zmienia cen na Allegro.",
  reasonHeader: "Powód",
  saveError: "Nie udało się zapisać sposobu liczenia rabatu.",
  saveOk: "Zapisano. Nic nie zostało wysłane na Allegro.",
  skippedTitle: "Aukcje pominięte (ceny bez zmian)",
  /** Loud, and only rendered when it can actually be true. */
  marginLoss: "Sprzedaż ze stratą",
  marginThin: "Niska marża",
  marginUnknown: "brak danych",
  tableCommission: "Prowizja",
  tableCost: "Cena zakupu",
  tableCurrent: "Cena teraz",
  tableFloorOnly: "Po rabacie",
  tableMargin: "Marża po prowizji",
  tableSku: "SKU",
} as const;

/** "Zmieni N aukcji. Reszta katalogu zostaje bez zmian." */
export const movesHeadline = (eligible: number): string =>
  `Zmieni cenę na ${eligible} ${auctionsPl(eligible)}.`;

/** The coverage sentence under the headline. */
export const coverageBody = (coverage: {
  targeted: number;
  linked: number;
  eligible: number;
  skipped: number;
}): string =>
  `Objęte SKU: ${coverage.targeted}. Z aukcją na Allegro: ${coverage.linked}. Pominięte: ${coverage.skipped}.`;

/**
 * Margin, as money and percent: "12,40 PLN (13%)".
 *
 * One value with a short label, which is what a person scanning twelve rows can
 * actually use. The percent is `netIncome / sellingPrice`, the same ratio the costs
 * plugin reports, rounded for display only.
 */
/**
 * "min. 136.00 PLN"
 *
 * The ONLY honest thing to render for the competitor mode. Allegro applies the
 * reduction server-side against a reference price it does not expose anywhere in
 * its API (verified: the per-offer automation resource returns the rule id and the
 * range we wrote, nothing about the market), so the landing price is unknowable
 * from here. What IS known is the floor the rule may never go below, so that is
 * what is shown. The previous render implied competitor data we do not have.
 */
export const floorOnlyLabel = (floor: number, currency: string): string =>
  `min. ${floor.toFixed(2)} ${currency}`;

/** "9.5% (14.73 PLN)" - the rate that fed the break-even, and what it costs here. */
export const commissionLabel = (rate: number, amount: number, currency: string): string =>
  `${Math.round(rate * 1000) / 10}% (${amount.toFixed(2)} ${currency})`;

export const marginLabel = (amount: number, pct: number | undefined, currency: string): string =>
  pct === undefined
    ? `${amount.toFixed(2)} ${currency}`
    : `${amount.toFixed(2)} ${currency} (${Math.round(pct * 100)}%)`;

/**
 * Below this, a margin is thin enough to be worth flagging amber.
 *
 * 5% of the selling price. Not a law of nature, and deliberately a single constant
 * so it can be argued with in one place rather than hunted through the widget.
 */
export const THIN_MARGIN_PCT = 0.05;


/**
 * Per-SKU skip reasons, keyed by the code the API returns.
 *
 * Each says what is missing in the operator's own terms and, where it is not
 * obvious, what would fix it. The codes stay the API contract; only the rendering
 * is Polish, so an unmapped code falls back to the raw value rather than
 * disappearing from the table.
 */
export const SKIP_REASON_PL: Record<string, string> = {
  "invalid-bounds": "Próg opłacalności nie jest niższy od SRP, nie ma z czego dać rabatu.",
  "missing-break-even": "Uzupełnij koszt zakupu i prowizję Allegro.",
  "missing-srp": "Uzupełnij cenę SRP.",
  "not-linked": "Powiąż produkt z aukcją na Allegro.",
  "offer-not-active": "Aukcja nie jest aktywna.",
  "promotion-unresolved": "Nie znamy prowizji Allegro dla tej aukcji.",
  "rule-name-too-long": "Nie udało się przygotować rabatu dla tej aukcji.",
  "status-unknown": "Nie udało się odczytać statusu aukcji.",
  "sync-disabled": "Włącz automatyczną zmianę ceny dla tej aukcji.",
};

/** Promotion-level blockers, keyed by the code the API returns. */
export const BLOCK_REASON_PL: Record<string, string> = {
  "allegro-channel-excluded": "Dodaj kanał sprzedaży Allegro do tej promocji.",
  "discount-base-unset": "Wybierz powyżej, jak liczyć rabat.",
  "discount-unsupported": "Ustaw rabat jako procent od każdej sztuki, wtedy zadziała.",
  "no-target-products": "Dodaj produkty do tej promocji.",
  "not-automatic": "Włącz promocję automatyczną, bez kodu rabatowego.",
};

/** Polish label for a code, falling back to the raw code when it is not mapped. */
export const labelFor = (map: Record<string, string>, code: string, fallback?: string): string =>
  map[code] ?? fallback ?? code;
