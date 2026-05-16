/**
 * The connector registry. Add a new connector by appending here.
 * The orchestrator and chat layer reach for sources only by name.
 */

import type { Connector } from "./types";
import type { Source } from "./source";
import { ShopifyConnector } from "./shopify";
import { MetaConnector } from "./meta";
import { ShiprocketConnector } from "./shiprocket";
import { CsvConnector } from "./csv";

const registry: Record<Source, () => Connector> = {
  shopify: () => new ShopifyConnector(),
  meta: () => new MetaConnector(),
  shiprocket: () => new ShiprocketConnector(),
  csv: () => new CsvConnector(),
};

export function makeConnector(source: Source): Connector {
  return registry[source]();
}

export { ShopifyConnector, MetaConnector, ShiprocketConnector, CsvConnector };
export type { Connector };
