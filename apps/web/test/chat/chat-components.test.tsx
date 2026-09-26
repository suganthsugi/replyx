import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer } from '../../src/components/chat/ChatComposer';
import { ChatThread } from '../../src/components/chat/ChatThread';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations } from '../setup';

import type { ChatItem, ChatMessage, ComposerAttachment } from '../../src/components/chat/types';

const polite = () => document.querySelector('[aria-live="polite"]');
const assertive = () => document.querySelector('[aria-live="assertive"]');

function message(overrides: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'body'>): ChatMessage {
  return { kind: 'message', from: 'me', attachments: [], delivery: 'sent', createdAt: '2026-09-26T09:00:00.000Z', ...overrides };
}

const items: ChatItem[] = [
  message({ id: 'a', body: 'My order is late.', delivery: 'read' }),
  message({ id: 'b', body: 'Let me check.', from: 'support', sender: { name: 'Ann Agent' }, delivery: 'delivered' }),
  { kind: 'resolved', id: 'r1', text: 'Glad we could help, just reply if you need anything else', createdAt: '2026-09-26T10:00:00.000Z' },
  message({ id: 'c', body: 'One more thing.', delivery: 'delivered' }),
  message({ id: 'd', body: 'Still there?', delivery: 'sent' }),
];

function thread(props: Partial<Parameters<typeof ChatThread>[0]> = {}) {
  return <ChatThread items={items} hasOlder={false} loadingOlder={false} onLoadOlder={() => undefined} {...props} />;
}

