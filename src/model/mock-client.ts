import type { z } from 'zod';
import type { GenerateStructuredArgs, ModelClient } from './client.js';

/**
 * MockModelClient — returns canned structured outputs for tests.
 *
 * Two modes:
 *   - constant: supplied with a single value to return every call.
 *   - sequence: supplied with an array; returns one per call in order;
 *     throws after exhaustion.
 *   - function: supplied with a callback that receives the call args.
 *
 * The mock validates its outputs against the supplied schema so that
 * tests catch their own malformed canned data.
 */

export interface MockModelClientOptions<T> {
  responses: T | T[] | ((args: GenerateStructuredArgs<z.ZodTypeAny>) => T | Promise<T>);
}

export class MockModelClient implements ModelClient {
  public calls: Array<GenerateStructuredArgs<z.ZodTypeAny>> = [];
  private readonly responder: (args: GenerateStructuredArgs<z.ZodTypeAny>) => unknown | Promise<unknown>;
  private sequenceIndex = 0;

  constructor(options: MockModelClientOptions<unknown>) {
    if (typeof options.responses === 'function') {
      this.responder = options.responses as (
        args: GenerateStructuredArgs<z.ZodTypeAny>,
      ) => unknown | Promise<unknown>;
    } else if (Array.isArray(options.responses)) {
      const sequence = options.responses;
      this.responder = () => {
        if (this.sequenceIndex >= sequence.length) {
          throw new Error(
            `MockModelClient exhausted: ${sequence.length} response(s) configured, ${this.sequenceIndex + 1} requested.`,
          );
        }
        return sequence[this.sequenceIndex++];
      };
    } else {
      const constant = options.responses;
      this.responder = () => constant;
    }
  }

  async generateStructured<TSchema extends z.ZodTypeAny>(
    args: GenerateStructuredArgs<TSchema>,
  ): Promise<z.infer<TSchema>> {
    this.calls.push(args as GenerateStructuredArgs<z.ZodTypeAny>);
    const raw = await this.responder(args as GenerateStructuredArgs<z.ZodTypeAny>);
    const result = args.schema.safeParse(raw);
    if (!result.success) {
      throw new Error(
        `MockModelClient canned response did not match schema "${args.schemaName}": ${result.error.message}`,
      );
    }
    return result.data as z.infer<TSchema>;
  }
}
