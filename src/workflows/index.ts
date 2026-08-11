/**
 * Public workflow surface of the plugin.
 *
 * Exposed through the `./workflows` package export so a host project can run any
 * loop on its own schedule, or from its own admin action, without reaching into
 * the plugin's internals. Each engine is exported as both a workflow (for
 * `.run({ container })`) and a plain function (so a caller chaining several loops
 * can pass one offer listing through all of them instead of paying for three).
 */

export {
  discoverAllegroOffersWorkflow,
  emptyDiscoverOffersResult,
  runOfferDiscovery,
} from "./discover-allegro-offers";
export type { DiscoverOffersOutput, DiscoverOffersResult } from "./discover-allegro-offers";
