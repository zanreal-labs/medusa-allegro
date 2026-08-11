import { defineRouteConfig } from "@medusajs/admin-sdk";
import { Alert, Button, Container, Heading, Input, Table, Text, toast } from "@medusajs/ui";
import { useCallback, useEffect, useState } from "react";
import { formatRate } from "../../../lib/format";
import { sdk } from "../../../lib/sdk";
import type { CategoryRateRow, CategoryRatesResponse } from "../../../lib/types";

/**
 * The commission rates that set every price floor.
 *
 * Maintained by hand, and there is no API alternative: Allegro's fee calculator
 * rejects the offer bodies a seller can build from their own live offers, so the
 * published fee table is the source and this is where it is entered.
 *
 * A blank field means "not set", and it stays visibly different from 0. That
 * distinction is the whole point of the screen: price sync skips an offer whose
 * category rate is blank with reason `missing-break-even`, whereas a rate of 0 would
 * floor it at cost. Rendering blank as "0" would tell an operator the opposite of what
 * is happening.
 *
 * The two rates are independent. A category commonly has its standard rate filled in
 * long before its promoted one, and a promoted offer whose promoted rate is blank is
 * skipped even though the standard rate is there - so both columns need to be visibly
 * fillable, and saving one must not clear the other.
 */

interface Draft {
  commission: string;
  promoted: string;
}

const AllegroCategoryRatesPage = () => {
  const [rates, setRates] = useState<CategoryRateRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loadError, setLoadError] = useState<string | undefined>();
  const [busyId, setBusyId] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      const response = await sdk.client.fetch<CategoryRatesResponse>(
        "/admin/allegro/category-rates",
      );
      setRates(response.category_rates);
      setDrafts(
        Object.fromEntries(
          response.category_rates.map((row) => [
            row.category_id,
            {
              commission: formatRate(row.commission_rate),
              promoted: formatRate(row.promoted_commission_rate),
            },
          ]),
        ),
      );
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load the category rates.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (row: CategoryRateRow) => {
    const draft = drafts[row.category_id];
    if (!draft) {
      return;
    }
    setBusyId(row.category_id);
    try {
      await sdk.client.fetch("/admin/allegro/category-rates", {
        body: {
          category_id: row.category_id,
          // An empty field is sent as null, which CLEARS the rate. That is a real,
          // intended action: it makes price sync skip the category again rather than
          // flooring it on a rate the operator no longer trusts.
          commission_rate: draft.commission.trim() === "" ? null : draft.commission.trim(),
          promoted_commission_rate: draft.promoted.trim() === "" ? null : draft.promoted.trim(),
        },
        method: "POST",
      });
      toast.success(`Saved rates for ${row.category_id}.`);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the rates.");
    } finally {
      setBusyId(undefined);
    }
  };

  const unset = rates.filter(
    (row) =>
      row.commission_rate === null ||
      row.commission_rate === undefined ||
      row.promoted_commission_rate === null ||
      row.promoted_commission_rate === undefined,
  ).length;

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h1">Allegro category rates</Heading>
        <Text className="text-ui-fg-subtle" size="small">
          Sale commission per category, as percentages, entered from Allegro's published fee table.
          These set the break-even price floor, so an offer in a category with a blank rate is
          skipped by price sync rather than floored at cost.
        </Text>
      </div>

      {loadError ? (
        <div className="px-6 py-4">
          <Alert variant="error">{loadError}</Alert>
        </div>
      ) : null}

      {unset > 0 ? (
        <div className="px-6 py-4">
          <Alert variant="warning">
            {unset} categor{unset === 1 ? "y has" : "ies have"} at least one rate unset. Price sync
            skips those offers with reason `missing-break-even` - a blank rate is deliberately not
            read as 0%, because that would turn a loss-making price into an acceptable floor.
          </Alert>
        </div>
      ) : null}

      <div className="overflow-x-auto px-6 py-4">
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Category</Table.HeaderCell>
              <Table.HeaderCell>Standard %</Table.HeaderCell>
              <Table.HeaderCell>Promoted %</Table.HeaderCell>
              <Table.HeaderCell> </Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rates.map((row) => (
              <Table.Row key={row.id}>
                <Table.Cell>
                  <div className="flex flex-col">
                    <span className="txt-compact-small-plus">{row.name ?? row.category_id}</span>
                    <span className="text-ui-fg-muted txt-compact-xsmall">{row.category_id}</span>
                  </div>
                </Table.Cell>
                <Table.Cell>
                  <Input
                    className="w-28"
                    onChange={(changeEvent) =>
                      setDrafts((current) => ({
                        ...current,
                        [row.category_id]: {
                          commission: changeEvent.target.value,
                          promoted: current[row.category_id]?.promoted ?? "",
                        },
                      }))
                    }
                    placeholder="not set"
                    value={drafts[row.category_id]?.commission ?? ""}
                  />
                </Table.Cell>
                <Table.Cell>
                  <Input
                    className="w-28"
                    onChange={(changeEvent) =>
                      setDrafts((current) => ({
                        ...current,
                        [row.category_id]: {
                          commission: current[row.category_id]?.commission ?? "",
                          promoted: changeEvent.target.value,
                        },
                      }))
                    }
                    placeholder="not set"
                    value={drafts[row.category_id]?.promoted ?? ""}
                  />
                </Table.Cell>
                <Table.Cell>
                  <div className="flex justify-end">
                    <Button
                      disabled={busyId === row.category_id}
                      onClick={() => void save(row)}
                      size="small"
                      variant="secondary"
                    >
                      Save
                    </Button>
                  </div>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>

        {rates.length === 0 ? (
          <Text className="text-ui-fg-muted py-4" size="small">
            No categories yet. Offer discovery creates a row for every category the seller's live
            offers reference, with blank rates for you to fill in.
          </Text>
        ) : null}
      </div>
    </Container>
  );
};

export const config = defineRouteConfig({
  label: "Category rates",
});

export default AllegroCategoryRatesPage;
