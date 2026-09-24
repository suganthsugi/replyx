import { describe, expect, it, vi } from 'vitest';

import { EMAIL_JOB, escapeHtml, fill, MailQueue, MailSender, renderEmail } from '../../../src/platform-kernel/mail/mail.service.js';

import type { Job } from 'bullmq';

const vars = {
  title: 'Join <Acme> "support"',
  message: 'You were invited & can sign in.',
  actionLabel: 'Accept invitation',
  actionUrl: 'https://acme.replyx.app/invite?token=abc&x=1',
};

describe('mail templates', () => {
  it('escapes variables in HTML and keeps them plain in text', async () => {
    const email = await renderEmail({ template: 'notice', workspaceName: 'Acme', vars });
    expect(email.subject).toBe('Join <Acme> "support"');
    expect(email.html).toContain('Join &lt;Acme&gt; &quot;support&quot;');
    expect(email.html).toContain('href="https://acme.replyx.app/invite?token=abc&amp;x=1"');
    expect(email.html).toContain('Sent by Acme');
    expect(email.html).not.toContain('{{');
    expect(email.text).toContain('Accept invitation: https://acme.replyx.app/invite?token=abc&x=1');
    expect(email.text).toContain('Sent by Acme');
  });

  it('fails on missing variables, reserved names and bad template names', async () => {
    await expect(renderEmail({ template: 'notice', workspaceName: 'A', vars: { title: 't' } })).rejects.toThrow('missing');
    await expect(renderEmail({ template: 'notice', workspaceName: 'A', vars: { ...vars, content: '<script>' } })).rejects.toThrow('reserved');
    await expect(renderEmail({ template: '../layout', workspaceName: 'A', vars })).rejects.toThrow('Invalid mail template');
  });

  it('only allows raw placeholders that are explicitly permitted', () => {
    expect(() => fill('{{{x}}}', { x: '<b>' }, { escape: true })).toThrow('not allowed');
    expect(fill('{{{x}}} {{x}}', { x: '<b>' }, { escape: true, rawAllowed: new Set(['x']) })).toBe('<b> &lt;b&gt;');
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('MailQueue and MailSender', () => {
  const data = { tenantId: 't', to: 'agent@example.test', template: 'notice', workspaceName: 'Acme', vars };

  it('enqueues a rendered-checked email job that leaves no trace in Redis', async () => {
    const add = vi.fn(() => Promise.resolve());
    const queues = { get: vi.fn(() => ({ add })) };
    await new MailQueue(queues as never).enqueue(data, { dedupeKey: 'invite-1' });
    expect(queues.get).toHaveBeenCalledWith('email');
    expect(add).toHaveBeenCalledWith(EMAIL_JOB, data, { jobId: 'email.invite-1', removeOnComplete: true, removeOnFail: true });
  });

  it('refuses to enqueue an email whose template cannot render', async () => {
    const queues = { get: vi.fn() };
    await expect(new MailQueue(queues as never).enqueue({ ...data, vars: {} })).rejects.toThrow('missing');
    expect(queues.get).not.toHaveBeenCalled();
  });

  it('sends HTML with a text alternative', async () => {
    const sendMail = vi.fn(() => Promise.resolve({}));
    await new MailSender({ sendMail, close: vi.fn() } as never).process(data, { id: 'j1' } as Job<typeof data>);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'agent@example.test', subject: 'Join <Acme> "support"' }) as object,
    );
    const [message] = sendMail.mock.calls[0] as unknown as [{ html: string; text: string }];
    expect(message.html).toContain('<a href=');
    expect(message.text).not.toMatch(/<(a|p|h1|table)[ >]/);
  });
});
