/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { isPlainObject } from 'lodash';
import { isConversationNotFoundError, type ConversationRound } from '@kbn/agent-builder-common';
import type { KibanaRequest, Logger } from '@kbn/core/server';
import type { AgentBuilderPluginStart, ConversationPublicClient } from '@kbn/agent-builder-server';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import { toWorkflowExecutionIds } from '../client/investigation_conversation';
import { isInvestigationWorkflowExecution } from '../lib/managed_workflows/is_investigation_workflow_execution';
import { ROUND_READ_RETRY_DELAYS_MS, sleep } from './round_loader';
import {
  resolveRound,
  type HypothesisNote,
  type RootCauseChange,
  type RoundResolution,
} from './round_outcome';

/**
 * Whether the round may count as "this worked": corroborate a Cortex page, mark a recalled memory
 * useful, or reinforce a decision-tree path as causal. A first round keeps doing what it always
 * did. A follow-up qualifies when it found or changed the root cause, and an alert recovery also
 * when the cause confirmed before it still holds. A round that could not be read never does.
 */
export const countsAsConfirmation = (resolution: RoundResolution | undefined): boolean => {
  if (!resolution) {
    return false;
  }
  if (resolution.roundKind === 'initial') {
    return true;
  }
  return (
    resolution.outcome === 'found' ||
    resolution.outcome === 'changed' ||
    (resolution.roundKind === 'alert_recovery' &&
      resolution.outcome === 'unchanged' &&
      resolution.stillConfirmed.length > 0)
  );
};

const MAX_NOTES = 8;

const CHANGE_SENTENCES: Record<RootCauseChange, string> = {
  found: 'This round confirmed a root cause that was not confirmed before.',
  changed: 'This round dropped the root cause confirmed earlier and confirmed a different one.',
  withdrawn:
    'This round dismissed or reopened the root cause confirmed earlier, and confirmed nothing in its place.',
  unchanged: 'This round did not change which root cause is confirmed.',
  unknown: 'It is not known whether this round changed the root cause.',
};

const renderNotes = (title: string, notes: readonly HypothesisNote[]): string[] =>
  notes.length === 0
    ? []
    : [
        `${title}:`,
        ...notes
          .slice(0, MAX_NOTES)
          .map(
            ({ candidate, status, reason }) =>
              `- ${candidate} (${status})${reason ? `\n  ${reason.replace(/\n/g, '\n  ')}` : ''}`
          ),
      ];

/**
 * A short account of the outcome for the learners' prompts, or `undefined` for a first round,
 * which the prompts already describe.
 */
export const formatRoundOutcome = (resolution: RoundResolution | undefined): string | undefined => {
  if (resolution?.roundKind === 'initial') {
    return undefined;
  }
  if (!resolution) {
    return `${CHANGE_SENTENCES.unknown} Do not treat any cause as verified because of this round.`;
  }
  const recovery = resolution.roundKind === 'alert_recovery';
  const kind = recovery ? 'This round followed the alert recovering.' : undefined;
  const held =
    recovery && resolution.outcome === 'unchanged' && resolution.stillConfirmed.length > 0
      ? 'The alert recovered and the root cause confirmed earlier still holds.'
      : CHANGE_SENTENCES[resolution.outcome];
  const verdict = countsAsConfirmation(resolution)
    ? 'Treat the confirmed root cause as verified.'
    : 'Nothing in this round verifies a root cause: do not treat any cause as verified because of it.';
  return [
    [kind, held, verdict].filter(Boolean).join(' '),
    ...renderNotes('Newly confirmed', resolution.newlyConfirmed),
    ...renderNotes('No longer confirmed', resolution.noLongerConfirmed),
    ...renderNotes('Still confirmed', resolution.stillConfirmed),
  ].join('\n');
};

/** What an investigation workflow run was started with. */
export interface InvestigationRun {
  startedAt: string;
  /** `inputs.context.follow_up`. */
  followUp?: string;
}

/** Reads an investigation workflow run by execution id; `undefined` when it is not one. */
export type ReadInvestigationRun = (executionId: string) => Promise<InvestigationRun | undefined>;

/**
 * Reads investigation workflow runs through Workflows, as the request's user. A run that can't be
 * read is logged and treated as no investigation run, so the round reads as a plain follow-up.
 */
