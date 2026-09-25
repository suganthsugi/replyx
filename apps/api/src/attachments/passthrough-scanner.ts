import type { MalwareScanner, ScanVerdict } from './scan.job.js';
import type { Readable } from 'node:stream';

/**
 * Development and test only: marks every file clean without looking at it (research D26). It
 * refuses to exist in production, so a missing `CLAMAV_HOST` can never silently disable scanning.
 */
export class PassthroughScanner implements MalwareScanner {
  readonly name = 'passthrough';

  constructor(nodeEnv: string | undefined = process.env.NODE_ENV) {
    if (nodeEnv === 'production') {
      throw new Error('The pass-through malware scanner is not allowed in production; set CLAMAV_HOST');
    }
  }

  async scan(file: Readable): Promise<ScanVerdict> {
    // Drain the stream so the file handle is released.
    for await (const chunk of file) void chunk;
    return { verdict: 'clean' };
  }
}
