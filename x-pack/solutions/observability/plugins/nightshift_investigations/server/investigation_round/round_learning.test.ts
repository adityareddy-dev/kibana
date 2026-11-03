/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createConversationNotFoundError } from '@kbn/agent-builder-common';
import { HYPOTHESES_ATTACHMENT_TYPE } from '@kbn/agentic-investigations-plugin/common';
import { ALERT_RECOVERED_FOLLOW_UP } from '../client/investigations_client';
import {
  countsAsConfirmation,
  formatRoundOutcome,
  loadRoundOutcome,
  readRoundOutcome,
  type ReadInvestigationRun,
} from './round_learning';
import type { RoundResolution } from './round_outcome';

interface Hypothesis {
  candidate: string;
  status: string;
  reason?: string;
}

const gateway = (status: string): Hypothesis => ({
  candidate: 'Gateway connection pool exhaustion',
  status,
  reason: `**Tested:** pool metrics.\n**Result:** ${status}.`,
});
const database = (status: string): Hypothesis => ({ candidate: 'Database failover', status });

const R1 = { id: 'r1', started_at: '2026-11-02T10:00:00.000Z' };
const R2 = { id: 'r2', started_at: '2026-11-02T10:10:00.000Z' };
const AFTER_R1 = '2026-11-02T10:05:00.000Z';
const AFTER_R2 = '2026-11-02T10:15:00.000Z';
const RUN_2_STARTED = '2026-11-02T10:09:00.000Z';

const conversation = (
  rounds: Array<typeof R1>,
  versions: Array<[string, Hypothesis[]]> = [],
  workflowExecutionIds: string[] = []
) => ({
  rounds,
  metadata: { workflow_execution_ids: workflowExecutionIds },
  attachments: [
    {
      type: HYPOTHESES_ATTACHMENT_TYPE,
      versions: versions.map(([at, hypotheses]) => ({
        created_at: at,
        data: { id: 'h', conversationId: 'c', hypotheses },
      })),
    },
  ],
});

const resolution = (overrides: Partial<RoundResolution>): RoundResolution => ({
  roundKind: 'follow_up',
  roundId: 'r2',
  outcome: 'unchanged',
  newlyConfirmed: [],
  noLongerConfirmed: [],
  stillConfirmed: [],
  ...overrides,
});

describe('countsAsConfirmation', () => {
  it.each<[string, RoundResolution | undefined, boolean]>([
    ['a first round', resolution({ roundKind: 'initial', outcome: 'unknown' }), true],
    ['a follow-up that found a cause', resolution({ outcome: 'found' }), true],
    ['a follow-up that changed the cause', resolution({ outcome: 'changed' }), true],
    ['a follow-up that changed nothing', resolution({}), false],
    ['a follow-up with no record', resolution({ outcome: 'unknown' }), false],
    [
      'a recovery that kept the cause',
      resolution({ roundKind: 'alert_recovery', stillConfirmed: [gateway('confirmed')] }),
      true,
    ],
    ['a recovery with nothing confirmed', resolution({ roundKind: 'alert_recovery' }), false],
    [
      'a recovery that withdrew the cause',
      resolution({ roundKind: 'alert_recovery', outcome: 'withdrawn' }),
      false,
    ],
    ['a round that could not be read', undefined, false],
  ])('%s', (_case, round, expected) => {
    expect(countsAsConfirmation(round)).toBe(expected);
  });
});

