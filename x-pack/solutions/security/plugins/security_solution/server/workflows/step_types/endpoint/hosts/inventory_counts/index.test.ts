/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { StepHandlerContext } from '@kbn/workflows-extensions/server';
import {
  type getEndpointInventoryCountsInputSchema,
  getEndpointInventoryCountsOutputSchema,
} from '../../../../../../common/workflows/step_types/endpoint/hosts';
import { getEndpointInventoryCountsStepDefinition } from '.';

type InventoryContext = StepHandlerContext<typeof getEndpointInventoryCountsInputSchema>;

const createContext = (callKibanaApi: jest.Mock, esCount: jest.Mock): InventoryContext =>
  ({
    input: {},
    abortSignal: new AbortController().signal,
    contextManager: {
      callKibanaApi: jest.fn().mockImplementation((params: { path: string }) =>
        params.path.startsWith('/api/fleet/agents')
          ? {
              body: {
                items: [{ id: 'agent-1', policy_id: 'agent-policy-0' }],
                total: 1,
              },
            }
          : callKibanaApi(params)
      ),
      getScopedEsClient: jest.fn().mockReturnValue({ count: esCount }),
      getFakeRequest: jest.fn(),
      getContext: jest.fn(),
      renderInputTemplate: jest.fn(),
    },
  } as unknown as InventoryContext);

const readQuery = (path: string): URLSearchParams => new URL(`http://kibana${path}`).searchParams;

const run = async (callKibanaApi: jest.Mock, esCount: jest.Mock) => {
  const result = await getEndpointInventoryCountsStepDefinition.handler(
    createContext(callKibanaApi, esCount)
  );
  expect(getEndpointInventoryCountsOutputSchema.safeParse(result.output).success).toBe(true);
  return result.output!;
};

