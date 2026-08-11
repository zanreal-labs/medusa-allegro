import { Module } from "@medusajs/framework/utils";
import validateAllegroOptions from "./loaders/validate-options";
import AllegroModuleService from "./service";

/**
 * Container registration key for the Allegro module.
 *
 * Resolve it from anywhere that has the Medusa container:
 *
 *   const allegro = req.scope.resolve(ALLEGRO_MODULE) as AllegroModuleService
 */
export const ALLEGRO_MODULE = "allegro";

export default Module(ALLEGRO_MODULE, {
  loaders: [validateAllegroOptions],
  service: AllegroModuleService,
});