describe('formatRoundOutcome', () => {
  it('says nothing for a first round', () => {
    expect(formatRoundOutcome(resolution({ roundKind: 'initial' }))).toBeUndefined();
  });

  it('states the change, the verdict and the causes with their reasons', () => {
    const text = formatRoundOutcome(
      resolution({
        outcome: 'changed',
        newlyConfirmed: [database('confirmed')],
        noLongerConfirmed: [gateway('dismissed')],
      })
    );
    expect(text).toContain(
      'dropped the root cause confirmed earlier and confirmed a different one'
    );
    expect(text).toContain('Treat the confirmed root cause as verified.');
    expect(text).toContain('Newly confirmed:\n- Database failover (confirmed)');
    expect(text).toContain(
      'No longer confirmed:\n- Gateway connection pool exhaustion (dismissed)\n  **Tested:** pool metrics.\n  **Result:** dismissed.'
    );
  });

  it('tells a round that verified nothing not to treat a cause as verified', () => {
    expect(formatRoundOutcome(resolution({ stillConfirmed: [gateway('confirmed')] }))).toContain(
      'do not treat any cause as verified because of it'
    );
    expect(formatRoundOutcome(undefined)).toContain('Do not treat any cause as verified');
  });

  it('says a recovery kept the cause', () => {
    expect(
      formatRoundOutcome(
        resolution({ roundKind: 'alert_recovery', stillConfirmed: [gateway('confirmed')] })
      )
    ).toContain(
      'This round followed the alert recovering. The alert recovered and the root cause confirmed earlier still holds. Treat the confirmed root cause as verified.'
    );
  });
});

describe('readRoundOutcome', () => {
  it('reads again until the follow-up round is saved', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce(conversation([R1]))
      .mockResolvedValueOnce(
        conversation(
          [R1, R2],
          [
            [AFTER_R1, [gateway('investigating')]],
            [AFTER_R2, [gateway('confirmed')]],
          ]
        )
      );
    const { outcome, rounds } = await readRoundOutcome({
      conversations: { get } as never,
      conversationId: 'c',
      roundId: 'r2',
      retryDelaysMs: [0, 0],
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ roundKind: 'follow_up', outcome: 'found' });
    expect(rounds.map(({ id }) => id)).toEqual(['r1', 'r2']);
  });

  it('gives up as unknown when the round is never saved', async () => {
    const get = jest.fn().mockResolvedValue(conversation([R1]));
    const { outcome } = await readRoundOutcome({
      conversations: { get } as never,
      conversationId: 'c',
      roundId: 'r2',
      retryDelaysMs: [0, 0],
    });
    expect(get).toHaveBeenCalledTimes(3);
    expect(outcome).toMatchObject({ roundKind: 'follow_up', outcome: 'unknown' });
  });

  it('does not wait for a first round', async () => {
    const get = jest.fn().mockResolvedValue(conversation([]));
    const { outcome } = await readRoundOutcome({
      conversations: { get } as never,
      conversationId: 'c',
      roundId: 'r1',
      retryDelaysMs: [0, 0],
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ roundKind: 'initial', outcome: 'unknown' });
  });

  it('reads a conversation that does not exist as a first round, and throws on other errors', async () => {
    const notFound = jest
      .fn()
      .mockRejectedValue(createConversationNotFoundError({ conversationId: 'c' }));
    await expect(
      readRoundOutcome({
        conversations: { get: notFound } as never,
        conversationId: 'c',
        roundId: 'r1',
      })
    ).resolves.toMatchObject({ outcome: { roundKind: 'initial' } });

    const failing = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(
      readRoundOutcome({
        conversations: { get: failing } as never,
        conversationId: 'c',
        roundId: 'r1',
      })
    ).rejects.toThrow('boom');
  });

  describe('telling an alert recovery from a follow-up', () => {
    const kept = conversation(
      [R1, R2],
      [
        [AFTER_R1, [gateway('confirmed')]],
        [AFTER_R2, [gateway('confirmed')]],
      ],
      ['run-1', 'run-2']
    );
    const readRun =
      (followUp?: string, startedAt = RUN_2_STARTED): ReadInvestigationRun =>
      async (executionId) =>
        executionId === 'run-2' ? { startedAt, ...(followUp ? { followUp } : {}) } : undefined;

    it('reads the latest run on the conversation, and its follow_up', async () => {
      const readInvestigationRun = jest.fn(readRun(ALERT_RECOVERED_FOLLOW_UP));
      const { outcome } = await readRoundOutcome({
        conversations: { get: jest.fn().mockResolvedValue(kept) } as never,
        conversationId: 'c',
        roundId: 'r2',
        readInvestigationRun,
      });
      expect(readInvestigationRun).toHaveBeenCalledWith('run-2');
      expect(outcome).toMatchObject({ roundKind: 'alert_recovery', outcome: 'unchanged' });
      expect(countsAsConfirmation(outcome)).toBe(true);
    });

    it.each([
      ['the run is a plain follow-up', readRun('feedback')],
      ['the run did not produce this round', readRun(ALERT_RECOVERED_FOLLOW_UP, AFTER_R2)],
      ['the run is not an investigation run', async () => undefined],
    ])('is a follow-up when %s', async (_case, readInvestigationRun) => {
      const { outcome } = await readRoundOutcome({
        conversations: { get: jest.fn().mockResolvedValue(kept) } as never,
        conversationId: 'c',
        roundId: 'r2',
        readInvestigationRun,
      });
      expect(outcome).toMatchObject({ roundKind: 'follow_up', outcome: 'unchanged' });
      expect(countsAsConfirmation(outcome)).toBe(false);
    });
  });
});

