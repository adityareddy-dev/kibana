/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { FLEET_ENDPOINT_PACKAGE, PACKAGE_POLICY_SAVED_OBJECT_TYPE } from '@kbn/fleet-plugin/common';
import type { Agent } from '@kbn/fleet-plugin/common';
import {
  buildPolicyIdsOrVariantsKuery,
  removeVersionSuffixFromPolicyId,
} from '@kbn/fleet-plugin/common/services/version_specific_policies_utils';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { StepHandlerContext } from '@kbn/workflows-extensions/server';
import {
  type getEndpointInventoryCountsInputSchema,
  getEndpointInventoryCountsStepCommonDefinition,
} from '../../../../../../common/workflows/step_types/endpoint/hosts';
import { metadataCurrentIndexPattern } from '../../../../../../common/endpoint/constants';
import { collectPages } from '../../../../../endpoint/services/endpoint_host_selection';
import { parseNonNegativeInteger } from '../../common/number';
import { readErrorOutcome } from '../../common/read_error';
import { readKibanaApi } from '../../common/read_kibana_api';

const FLEET_AGENT_COUNT_PART = 'fleet_agent_count';
const UNITED_METADATA_COUNT_PART = 'united_metadata_count';
const CURRENT_METADATA_COUNT_PART = 'current_metadata_count';

const ENDPOINT_PACKAGE_POLICY_KUERY = `${PACKAGE_POLICY_SAVED_OBJECT_TYPE}.package.name:${FLEET_ENDPOINT_PACKAGE}`;

const PACKAGE_POLICY_PAGE_SIZE = 100;
const MAX_PACKAGE_POLICY_PAGES = 100;
const FLEET_AGENT_PAGE_SIZE = 100;
const MAX_FLEET_AGENT_PAGES = 100;
const MAX_ENCODED_POLICY_KUERY_LENGTH = 3000;

type InventoryContextManager = StepHandlerContext<
  typeof getEndpointInventoryCountsInputSchema
>['contextManager'];

interface CountOutcome {
  count?: number;
  unauthorized?: string;
  unavailable?: string;
}

interface PackagePolicyWithAgentCount {
  id: string;
  policy_ids: string[];
  agents?: unknown;
}

interface FleetInventoryOutcome extends CountOutcome {
  agentPolicyIds?: string[];
}

interface PackagePoliciesRouteResponse {
  items?: unknown;
  total?: unknown;
}

const readFleetAgentCount = async (
  contextManager: InventoryContextManager,
  signal: AbortSignal
): Promise<FleetInventoryOutcome> => {
  try {
    const { items, truncated } = await collectPages<PackagePolicyWithAgentCount>(
      async (page) => {
        signal.throwIfAborted();
        const query = new URLSearchParams({
          page: String(page),
          perPage: String(PACKAGE_POLICY_PAGE_SIZE),
          kuery: ENDPOINT_PACKAGE_POLICY_KUERY,
          withAgentCount: 'true',
        });
        const body = await readKibanaApi<PackagePoliciesRouteResponse>(
          contextManager,
          `/api/fleet/package_policies?${query.toString()}`,
          signal
        );
        const total = parseNonNegativeInteger(body?.total);
        if (!Array.isArray(body?.items) || total === undefined) {
          throw new Error('Invalid package policies response');
        }
        return {
          items: body.items as PackagePolicyWithAgentCount[],
          total,
        };
      },
      { pageSize: PACKAGE_POLICY_PAGE_SIZE, maxPages: MAX_PACKAGE_POLICY_PAGES }
    );
    if (truncated) {
      return { unavailable: FLEET_AGENT_COUNT_PART };
    }
    if (items.some(({ policy_ids: policyIds }) => !Array.isArray(policyIds))) {
      return { unavailable: FLEET_AGENT_COUNT_PART };
    }
    return {
      agentPolicyIds: [...new Set(items.flatMap(({ policy_ids: policyIds }) => policyIds))],
      count: items.reduce((total, item) => total + (parseNonNegativeInteger(item.agents) ?? 0), 0),
    };
  } catch (error) {
    signal.throwIfAborted();
    return readErrorOutcome(error, FLEET_AGENT_COUNT_PART);
  }
};

const readUnitedMetadataCount = async (
  contextManager: InventoryContextManager,
  signal: AbortSignal
): Promise<CountOutcome> => {
  const query = new URLSearchParams({ pageSize: '1' });
  try {
    signal.throwIfAborted();
    const body = await readKibanaApi<{ total?: unknown }>(
      contextManager,
      `/api/endpoint/metadata?${query.toString()}`,
      signal
    );
    const count = parseNonNegativeInteger(body?.total);
    return count !== undefined ? { count } : { unavailable: UNITED_METADATA_COUNT_PART };
  } catch (error) {
    signal.throwIfAborted();
    return readErrorOutcome(error, UNITED_METADATA_COUNT_PART);
  }
};

