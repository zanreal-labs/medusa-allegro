/**
 * Polish copy for the Allegro promotion preview widget.
 *
 * Every string the widget renders lives here, so a future locale pass has exactly
 * one file to touch. The Medusa admin shell around the widget is English and stays
 * that way; this covers only what this plugin draws.
 *
 * The wording is written for a Polish operator rather than translated phrase by
 * phrase from the English original, so a few things read differently on purpose:
 * Wyróżnienie is named as the paid highlight it actually is, the reason codes are
 * spelled out as sentences somebody can act on rather than as literal renderings of
 * their identifiers, and the counts decline properly (1 aukcję, 2 aukcje, 5 aukcji)
 * instead of using one invariant plural.
 */

/**
 * The Polish plural of "aukcja" for a count, in the accusative the headline needs
 * ("Zmieni 1 aukcję", "Zmieni 2 aukcje", "Zmieni 5 aukcji").
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
  baseCompetitor: "Konkurencja: zmiana reguły",
  baseNone: "Nie wybrano (tylko podgląd)",
  baseSrp: "SRP: nadpisanie ceny",
  blockedTitle: "Ta promocja nie może sterować Allegro:",
  clampedToFloor: "ograniczone progiem rentowności",
  competitorCaveat: "nie obniży ceny, kiedy już jesteśmy najtańsi",
  costEdited: "koszt zmieniony w ciągu 30 dni",
  discountBaseHelp:
    "Wybór podstawy zapisuje wyłącznie to, z którego mechanizmu skorzysta automat. Nic nie trafia na Allegro. Dopóki podstawa nie jest wybrana, promocja pozostaje samym podglądem i nie da się jej uzbroić.",
  discountBaseLabel: "Podstawa obniżki",
  emptyRows: "Żadne objęte SKU nie ma na Allegro oferty, która kwalifikuje się do zmiany.",
  heading: "Podgląd promocji na Allegro",
  loadError: "Nie udało się wczytać podglądu Allegro.",
  loading: "Wczytywanie podglądu...",
  noWriteBody:
    "Widok pokazuje wyłącznie to, co ta promocja zrobiłaby z Twoimi aukcjami. Nic nie jest uzbrojone i nic nie zostanie opublikowane. Mechanizm, który miałby to wykonać, jeszcze nie powstał.",
  noWriteTitle: "Nic na tej stronie nie zapisuje się na Allegro",
  /** `code` doubles as the promotion's name: an automatic promotion has no separate name field. */
  promotionCodeLabel: "kod (nazwa promocji)",
  promotionCodeMissing: "brak",
  reasonHeader: "Powód",
  saleTrapBody:
    "Reguła „Bitdefender Sale” to płatne Wyróżnienie na Allegro. Zmienia tylko stawkę prowizji i nie ma nic wspólnego z obniżeniem ceny. Obniżka promocyjna to osobna reguła, z przedrostkiem ZR❯ widocznym w tabeli poniżej.",
  saleTrapTitle: "„Sale” w nazwie reguły to Wyróżnienie, a nie obniżka",
  saveError: "Nie udało się zapisać podstawy obniżki.",
  saveOk: "Zapisano podstawę obniżki. Nic nie zostało wysłane na Allegro.",
  skippedTitle: "Pominięte SKU (zostają bez zmian)",
  tableBreakEven: "Próg rentowności (pełne / surowe)",
  tableCost: "Koszt zakupu",
  tableHighlight: "Wyróżnienie",
  tableOverride: "SRP: nadpisanie ceny",
  tableRuleSwitch: "Konkurencja: zmiana reguły",
  tableSku: "SKU",
  tableSrp: "SRP",
} as const;

/** "Zmieni N aukcji. Reszta katalogu zostaje bez zmian." */
export const movesHeadline = (eligible: number): string =>
  `Zmieni ${eligible} ${auctionsPl(eligible)}. Reszta katalogu zostaje bez zmian.`;

/** The coverage sentence under the headline. */
export const coverageBody = (coverage: {
  targeted: number;
  linked: number;
  eligible: number;
  skipped: number;
}): string =>
  `Objęte SKU: ${coverage.targeted}. Powiązane z ofertą na Allegro: ${coverage.linked}. Gotowe do zmiany: ${coverage.eligible}. Pominięte: ${coverage.skipped}. ` +
  "Promocja nigdy nie dotyka aukcji spoza swoich produktów, więc reszta katalogu zostaje dokładnie taka, jaka jest. " +
  "Próg rentowności pokazujemy w pełnych złotych, a obok wartość surową, bo to, czy reguły Allegro wymagają pełnych złotych, pozostaje niepotwierdzone aż do pierwszego uzbrojenia synchronizacji cen.";

/** "po zakończeniu wraca do reguły X" */
export const revertsTo = (rule: string): string => `po zakończeniu wraca do reguły ${rule}`;

/**
 * Per-SKU skip reasons, keyed by the code the API returns.
 *
 * Spelled out as something an operator can act on. The codes stay the API contract;
 * only the rendering is Polish, so an unmapped code falls back to the raw value
 * rather than disappearing from the table.
 */
export const SKIP_REASON_PL: Record<string, string> = {
  "invalid-bounds": "próg rentowności jest równy SRP albo od niego wyższy",
  "missing-break-even": "brak progu rentowności, potrzebny koszt zakupu i prowizja kategorii",
  "missing-srp": "brak SRP, czyli górnego limitu ceny",
  "not-linked": "brak powiązanej oferty na Allegro",
  "offer-not-active": "oferta nie jest aktywna",
  "promotion-unresolved": "nie ustalono, czy oferta ma Wyróżnienie",
  "rule-name-too-long": "nazwa reguły przekroczyłaby limit 33 znaków",
  "status-unknown": "nie udało się odczytać statusu oferty",
  "sync-disabled": "synchronizacja ceny wyłączona dla tej oferty",
};

/** Promotion-level blockers, keyed by the code the API returns. */
export const BLOCK_REASON_PL: Record<string, string> = {
  "allegro-channel-excluded":
    "promocja jest ograniczona do kanałów sprzedaży, wśród których nie ma kanału Allegro",
  "discount-base-unset":
    "nie wybrano podstawy obniżki, więc nie wiadomo, którego mechanizmu użyć. Promocja pozostaje samym podglądem.",
  "discount-unsupported": "taki kształt obniżki nie ma wiernego odpowiednika na pojedynczej ofercie",
  "no-target-products": "promocja nie obejmuje żadnych produktów",
  "not-automatic":
    "promocja wymaga kodu. Allegro obsłuży tylko promocję automatyczną, bo przy aukcji nie ma koszyka, w którym kupujący wpisałby kod.",
};

/** Polish label for a code, falling back to the raw code when it is not mapped. */
export const labelFor = (map: Record<string, string>, code: string, fallback?: string): string =>
  map[code] ?? fallback ?? code;
