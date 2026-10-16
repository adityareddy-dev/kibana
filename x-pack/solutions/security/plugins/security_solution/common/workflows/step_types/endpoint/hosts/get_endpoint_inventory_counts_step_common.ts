/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { z, lazySchema } from '@kbn/zod/v4';
import { i18n } from '@kbn/i18n';
import { StepCategory } from '@kbn/workflows';
import type { BaseStepDefinition } from '@kbn/workflows';
import { countSchema, endpointPartSchema, inventoryPartValues } from './hosts_contracts';

export const GetEndpointInventoryCountsStepId = 'security.getEndpointInventoryCounts' as const;

export const getEndpointInventoryCountsInputSchema = lazySchema(() => z.object({}));

export const getEndpointInventoryCountsOutputSchema = lazySchema(() =>
  z.object({
    fleet_agent_count: countSchema.optional(),
    united_metadata_count: countSchema.optional(),
    current_metadata_count: countSchema.optional(),
    unauthorized: z.array(endpointPartSchema).max(inventoryPartValues.length),
    unavailable: z.array(endpointPartSchema).max(inventoryPartValues.length),
  })
);

export const getEndpointInventoryCountsStepCommonDefinition: BaseStepDefinition<
  typeof getEndpointInventoryCountsInputSchema,
  typeof getEndpointInventoryCountsOutputSchema
> = {
  id: GetEndpointInventoryCountsStepId,
  label: i18n.translate('xpack.securitySolution.workflows.steps.getEndpointInventoryCounts.label', {
    defaultMessage: 'Get endpoint inventory counts',
  }),
  description: i18n.translate(
    'xpack.securitySolution.workflows.steps.getEndpointInventoryCounts.description',
    {
      defaultMessage:
        'Count Elastic Defend agents in Fleet, hosts on the Endpoint list, and current endpoint metadata documents. A count is absent when it could not be read. This step is tech preview; its contract can change.',
    }
  ),
  category: StepCategory.KibanaSecurity,
  stability: 'tech_preview',
  inputSchema: getEndpointInventoryCountsInputSchema,
  outputSchema: getEndpointInventoryCountsOutputSchema,
  documentation: {
    details: i18n.translate(
      'xpack.securitySolution.workflows.steps.getEndpointInventoryCounts.documentation.details',
      {
        defaultMessage:
          "Reads the Fleet agent total (Elastic Defend agents Fleet marks active, including inactive and uninstalled agents), the hosts on this space's Endpoint list, and current endpoint metadata documents of the Fleet agents in this space on an agent policy with Elastic Defend, including inactive and unenrolled agents. The step pages those agent IDs as the invoking user; when the agent list is cut off or unread, the current metadata count is absent with its caveat. The counts cover different sets of hosts, so a difference between them does not name a cause. An unread count is absent and has an entry in unauthorized or unavailable.",
      }
    ),
    examples: [
      `## Count endpoint inventory
\`\`\`yaml
- name: inventory_counts
  type: security.getEndpointInventoryCounts
\`\`\``,
    ],
  },
};
