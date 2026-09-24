import { readFile } from 'node:fs/promises';

import { Global, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

import { JobProcessor } from '../jobs/job-processor.js';
import { QueueRegistry } from '../jobs/queues.js';

import type { Job } from 'bullmq';

/**
 * Outgoing email (research D17, SMTP via Nodemailer; Mailpit in development).
 *
 * Mail is sent only by the `email` queue: a service calls `MailQueue.enqueue` after its
 * transaction commits (the job may carry a one-time link token, which must never be stored in
 * the outbox), and the worker's `MailSender` renders and sends it with retries. Nothing here
 * logs recipients, variables, links or bodies: only the template name and job id.
 *
 * Templates live in `templates/`: `{name}.subject.txt`, `{name}.html` and `{name}.txt`, wrapped
 * in `layout.html` / `layout.txt`. `{{var}}` is HTML-escaped in the HTML part; unescaped
 * `{{{content}}}` is reserved for the layout.
 */

export interface EmailJobData {
  tenantId: string;
  to: string;
  template: string;
  /** Shown in the footer ("Sent by …"). */
  workspaceName: string;
  vars: Record<string, string>;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export const EMAIL_JOB = 'send_email';

const TEMPLATE_NAME = /^[a-z][a-z0-9-]*$/;
const PLACEHOLDER = /\{\{\{\s*(\w+)\s*\}\}\}|\{\{\s*(\w+)\s*\}\}/g;
const RESERVED_VARS = new Set(['content', 'subject', 'workspaceName']);
const TEMPLATES_DIR = new URL('./templates/', import.meta.url);

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Fills placeholders. Every placeholder must have a value (a missing one is a bug, not a blank).
 * Triple braces insert raw text and are only allowed for `rawAllowed` names.
 */
export function fill(
  template: string,
  vars: Readonly<Record<string, string>>,
  options: { escape: boolean; rawAllowed?: ReadonlySet<string> },
): string {
  return template.replace(PLACEHOLDER, (_match, raw: string | undefined, plain: string | undefined) => {
    const name = (raw ?? plain) as string;
    const value = vars[name];
    if (value === undefined) throw new Error(`Mail template variable "${name}" is missing`);
    if (raw !== undefined) {
      if (options.rawAllowed?.has(name) !== true) throw new Error(`Raw placeholder "${name}" is not allowed`);
      return value;
    }
    return options.escape ? escapeHtml(value) : value;
  });
}

async function readTemplate(file: string): Promise<string> {
  return readFile(new URL(file, TEMPLATES_DIR), 'utf8');
}

export async function renderEmail(data: Pick<EmailJobData, 'template' | 'workspaceName' | 'vars'>): Promise<RenderedEmail> {
  if (!TEMPLATE_NAME.test(data.template)) throw new Error(`Invalid mail template name "${data.template}"`);
  for (const key of Object.keys(data.vars)) {
    if (RESERVED_VARS.has(key)) throw new Error(`Mail variable "${key}" is reserved`);
  }
  const [subjectTemplate, htmlBody, textBody, htmlLayout, textLayout] = await Promise.all([
    readTemplate(`${data.template}.subject.txt`),
    readTemplate(`${data.template}.html`),
    readTemplate(`${data.template}.txt`),
    readTemplate('layout.html'),
    readTemplate('layout.txt'),
  ]);
  const subject = fill(subjectTemplate.trim(), data.vars, { escape: false }).replace(/[\r\n]+/g, ' ');
  const layoutVars = { subject, workspaceName: data.workspaceName };
  const raw = new Set(['content']);
  return {
    subject,
    html: fill(htmlLayout, { ...layoutVars, content: fill(htmlBody, data.vars, { escape: true }) }, { escape: true, rawAllowed: raw }),
    text: fill(textLayout, { ...layoutVars, content: fill(textBody, data.vars, { escape: false }) }, { escape: false, rawAllowed: raw }),
  };
}

/** Enqueues an email; call after the transaction that caused it has committed. */
@Injectable()
export class MailQueue {
  constructor(private readonly queues: QueueRegistry) {}

  async enqueue(data: EmailJobData, options: { dedupeKey?: string } = {}): Promise<void> {
    // Render once up front so a broken template fails the caller, not a background job.
    await renderEmail(data);
    await this.queues.get('email').add(EMAIL_JOB, data, {
      ...(options.dedupeKey === undefined ? {} : { jobId: `email.${options.dedupeKey}` }),
      // Link tokens must not outlive the job in Redis.
      removeOnComplete: true,
      removeOnFail: true,
    });
  }
}

function smtpTransport(): Transporter {
  const port = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER ?? '';
  return createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    ...(user === '' ? {} : { auth: { user, pass: process.env.SMTP_PASS ?? '' } }),
    logger: false,
  });
}

/** The `email` queue worker: renders and sends. Throws to retry (5 attempts, then dead letter). */
@Injectable()
export class MailSender extends JobProcessor<EmailJobData> implements OnApplicationShutdown {
  readonly queue = 'email' as const;
  readonly jobName = EMAIL_JOB;
  private readonly logger = new Logger('MailSender');
  private transporter?: Transporter;

  constructor(transporter?: Transporter) {
    super();
    this.transporter = transporter;
  }

  async process(data: EmailJobData, job: Job<EmailJobData>): Promise<void> {
    const email = await renderEmail(data);
    this.transporter ??= smtpTransport();
    await this.transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: data.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    this.logger.log(`Sent ${data.template} email (job ${job.id ?? '?'})`);
  }

  onApplicationShutdown(): void {
    this.transporter?.close();
  }
}

@Global()
@Module({ providers: [MailQueue, { provide: MailSender, useFactory: () => new MailSender() }], exports: [MailQueue] })
export class MailModule {}