const readCurrentMetadataCount = async (
  contextManager: InventoryContextManager,
  fleetInventory: FleetInventoryOutcome,
  signal: AbortSignal
): Promise<CountOutcome> => {
  signal.throwIfAborted();
  const { agentPolicyIds, unauthorized } = fleetInventory;
  if (agentPolicyIds === undefined) {
    return unauthorized
      ? { unauthorized: CURRENT_METADATA_COUNT_PART }
      : { unavailable: CURRENT_METADATA_COUNT_PART };
  }
  if (agentPolicyIds.length === 0) {
    return { count: 0 };
  }
  try {
    const policyIds = new Set(agentPolicyIds);
    const policyKuery = `status:* and ${buildPolicyIdsOrVariantsKuery(agentPolicyIds)}`;
    const kuery =
      encodeURIComponent(policyKuery).length <= MAX_ENCODED_POLICY_KUERY_LENGTH
        ? policyKuery
        : 'status:*';
    const { items, truncated } = await collectPages<Pick<Agent, 'id' | 'policy_id'>>(
      async (page) => {
        signal.throwIfAborted();
        const query = new URLSearchParams({
          page: String(page),
          perPage: String(FLEET_AGENT_PAGE_SIZE),
          showInactive: 'true',
          kuery,
        });
        const body = await readKibanaApi<{
          items?: Array<Pick<Agent, 'id' | 'policy_id'>>;
          total?: number;
        }>(contextManager, `/api/fleet/agents?${query.toString()}`, signal);
        const total = parseNonNegativeInteger(body.total);
        if (!Array.isArray(body.items) || total === undefined) {
          throw new Error('Invalid Fleet agents response');
        }
        return {
          items: body.items.filter(
            (agent) =>
              agent.policy_id !== undefined &&
              policyIds.has(removeVersionSuffixFromPolicyId(agent.policy_id))
          ),
          total,
          rawItemCount: body.items.length,
        };
      },
      { pageSize: FLEET_AGENT_PAGE_SIZE, maxPages: MAX_FLEET_AGENT_PAGES }
    );
    signal.throwIfAborted();
    if (truncated) {
      return { unavailable: CURRENT_METADATA_COUNT_PART };
    }
    const agentIds = [...new Set(items.map(({ id }) => id))];
    if (agentIds.length === 0) {
      return { count: 0 };
    }
    const response = await contextManager.getScopedEsClient().count(
      {
        index: metadataCurrentIndexPattern,
        allow_no_indices: false,
        query: { terms: { 'agent.id': agentIds } },
      },
      { signal }
    );
    if (response._shards?.failed > 0) {
      return { unavailable: CURRENT_METADATA_COUNT_PART };
    }
    const count = parseNonNegativeInteger(response.count);
    return count !== undefined ? { count } : { unavailable: CURRENT_METADATA_COUNT_PART };
  } catch (error) {
    signal.throwIfAborted();
    return readErrorOutcome(error, CURRENT_METADATA_COUNT_PART);
  }
};

export const getEndpointInventoryCountsStepDefinition = createServerStepDefinition({
  ...getEndpointInventoryCountsStepCommonDefinition,
  handler: async (context) => {
    const fleetInventory = readFleetAgentCount(context.contextManager, context.abortSignal);
    const [fleetAgents, unitedMetadata, currentMetadata] = await Promise.all([
      fleetInventory,
      readUnitedMetadataCount(context.contextManager, context.abortSignal),
      fleetInventory.then((inventory) =>
        readCurrentMetadataCount(context.contextManager, inventory, context.abortSignal)
      ),
    ]);

    const unauthorized = [
      fleetAgents.unauthorized,
      unitedMetadata.unauthorized,
      currentMetadata.unauthorized,
    ].filter((part): part is string => part !== undefined);
    const unavailable = [
      fleetAgents.unavailable,
      unitedMetadata.unavailable,
      currentMetadata.unavailable,
    ].filter((part): part is string => part !== undefined);

    return {
      output: {
        ...(fleetAgents.count !== undefined ? { fleet_agent_count: fleetAgents.count } : {}),
        ...(unitedMetadata.count !== undefined
          ? { united_metadata_count: unitedMetadata.count }
          : {}),
        ...(currentMetadata.count !== undefined
          ? { current_metadata_count: currentMetadata.count }
          : {}),
        unauthorized,
        unavailable,
      },
    };
  },
});
