/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { HYPOTHESES_ATTACHMENT_TYPE } from '@kbn/agentic-investigations-plugin/common';
import { ALERT_RECOVERED_FOLLOW_UP } from '../client/investigations_client';

export type InvestigationRoundKind = 'initial' | 'follow_up' | 'alert_recovery';

/**
 * What the round did to the confirmed root cause, from the findings recorder's hypotheses before
 * and after it. `unknown` means there is nothing to compare, or a confirmed cause disappeared
 * instead of being dismissed (most likely reworded); it is not "no root cause".
 */
export type RootCauseChange = 'found' | 'changed' | 'withdrawn' | 'unchanged' | 'unknown';

export interface RoundResolution {
  roundKind: InvestigationRoundKind;
  roundId: string;
  outcome: RootCauseChange;
  /**
   * Whether any hypothesis is `confirmed` after the round (`undefined` when no hypotheses were
   * recorded). Lets callers tell "no ground truth" (`false`) apart from `outcome: 'unknown'`
   * when an earlier confirmed cause was reworded.
   */
  hasConfirmedCause?: boolean;
  /** Confirmed after the round and not before it; empty when `outcome` is `unknown`. */
  newlyConfirmed: HypothesisNote[];
  /** Confirmed before the round and not after it, with their status after it. */
  noLongerConfirmed: HypothesisNote[];
  stillConfirmed: HypothesisNote[];
}

export interface HypothesisNote {
  candidate: string;
  status: string;
  reason?: string;
}

/** The parts of an Agent Builder conversation this reads. */
export interface ResolvableConversation {
  rounds: ReadonlyArray<{ id: string; started_at: string }>;
  attachments?: ReadonlyArray<{
    type: string;
    versions: ReadonlyArray<{ created_at: string; data: unknown }>;
  }>;
}

const normalizeCandidate = (candidate: string): string =>
  candidate.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.]+$/, '');

const MAX_REASON_CHARS = 600;

/** The hypotheses in a version by normalized candidate, and which of them are confirmed. */
const readHypotheses = (data: unknown) => {
  const hypotheses = (data as { hypotheses?: unknown } | null)?.hypotheses;
  if (!Array.isArray(hypotheses)) {
    return undefined;
  }
  const all = new Map<string, HypothesisNote>();
  const confirmed = new Map<string, HypothesisNote>();
  for (const item of hypotheses) {
    const { candidate, status, reason } = (item ?? {}) as Record<string, unknown>;
    if (typeof candidate === 'string' && typeof status === 'string') {
      const note: HypothesisNote = {
        candidate,
        status,
        ...(typeof reason === 'string' && reason
          ? { reason: reason.slice(0, MAX_REASON_CHARS) }
          : {}),
      };
      all.set(normalizeCandidate(candidate), note);
      if (status === 'confirmed') {
        confirmed.set(normalizeCandidate(candidate), note);
      }
    }
  }
  return { all, confirmed };
};

const NO_NOTES = { newlyConfirmed: [], noLongerConfirmed: [], stillConfirmed: [] };

const changeAt = (
  rounds: ResolvableConversation['rounds'],
  attachments: NonNullable<ResolvableConversation['attachments']>,
  index: number
): Omit<RoundResolution, 'roundKind' | 'roundId'> => {
  const versions = attachments
    .filter(({ type }) => type === HYPOTHESES_ATTACHMENT_TYPE)
    .flatMap(({ versions: all }) => all)
    .flatMap(({ created_at: createdAt, data }) => {
      const at = Date.parse(createdAt);
      const hypotheses = readHypotheses(data);
      return Number.isFinite(at) && hypotheses ? [{ at, ...hypotheses }] : [];
    })
    .sort((a, b) => a.at - b.at);
  const lastBefore = (time: number) => versions.filter(({ at }) => at < time).pop();

  const nextRound = rounds[index + 1];
  const after = nextRound
    ? lastBefore(Date.parse(nextRound.started_at))
    : versions[versions.length - 1];
  if (!after) {
    return { outcome: 'unknown', ...NO_NOTES };
  }
  const hasConfirmedCause = after.confirmed.size > 0;
  const before =
    lastBefore(Date.parse(rounds[index].started_at))?.confirmed ??
    new Map<string, HypothesisNote>();
  if ([...before.keys()].some((candidate) => !after.all.has(candidate))) {
    return { outcome: 'unknown', hasConfirmedCause, ...NO_NOTES };
  }

  const newlyConfirmed = [...after.confirmed]
    .filter(([candidate]) => !before.has(candidate))
    .map(([, note]) => note);
  const stillConfirmed = [...after.confirmed]
    .filter(([candidate]) => before.has(candidate))
    .map(([, note]) => note);
  const noLongerConfirmed = [...before.keys()]
    .filter((candidate) => !after.confirmed.has(candidate))
    .map((candidate) => after.all.get(candidate)!);
  const outcome: RootCauseChange =
    newlyConfirmed.length > 0
      ? noLongerConfirmed.length > 0
        ? 'changed'
        : 'found'
      : noLongerConfirmed.length > 0
      ? 'withdrawn'
      : 'unchanged';
  return { outcome, hasConfirmedCause, newlyConfirmed, noLongerConfirmed, stillConfirmed };
};

/**
 * Classifies a round and says what it did to the confirmed root cause.
 *
 * - `roundId` (from the Agent Builder hook) names the round; it may not be saved yet.
 * - Without it, the latest round is the run's. `runStartedAt` tells whether the run created the
 *   conversation's first round.
 * - A round is an `alert_recovery` only when `followUp` is `alert_recovered`; the message text
 *   is never read.
 *
 * A round's "before" is the last hypotheses version written before it started, and its "after"
 * the last one written before the next round started. Returns `undefined` when there is no round.
 */
export const resolveRound = (
  { rounds, attachments = [] }: ResolvableConversation,
  {
    roundId,
    runStartedAt,
    followUp,
  }: { roundId?: string; runStartedAt?: string; followUp?: string } = {}
): RoundResolution | undefined => {
  const recovery = followUp === ALERT_RECOVERED_FOLLOW_UP;
  const kindAt = (index: number): InvestigationRoundKind =>
    recovery ? 'alert_recovery' : index === 0 ? 'initial' : 'follow_up';

  if (roundId !== undefined) {
    const index = rounds.findIndex(({ id }) => id === roundId);
    if (index === -1) {
      // Not saved yet, so every saved round is earlier.
      return { roundKind: kindAt(rounds.length), roundId, outcome: 'unknown', ...NO_NOTES };
    }
    return { roundKind: kindAt(index), roundId, ...changeAt(rounds, attachments, index) };
  }

  if (rounds.length === 0) {
    return undefined;
  }
  const createdFirstRound =
    !recovery &&
    (runStartedAt !== undefined
      ? Date.parse(rounds[0].started_at) >= Date.parse(runStartedAt)
      : rounds.length === 1);
  const index = createdFirstRound ? 0 : rounds.length - 1;
  return {
    roundKind: recovery ? 'alert_recovery' : createdFirstRound ? 'initial' : 'follow_up',
    roundId: rounds[index].id,
    ...changeAt(rounds, attachments, index),
  };
};
