/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export interface CandidatePage<T> {
  items: T[];
  total?: number;
  rawItemCount?: number;
}

export async function collectPages<T>(
  fetchPage: (page: number) => Promise<CandidatePage<T>>,
  { pageSize, maxPages }: { pageSize: number; maxPages: number }
): Promise<{ items: T[]; truncated: boolean; total?: number }> {
  const items: T[] = [];
  let total: number | undefined;
  let rawCount = 0;

  for (let page = 1; page <= maxPages; page++) {
    const { items: pageItems, total: pageTotal, rawItemCount } = await fetchPage(page);
    items.push(...pageItems);
    total = pageTotal;

    const pageLength = rawItemCount ?? pageItems.length;
    rawCount += pageLength;

    if (pageLength < pageSize) {
      break;
    }

    if (pageTotal === undefined || rawCount >= pageTotal) {
      break;
    }
  }

  return { items, truncated: total !== undefined && rawCount < total, total };
}
