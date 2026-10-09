import { z } from 'zod';

import { paginationQuery } from '../../platform-kernel/http/pagination.js';

/** Query of `GET /ai/runs` (contracts/ai.yaml `listAiRuns`). */

export const AI_RUN_PURPOSES = ['routing', 'complexity', 'reply', 'draft', 'summary', 'embedding', 'connection_test'] as const;

export const AiRunsQuerySchema = z
  .object({
    ...paginationQuery,
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    purpose: z.enum(AI_RUN_PURPOSES).optional(),
  })
  .strict()
  .refine((query) => query.from === undefined || query.to === undefined || Date.parse(query.from) <= Date.parse(query.to), {
    message: 'from must not be after to',
    path: ['to'],
  });

export type AiRunsQuery = z.infer<typeof AiRunsQuerySchema>;