export const createInvestigationRunReader = ({
  workflowsManagement,
  spaceId,
  request,
  logger,
}: {
  workflowsManagement: Pick<WorkflowsServerPluginSetup, 'management'>;
  spaceId: string;
  request: KibanaRequest;
  logger: Pick<Logger, 'warn'>;
}): ReadInvestigationRun => {
  return async (executionId) => {
    const execution = await workflowsManagement.management
      .getWorkflowExecution(executionId, spaceId, { includeOutput: false, request })
      .catch((error: unknown) => {
        logger.warn(
          `Could not read investigation run ${executionId}, so its round is read as a follow-up: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return undefined;
      });
    if (!execution || !isInvestigationWorkflowExecution(execution)) {
      return undefined;
    }
    const inputs = isPlainObject(execution.context?.inputs)
      ? (execution.context?.inputs as Record<string, unknown>)
      : undefined;
    const context = isPlainObject(inputs?.context)
      ? (inputs?.context as Record<string, unknown>)
      : undefined;
    const followUp = typeof context?.follow_up === 'string' ? context.follow_up : undefined;
    return { startedAt: execution.startedAt, ...(followUp ? { followUp } : {}) };
  };
};

/**
 * `followUp` of the investigation run that produced the round. Every run records its execution id
 * on the conversation before its round starts, so the latest one is the candidate; it produced the
 * round only if the round is the first one started after it. Any other round (a chat outside an
 * investigation run) has no `followUp`.
 */
const followUpOfRoundRun = async ({
  rounds,
  roundId,
  executionIds,
  readInvestigationRun,
}: {
  rounds: ReadonlyArray<{ id: string; started_at: string }>;
  roundId: string;
  executionIds: readonly string[];
  readInvestigationRun: ReadInvestigationRun;
}): Promise<string | undefined> => {
  const executionId = executionIds[executionIds.length - 1];
  const run = executionId ? await readInvestigationRun(executionId) : undefined;
  if (!run) {
    return undefined;
  }
  const runStartedAt = Date.parse(run.startedAt);
  const firstRoundOfRun = rounds.find(({ started_at: at }) => Date.parse(at) >= runStartedAt);
  return firstRoundOfRun?.id === roundId ? run.followUp : undefined;
};

/**
 * Reads the conversation and resolves the round. A follow-up whose round is not saved yet is read
 * again after a short wait, as the round loader does. A conversation that does not exist has no
 * earlier rounds; any other read failure is thrown.
 */
export const readRoundOutcome = async ({
  conversations,
  conversationId,
  roundId,
  readInvestigationRun,
  signal,
  retryDelaysMs = ROUND_READ_RETRY_DELAYS_MS,
}: {
  conversations: Pick<ConversationPublicClient, 'get'>;
  conversationId: string;
  roundId: string;
  /** Tells an alert recovery from a follow-up; without it every follow-up is a `follow_up`. */
  readInvestigationRun?: ReadInvestigationRun;
  signal?: AbortSignal;
  retryDelaysMs?: readonly number[];
}): Promise<{ outcome: RoundResolution; rounds: ConversationRound[] }> => {
  for (let attempt = 0; ; attempt++) {
    const conversation = await conversations.get(conversationId).then(
      (found) => found,
      (error) => {
        if (isConversationNotFoundError(error)) {
          return undefined;
        }
        throw error;
      }
    );
    const rounds = conversation?.rounds ?? [];
    const index = rounds.findIndex(({ id }) => id === roundId);
    const saved = index !== -1;
    const followUp =
      index > 0 && readInvestigationRun
        ? await followUpOfRoundRun({
            rounds,
            roundId,
            executionIds: toWorkflowExecutionIds(conversation?.metadata),
            readInvestigationRun,
          })
        : undefined;
    const outcome = resolveRound(
      { rounds, attachments: conversation?.attachments ?? [] },
      { roundId, followUp }
    )!;
    if (saved || outcome.roundKind === 'initial' || attempt >= retryDelaysMs.length) {
      return { outcome, rounds };
    }
    await sleep(retryDelaysMs[attempt], signal);
    if (signal?.aborted) {
      return { outcome, rounds };
    }
  }
};

/**
 * {@link readRoundOutcome} for the optimizers, which must still run when the outcome can't be
 * read: a failure gives `undefined`, so nothing is confirmed. A run with no conversation (a direct
 * workflow run) has no earlier rounds, as before.
 */
export const loadRoundOutcome = async ({
  agentBuilder,
  workflowsManagement,
  request,
  spaceId,
  conversationId,
  roundId,
  logger,
  signal,
  retryDelaysMs,
}: {
  agentBuilder: AgentBuilderPluginStart | undefined;
  workflowsManagement?: Pick<WorkflowsServerPluginSetup, 'management'>;
  request: KibanaRequest;
  spaceId: string;
  conversationId?: string;
  roundId?: string;
  logger: Pick<Logger, 'warn'>;
  signal?: AbortSignal;
  retryDelaysMs?: readonly number[];
}): Promise<RoundResolution | undefined> => {
  if (!conversationId) {
    return resolveRound({ rounds: [] }, { roundId: roundId ?? '' });
  }
  if (!roundId || !agentBuilder) {
    logger.warn(
      `Could not tell what round ${
        roundId ?? '(none)'
      } of "${conversationId}" did to the root cause: ${
        roundId ? 'Agent Builder is not available' : 'no round id'
      }`
    );
    return undefined;
  }
  try {
    const conversations = await agentBuilder.conversations.getScopedClient({ request });
    const { outcome } = await readRoundOutcome({
      conversations,
      conversationId,
      roundId,
      ...(workflowsManagement
        ? {
            readInvestigationRun: createInvestigationRunReader({
              workflowsManagement,
              spaceId,
              request,
              logger,
            }),
          }
        : {}),
      signal,
      retryDelaysMs,
    });
    return outcome;
  } catch (error) {
    logger.warn(
      `Could not tell what round ${roundId} of "${conversationId}" did to the root cause: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }
};
