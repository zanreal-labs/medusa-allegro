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
  clampedToFloor: "ograniczone progiem opłacalności",
  competitorCaveat: "gdy jesteśmy już najtańsi, cena się nie zmienia",
  costEdited: "koszt zakupu zmieniony w ciągu 30 dni",
  discountBaseHelp:
    "Wybór decyduje, od czego liczymy obniżkę. Nic nie trafia na Allegro. Dopóki nie wybierzesz, to wyłącznie podgląd.",
  discountBaseLabel: "Jak liczyć rabat",
  emptyRows: "Żadna aukcja objęta tą promocją nie kwalifikuje się do zmiany ceny.",
  heading: "Podgląd promocji na Allegro",
  loadError: "Nie udało się wczytać podglądu Allegro.",
  loading: "Wczytywanie podglądu...",
  noWriteBody:
    "Widok pokazuje wyłącznie to, co ta promocja zrobiłaby z cenami Twoich aukcji. Nic nie jest włączone i nic nie zostanie wysłane na Allegro.",
  noWriteTitle: "Nic na tej stronie nie zmienia cen na Allegro",
  /** `code` doubles as the promotion's name: an automatic promotion has no separate name field. */
  promotionCodeLabel: "kod (nazwa promocji)",
  promotionCodeMissing: "brak",
  reasonHeader: "Powód",
  /** Said once, plainly, instead of naming the rule the price returns to. */
  revertsNote: "po zakończeniu promocji cena wraca do dotychczasowych zasad",
  saveError: "Nie udało się zapisać sposobu liczenia rabatu.",
  saveOk: "Zapisano. Nic nie zostało wysłane na Allegro.",
  skippedTitle: "Aukcje pominięte (ceny bez zmian)",
  tableCompetitor: "Rabat względem konkurencji",
  tableCost: "Koszt zakupu",
  tableFloor: "Nie sprzedamy poniżej",
  tableSku: "SKU",
  tableSrp: "Cena SRP",
  tableSrpBase: "Rabat od SRP",
} as const;

/** "Zmieni N aukcji. Reszta katalogu zostaje bez zmian." */
export const movesHeadline = (eligible: number): string =>
  `Zmieni cenę na ${eligible} ${auctionsPl(eligible)}. Reszta katalogu zostaje bez zmian.`;

/** The coverage sentence under the headline. */
export const coverageBody = (coverage: {
  targeted: number;
  linked: number;
  eligible: number;
  skipped: number;
}): string =>
  `Objęte SKU: ${coverage.targeted}. Powiązane z aukcją na Allegro: ${coverage.linked}. Gotowe do zmiany ceny: ${coverage.eligible}. Pominięte: ${coverage.skipped}. ` +
  "Promocja zmienia ceny wyłącznie na aukcjach swoich produktów, więc reszta katalogu zostaje dokładnie taka, jaka jest.";

/** "Cena obniżona do 89,99 PLN" */
export const priceLoweredTo = (price: number, currency: string): string =>
  `Cena obniżona do ${price} ${currency}`;

/** "Cena podąża za konkurencją, nie spadnie poniżej 40 PLN" */
export const priceFollowsCompetition = (floor: number, currency: string): string =>
  `Cena podąża za cenami konkurencji, nie spadnie poniżej ${floor} ${currency}`;

/**
 * Per-SKU skip reasons, keyed by the code the API returns.
 *
 * Each says what is missing in the operator's own terms and, where it is not
 * obvious, what would fix it. The codes stay the API contract; only the rendering
 * is Polish, so an unmapped code falls back to the raw value rather than
 * disappearing from the table.
 */
export const SKIP_REASON_PL: Record<string, string> = {
  "invalid-bounds": "próg opłacalności jest równy cenie SRP albo od niej wyższy, nie ma z czego dać rabatu",
  "missing-break-even": "nie znamy progu opłacalności, brakuje kosztu zakupu albo prowizji Allegro",
  "missing-srp": "brak ceny SRP, od której liczymy rabat",
  "not-linked": "produkt nie ma powiązanej aukcji na Allegro",
  "offer-not-active": "aukcja nie jest aktywna",
  "promotion-unresolved": "nie udało się ustalić prowizji Allegro dla tej aukcji",
  "rule-name-too-long": "nie udało się przygotować rabatu dla tej aukcji",
  "status-unknown": "nie udało się odczytać statusu aukcji",
  "sync-disabled": "automatyczna zmiana ceny wyłączona dla tej aukcji",
};

/** Promotion-level blockers, keyed by the code the API returns. */
export const BLOCK_REASON_PL: Record<string, string> = {
  "allegro-channel-excluded":
    "promocja jest ograniczona do kanałów sprzedaży, wśród których nie ma kanału Allegro",
  "discount-base-unset": "nie wybrano, jak liczyć rabat, więc na razie jest to wyłącznie podgląd",
  "discount-unsupported": "takiego rabatu nie da się przenieść na pojedynczą aukcję",
  "no-target-products": "promocja nie obejmuje żadnych produktów",
  "not-automatic":
    "promocja wymaga kodu rabatowego. Na Allegro zadziała tylko promocja automatyczna, bo kupujący nie ma gdzie wpisać kodu.",
};

/** Polish label for a code, falling back to the raw code when it is not mapped. */
export const labelFor = (map: Record<string, string>, code: string, fallback?: string): string =>
  map[code] ?? fallback ?? code;