describe('ChatThread', () => {
  it('shows own messages with delivery, support messages with the agent, and resolved dividers', async () => {
    const { container } = renderWithProviders(thread({ status: { code: 'answered', text: 'Support has replied' } }));
    const list = within(screen.getByRole('region', { name: 'Conversation' })).getByRole('list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent('You:My order is late.');
    expect(rows[0]).toHaveTextContent('Read');
    expect(rows[1]).toHaveTextContent('Ann Agent');
    expect(rows[1]).not.toHaveTextContent('Delivered');
    expect(rows[2]).toHaveTextContent('Glad we could help');
    expect(rows[3]).toHaveTextContent('Delivered');
    expect(rows[4]).toHaveTextContent('Sent');
    expect(screen.getByText('Support has replied')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('announces support messages that arrive, but not history or own messages', () => {
    const { rerender } = renderWithProviders(thread());
    expect(polite()).toHaveTextContent('');

    // Older history loads in above: quiet.
    const older = message({ id: 'o', body: 'Old support reply', from: 'support', sender: { name: 'Bo' } });
    rerender(thread({ items: [older, ...items] }));
    expect(polite()).not.toHaveTextContent('Old support reply');

    rerender(thread({ items: [older, ...items, message({ id: 'e', body: 'Mine again' })] }));
    expect(polite()).not.toHaveTextContent('Mine again');

    rerender(
      thread({
        items: [older, ...items, message({ id: 'e', body: 'Mine again' }), message({ id: 'f', body: 'It ships today.', from: 'support', sender: { name: 'Ann Agent' } })],
      }),
    );
    expect(polite()).toHaveTextContent('Ann Agent says: It ships today.');
  });

  it('announces the first reply in a thread that started empty', () => {
    const { rerender } = renderWithProviders(thread({ items: [] }));
    rerender(thread({ items: [message({ id: 'x', body: 'Hello!', from: 'support', sender: { name: 'Ann Agent' } })] }));
    expect(polite()).toHaveTextContent('Ann Agent says: Hello!');
  });

  it('shows and announces typing, and status changes after the first one', () => {
    const { rerender } = renderWithProviders(thread({ status: { code: 'received', text: 'Support has your message' } }));
    expect(polite()).not.toHaveTextContent('Support has your message');

    rerender(thread({ status: { code: 'received', text: 'Support has your message' }, typing: { name: 'Ann Agent' } }));
    expect(within(screen.getByRole('region', { name: 'Conversation' })).getByText('Ann Agent is typing')).toBeInTheDocument();
    expect(polite()).toHaveTextContent('Ann Agent is typing');

    rerender(thread({ status: { code: 'answered', text: 'Support has replied' } }));
    expect(polite()).toHaveTextContent('Support has replied');
  });

  it('loads earlier messages from the keyboard', async () => {
    const onLoadOlder = vi.fn();
    const { rerender } = renderWithProviders(thread({ hasOlder: true, onLoadOlder }));
    await userEvent.click(screen.getByRole('button', { name: 'Show earlier messages' }));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    rerender(thread({ hasOlder: true, loadingOlder: true, onLoadOlder }));
    expect(screen.getByRole('progressbar', { name: 'Loading earlier messages' })).toBeInTheDocument();
  });

  it('offers a retry on a message that failed to send', async () => {
    const onRetry = vi.fn();
    const failed = message({ id: 'cm-9', body: 'Did this go?', delivery: 'failed', error: 'Check your connection and try again.' });
    renderWithProviders(thread({ items: [failed], onRetry }));
    expect(screen.getByText(/Not sent/)).toBeInTheDocument();
    expect(screen.getByText('Check your connection and try again.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledWith(failed);
  });

  it('links clean attachments and explains pending and blocked ones', () => {
    const withFiles = message({
      id: 'f1',
      body: 'Files attached',
      attachments: [
        { id: 'a1', fileName: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: 2048, scanStatus: 'clean', downloadPath: '/api/v1/customer/attachments/a1/download' },
        { id: 'a2', fileName: 'photo.png', contentType: 'image/png', sizeBytes: 10, scanStatus: 'pending', downloadPath: null },
        { id: 'a3', fileName: 'bad.zip', contentType: 'application/zip', sizeBytes: 10, scanStatus: 'blocked', downloadPath: null },
      ],
    });
    renderWithProviders(thread({ items: [withFiles] }));
    expect(screen.getByRole('link', { name: 'invoice.pdf' })).toHaveAttribute('href', '/api/v1/customer/attachments/a1/download');
    expect(screen.getByText('(checking the file…)')).toBeInTheDocument();
    expect(screen.getByText('(blocked: this file looked unsafe)')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'photo.png' })).not.toBeInTheDocument();
  });
});

function composer(props: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
  return <ChatComposer onSend={() => undefined} attachments={[]} onAttach={() => undefined} onRemoveAttachment={() => undefined} {...props} />;
}

describe('ChatComposer', () => {
  afterEach(() => vi.useRealTimers());

  it('sends on Enter, keeps Shift+Enter as a new line, and ignores blank messages', async () => {
    const onSend = vi.fn();
    const { container } = renderWithProviders(composer({ onSend }));
    const box = screen.getByRole('textbox', { name: 'Message' });
    await userEvent.type(box, '   {Enter}');
    expect(onSend).not.toHaveBeenCalled();

    await userEvent.clear(box);
    await userEvent.type(box, 'Hello{Shift>}{Enter}{/Shift}there{Enter}');
    expect(onSend).toHaveBeenCalledWith('Hello\nthere');
    expect(box).toHaveValue('');
    await expectNoAxeViolations(container);
  });

  it('pauses sending with a countdown while rate limited, keeping the text', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onSend = vi.fn();
    renderWithProviders(composer({ onSend, rateLimitedUntil: Date.now() + 3_000 }));
    const box = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'Are you there?' } });

    expect(screen.getByText(/You can send again in 3 seconds/)).toBeInTheDocument();
    expect(box).toHaveAccessibleDescription(/You can send again in 3 seconds/);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.getByText(/You can send again in 2 seconds/)).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(2_500));
    expect(screen.queryByText(/You can send again/)).not.toBeInTheDocument();
    expect(box).toHaveValue('Are you there?');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('Are you there?');
  });

  it('refuses files of the wrong type or over 25 MB, says why, and passes the rest on', async () => {
    const onAttach = vi.fn();
    const { container } = renderWithProviders(composer({ onAttach }));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]') as HTMLInputElement;
    const exe = new File(['MZ'], 'setup.exe', { type: 'application/octet-stream' });
    const huge = new File(['x'], 'video.zip', { type: 'application/zip' });
    Object.defineProperty(huge, 'size', { value: 30 * 1024 * 1024 });
    const fine = new File(['%PDF'], 'invoice.pdf', { type: 'application/pdf' });

    fireEvent.change(input, { target: { files: [exe, huge, fine] } });

    const form = screen.getByRole('form', { name: 'Send a message' });
    expect(within(form).getByText(/setup\.exe can't be sent/)).toBeInTheDocument();
    expect(within(form).getByText('video.zip is larger than 25 MB.')).toBeInTheDocument();
    expect(assertive()).toHaveTextContent('video.zip is larger than 25 MB.');
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveAccessibleDescription(/larger than 25 MB/);
    expect(onAttach).toHaveBeenCalledWith([fine]);
    await expectNoAxeViolations(container);
  });

  it('shows upload progress and upload errors, and waits for uploads before sending', async () => {
    const onRemoveAttachment = vi.fn();
    const attachments: ComposerAttachment[] = [
      { localId: 'l1', fileName: 'photo.png', status: 'uploading', progress: 40 },
      { localId: 'l2', fileName: 'notes.txt', status: 'failed', progress: 0, error: 'That file type is not allowed.' },
    ];
    renderWithProviders(composer({ attachments, onRemoveAttachment }));
    expect(screen.getByRole('progressbar', { name: 'Uploading photo.png' })).toHaveAttribute('aria-valuenow', '40');
    expect(screen.getByText('That file type is not allowed.')).toBeInTheDocument();

    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'See attached');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
    expect(onRemoveAttachment).toHaveBeenCalledWith('l2');
  });
});
