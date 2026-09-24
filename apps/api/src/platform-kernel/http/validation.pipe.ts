import { Injectable, type PipeTransform } from '@nestjs/common';

import { type ErrorDetail, validationFailed } from './app-error.js';

import type { z } from 'zod';

/**
 * Validates a body, query or params object with a zod schema (api-conventions rule 4). Schemas
 * must be `.strict()` objects so unknown fields are rejected, never silently dropped. Failures are
 * 400 `VALIDATION_FAILED` with `details: [{ path, issue }]`; the parsed (whitelisted, coerced)
 * value replaces the raw input.
 *
 *   @Body(new ZodValidationPipe(CreateGroupBody)) body: z.infer<typeof CreateGroupBody>
 */
@Injectable()
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (result.success) {
      return result.data;
    }
    throw validationFailed(toDetails(result.error.issues, value));
  }
}

/** Maps zod issues to stable snake_case `issue` codes; clients rely on them, not on messages. */
export function toDetails(issues: readonly z.core.$ZodIssue[], input: unknown): ErrorDetail[] {
  return issues.flatMap((issue): ErrorDetail[] => {
    const path = issue.path.map(String);
    switch (issue.code) {
      case 'unrecognized_keys':
        return issue.keys.map((key) => ({ path: [...path, key].join('.'), issue: 'unrecognized_key' }));
      case 'invalid_type':
        return [{ path: path.join('.'), issue: valueAt(input, issue.path) === undefined ? 'required' : 'invalid_type' }];
      case 'too_big':
        return [{ path: path.join('.'), issue: sizeIssue(issue.origin, 'big') }];
      case 'too_small':
        return [{ path: path.join('.'), issue: sizeIssue(issue.origin, 'small') }];
      case 'invalid_format':
        return [{ path: path.join('.'), issue: 'invalid_format' }];
      case 'invalid_value':
        return [{ path: path.join('.'), issue: 'invalid_value' }];
      case 'not_multiple_of':
      case 'invalid_union':
      case 'invalid_key':
      case 'invalid_element':
      case 'custom':
        return [{ path: path.join('.'), issue: 'invalid' }];
    }
  });
}

function sizeIssue(origin: string, direction: 'big' | 'small'): string {
  switch (origin) {
    case 'string':
      return direction === 'big' ? 'too_long' : 'too_short';
    case 'array':
    case 'set':
      return direction === 'big' ? 'too_many' : 'too_few';
    default:
      return direction === 'big' ? 'too_large' : 'too_small';
  }
}

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let current = input;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}