describe('loadRoundOutcome', () => {
  const logger = { warn: jest.fn() };
  const request = {} as never;

  it('keeps a run without a conversation as a first round', async () => {
    await expect(
      loadRoundOutcome({ agentBuilder: undefined, request, spaceId: 'default', logger })
    ).resolves.toMatchObject({ roundKind: 'initial' });
  });

  it('is undefined, and logs, when the conversation cannot be read', async () => {
    const agentBuilder = {
      conversations: {
        getScopedClient: jest.fn().mockResolvedValue({
          get: jest.fn().mockRejectedValue(new Error('forbidden')),
        }),
      },
    } as never;
    await expect(
      loadRoundOutcome({
        agentBuilder,
        request,
        spaceId: 'default',
        conversationId: 'c',
        roundId: 'r2',
        logger,
      })
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('forbidden'));

    await expect(
      loadRoundOutcome({
        agentBuilder: undefined,
        request,
        spaceId: 'default',
        conversationId: 'c',
        roundId: 'r2',
        logger,
      })
    ).resolves.toBeUndefined();
  });

  it('reads the run through Workflows as the request user', async () => {
    const getWorkflowExecution = jest.fn().mockResolvedValue(undefined);
    const agentBuilder = {
      conversations: {
        getScopedClient: jest.fn().mockResolvedValue({
          get: jest.fn().mockResolvedValue(conversation([R1, R2], [], ['run-2'])),
        }),
      },
    } as never;
    await loadRoundOutcome({
      agentBuilder,
      workflowsManagement: { management: { getWorkflowExecution } } as never,
      request,
      spaceId: 'space-a',
      conversationId: 'c',
      roundId: 'r2',
      logger,
    });
    expect(getWorkflowExecution).toHaveBeenCalledWith('run-2', 'space-a', {
      includeOutput: false,
      request,
    });
  });

  it('reads a round whose run cannot be read as a follow-up, and logs', async () => {
    const warn = jest.fn();
    const agentBuilder = {
      conversations: {
        getScopedClient: jest.fn().mockResolvedValue({
          get: jest.fn().mockResolvedValue(conversation([R1, R2], [], ['run-2'])),
        }),
      },
    } as never;
    await expect(
      loadRoundOutcome({
        agentBuilder,
        workflowsManagement: {
          management: { getWorkflowExecution: jest.fn().mockRejectedValue(new Error('denied')) },
        } as never,
        request,
        spaceId: 'default',
        conversationId: 'c',
        roundId: 'r2',
        logger: { warn },
      })
    ).resolves.toMatchObject({ roundKind: 'follow_up', outcome: 'unknown' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('denied'));
  });

  it('does not read the run of a first round', async () => {
    const getWorkflowExecution = jest.fn();
    const agentBuilder = {
      conversations: {
        getScopedClient: jest.fn().mockResolvedValue({
          get: jest.fn().mockResolvedValue(conversation([R1], [], ['run-1'])),
        }),
      },
    } as never;
    await expect(
      loadRoundOutcome({
        agentBuilder,
        workflowsManagement: { management: { getWorkflowExecution } } as never,
        request,
        spaceId: 'default',
        conversationId: 'c',
        roundId: 'r1',
        logger,
      })
    ).resolves.toMatchObject({ roundKind: 'initial' });
    expect(getWorkflowExecution).not.toHaveBeenCalled();
  });
});