describe('getEndpointInventoryCountsStepDefinition', () => {
  const packagePoliciesRoute = (
    items: Array<{ id?: string; policy_ids?: string[]; agents?: number }>,
    total: number = items.length
  ) => ({
    status: 200,
    headers: {},
    body: {
      items: items.map((item, index) => ({
        id: `policy-${index}`,
        policy_ids: [`agent-policy-${index}`],
        ...item,
      })),
      total,
    },
  });

  it('returns the three counts when every read succeeds', async () => {
    const callKibanaApi = jest
      .fn()
      .mockImplementation(async ({ path }: { path: string }) =>
        path.startsWith('/api/fleet/package_policies')
          ? packagePoliciesRoute([{ agents: 4 }])
          : { status: 200, headers: {}, body: { total: 6 } }
      );
    const esCount = jest.fn().mockResolvedValue({ count: 9 });

    const output = await run(callKibanaApi, esCount);

    expect(output.fleet_agent_count).toBe(4);
    expect(output.united_metadata_count).toBe(6);
    expect(output.current_metadata_count).toBe(9);
    expect(esCount).toHaveBeenCalledWith(
      {
        index: 'metrics-endpoint.metadata_current_*',
        allow_no_indices: false,
        query: { terms: { 'agent.id': ['agent-1'] } },
      },
      { signal: expect.any(AbortSignal) }
    );
    expect(output.unauthorized).toEqual([]);
    expect(output.unavailable).toEqual([]);
  });

  it.each(['failed shards', 'missing index'])(
    'omits the current count and preserves other counts for %s',
    async (failure) => {
      const callKibanaApi = jest
        .fn()
        .mockImplementation(async ({ path }: { path: string }) =>
          path.startsWith('/api/fleet/package_policies')
            ? packagePoliciesRoute([{ agents: 4 }])
            : { status: 200, headers: {}, body: { total: 6 } }
        );
      const esCount = jest.fn();
      if (failure === 'failed shards') {
        esCount.mockResolvedValue({ count: 9, _shards: { failed: 1 } });
      } else {
        esCount.mockRejectedValue({
          meta: { statusCode: 404 },
          body: { error: { type: 'index_not_found_exception' } },
        });
      }

      const output = await run(callKibanaApi, esCount);

      expect(output.current_metadata_count).toBeUndefined();
      expect(output.unavailable).toEqual(['current_metadata_count']);
      expect(output.unauthorized).toEqual([]);
      expect(output.fleet_agent_count).toBe(4);
      expect(output.united_metadata_count).toBe(6);
    }
  );

  it('sums the fleet agent count across more than one package policy page', async () => {
    const firstPage = Array.from({ length: 100 }, () => ({ agents: 1 }));
    const lastPage = [
      { id: 'policy-100', agents: 1 },
      { id: 'policy-101', agents: 1 },
    ];
    const callKibanaApi = jest.fn().mockImplementation(async ({ path }: { path: string }) => {
      if (path.startsWith('/api/fleet/package_policies')) {
        return readQuery(path).get('page') === '2'
          ? packagePoliciesRoute(lastPage, 102)
          : packagePoliciesRoute(firstPage, 102);
      }
      return { status: 200, headers: {}, body: { total: 6 } };
    });
    const esCount = jest.fn().mockResolvedValue({ count: 9 });

    const output = await run(callKibanaApi, esCount);

    expect(output.fleet_agent_count).toBe(102);
    const packagePolicyCalls = callKibanaApi.mock.calls
      .map(([params]) => params as { path: string })
      .filter((params) => params.path.startsWith('/api/fleet/package_policies'));
    expect(packagePolicyCalls).toHaveLength(2);
    expect(esCount).toHaveBeenCalledWith(
      expect.objectContaining({
        query: {
          terms: {
            'agent.id': ['agent-1'],
          },
        },
      }),
      { signal: expect.any(AbortSignal) }
    );
    for (const { path } of packagePolicyCalls) {
      expect(readQuery(path).get('kuery')).toBe('fleet-package-policies.package.name:endpoint');
      expect(readQuery(path).get('withAgentCount')).toBe('true');
    }
  });

  it('omits fleet and current metadata counts when the package policy walk reaches its cap', async () => {
    const callKibanaApi = jest.fn().mockImplementation(async ({ path }: { path: string }) =>
      path.startsWith('/api/fleet/package_policies')
        ? packagePoliciesRoute(
            Array.from({ length: 100 }, () => ({ agents: 1 })),
            10001
          )
        : { status: 200, headers: {}, body: { total: 6 } }
    );

    const esCount = jest.fn().mockResolvedValue({ count: 9 });
    const output = await run(callKibanaApi, esCount);

    expect(output.fleet_agent_count).toBeUndefined();
    expect(output.unavailable).toEqual(['fleet_agent_count', 'current_metadata_count']);
    expect(output.unauthorized).toEqual([]);
    expect(output.united_metadata_count).toBe(6);
    expect(output.current_metadata_count).toBeUndefined();
    expect(esCount).not.toHaveBeenCalled();
    const pages = callKibanaApi.mock.calls
      .map(([{ path }]) => path as string)
      .filter((path) => path.startsWith('/api/fleet/package_policies'));
    expect(pages).toHaveLength(100);
    expect(readQuery(pages[99]).get('page')).toBe('100');
    expect(readQuery(pages[99]).get('perPage')).toBe('100');
  });

  it.each([0, 403, 500])(
    'does not read current metadata for an empty or failed policy read (%s)',
    async (status) => {
      const callKibanaApi = jest.fn().mockImplementation(async ({ path }: { path: string }) => {
        if (path.startsWith('/api/fleet/package_policies')) {
          if (status !== 0) {
            throw Object.assign(new Error('Policy read failed'), { meta: { statusCode: status } });
          }
          return packagePoliciesRoute([]);
        }
        return { status: 200, headers: {}, body: { total: 6 } };
      });
      const esCount = jest.fn();
      const output = await run(callKibanaApi, esCount);

      expect(esCount).not.toHaveBeenCalled();
      expect(output.current_metadata_count).toBe(status === 0 ? 0 : undefined);
      expect(output.fleet_agent_count).toBe(status === 0 ? 0 : undefined);
      expect(output.unauthorized).toEqual(
        status === 403 ? ['fleet_agent_count', 'current_metadata_count'] : []
      );
      expect(output.unavailable).toEqual(
        status === 500 ? ['fleet_agent_count', 'current_metadata_count'] : []
      );
      expect(output.united_metadata_count).toBe(6);
    }
  );

  it.each([1, 100])(
    'scopes current metadata across Fleet pages (%s agent policies)',
    async (policyCount) => {
      const esCount = jest.fn().mockResolvedValue({ count: 2 });
      const callKibanaApi = jest.fn().mockImplementation(async ({ path }: { path: string }) =>
        path.startsWith('/api/fleet/package_policies')
          ? packagePoliciesRoute([
              {
                policy_ids: Array.from(
                  { length: policyCount },
                  (_, index) => `agent-policy-${index}`
                ),
                agents: 1,
              },
            ])
          : { body: { total: 6 } }
      );
      const context = createContext(callKibanaApi, esCount);
      const fleetPages: number[] = [];
      const routeRead = context.contextManager.callKibanaApi;
      context.contextManager.callKibanaApi = jest.fn().mockImplementation((params) => {
        if (!params.path.startsWith('/api/fleet/agents')) {
          return routeRead(params);
        }
        const query = readQuery(params.path);
        expect(query.get('showInactive')).toBe('true');
        expect(query.get('kuery')).toBe(
          policyCount === 1
            ? 'status:* and (policy_id:(agent-policy-0) or policy_id:agent-policy-0#*)'
            : 'status:*'
        );
        const page = Number(query.get('page'));
        fleetPages.push(page);
        return {
          body: {
            total: 101,
            items:
              page === 1
                ? Array.from({ length: 100 }, (_, index) => ({
                    id: `agent-${index}`,
                    policy_id: index === 0 ? 'agent-policy-0' : 'other-policy',
                    active: false,
                    status: 'unenrolled',
                  }))
                : [{ id: 'inactive-agent', policy_id: 'agent-policy-0#9.2', status: 'inactive' }],
          },
        };
      });

      const result = await getEndpointInventoryCountsStepDefinition.handler(context);

      expect(result.output!.current_metadata_count).toBe(2);
      expect(fleetPages).toEqual([1, 2]);
      expect(esCount).toHaveBeenCalledWith(
        expect.objectContaining({
          query: { terms: { 'agent.id': ['agent-0', 'inactive-agent'] } },
        }),
        { signal: context.abortSignal }
      );
    }
  );

  it.each([403, 500, 'cap'])(
    'omits the current count instead of counting a partial Fleet read (%s)',
    async (failure) => {
      const callKibanaApi = jest
        .fn()
        .mockImplementation(async ({ path }: { path: string }) =>
          path.startsWith('/api/fleet/package_policies')
            ? packagePoliciesRoute([{ agents: 1 }])
            : { body: { total: 6 } }
        );
      const esCount = jest.fn();
      const context = createContext(callKibanaApi, esCount);
      const routeRead = context.contextManager.callKibanaApi;
      const fleetRead = jest.fn().mockImplementation(() => {
        if (failure !== 'cap') {
          throw Object.assign(new Error('Fleet read failed'), { statusCode: failure });
        }
        return {
          body: {
            items: Array.from({ length: 100 }, (_, index) => ({
              id: `agent-${index}`,
              policy_id: 'agent-policy-0',
            })),
            total: 10001,
          },
        };
      });
      context.contextManager.callKibanaApi = jest
        .fn()
        .mockImplementation((params) =>
          params.path.startsWith('/api/fleet/agents') ? fleetRead() : routeRead(params)
        );

      const { output } = await getEndpointInventoryCountsStepDefinition.handler(context);

      expect(output!.current_metadata_count).toBeUndefined();
      expect(output!.fleet_agent_count).toBe(1);
      expect(output!.united_metadata_count).toBe(6);
      expect(output!.unauthorized).toEqual(failure === 403 ? ['current_metadata_count'] : []);
      expect(output!.unavailable).toEqual(failure === 403 ? [] : ['current_metadata_count']);
      expect(esCount).not.toHaveBeenCalled();
      expect(fleetRead).toHaveBeenCalledTimes(failure === 'cap' ? 100 : 1);
    }
  );

  it('stops an aborted inventory read rather than returning a caveat', async () => {
    const controller = new AbortController();
    const callKibanaApi = jest.fn().mockImplementation(() => {
      controller.abort();
      throw controller.signal.reason;
    });
    const esCount = jest.fn();
    const context = createContext(callKibanaApi, esCount);
    context.abortSignal = controller.signal;

    await expect(getEndpointInventoryCountsStepDefinition.handler(context)).rejects.toThrow();
    expect(esCount).not.toHaveBeenCalled();
  });

  it('omits current_metadata_count and marks it unauthorized on an ES security exception', async () => {
    const callKibanaApi = jest
      .fn()
      .mockImplementation(async ({ path }: { path: string }) =>
        path.startsWith('/api/fleet/package_policies')
          ? packagePoliciesRoute([{ agents: 4 }])
          : { status: 200, headers: {}, body: { total: 4 } }
      );
    const esCount = jest.fn().mockRejectedValue({
      meta: { statusCode: 403 },
      body: { error: { type: 'security_exception' } },
    });

    const output = await run(callKibanaApi, esCount);

    expect(output.current_metadata_count).toBeUndefined();
    expect(output.unauthorized).toEqual(['current_metadata_count']);
    expect(output.fleet_agent_count).toBe(4);
    expect(output.united_metadata_count).toBe(4);
  });
});
