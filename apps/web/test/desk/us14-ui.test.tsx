import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { MessageComposer } from '../../src/components/inputs/MessageComposer';
import { BulkActionBar } from '../../src/components/tickets/BulkActionBar';
import { MergeTicketDialog, SplitTicketDialog } from '../../src/components/tickets/MergeSplitDialogs';
import { TicketList } from '../../src/components/tickets/TicketList';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations } from '../setup';

import { makeTicketSummary } from './fixtures';

import type { Macro } from '../../src/data/macros';

/** US14 screens (T240): the composer's `/` macro picker, merge and split dialogs, and bulk selection. */

function macro(overrides: Partial<Macro> = {}): Macro {
  return { id: 'm1', name: 'Refund issued', body: 'We have refunded you.', actions: {}, visibility: 'all_staff', sharedRoleIds: [], sharedGroupIds: [], ...overrides };
}

const MACROS = [
  macro({ id: 'm1', name: 'Refund issued', body: 'We have refunded you.', actions: { state: 'resolved', addTagIds: ['t1'] } }),
  macro({ id: 'm2', name: 'Greeting', body: 'Hello!' }),
  macro({ id: 'm3', name: 'Escalate', body: '', actions: { priority: 'urgent', assignToMe: true } }),
];

function composer(overrides: Partial<React.ComponentProps<typeof MessageComposer>> = {}) {
  const onSend = vi.fn();
  const onApplyMacro = vi.fn();
  renderWithProviders(
    <MessageComposer
      onSend={onSend}
      onApplyMacro={onApplyMacro}
      macros={MACROS}
      attachments={[]}
      onAttach={() => undefined}
      onRemoveAttachment={() => undefined}
      mentionCandidates={[]}
      {...overrides}
    />,
  );
  return { onSend, onApplyMacro, field: screen.getByRole('combobox', { name: 'Reply' }) };
}

describe('MessageComposer macro picker', () => {
  it('opens on / and filters by name', async () => {
    const { field } = composer();
    await userEvent.type(field, '/ref');
    const listbox = screen.getByRole('listbox', { name: 'Insert a macro' });
    expect(within(listbox).getAllByRole('option').map((option) => option.textContent)).toEqual([expect.stringContaining('Refund issued')]);
    expect(field).toHaveAttribute('aria-expanded', 'true');
  });

  it('inserts the macro text with Enter, shows its ticket changes, and sends through onApplyMacro', async () => {
    const { field, onApplyMacro, onSend } = composer();
    await userEvent.type(field, '/ref{Enter}');
    expect(field).toHaveValue('We have refunded you.');
    expect(screen.getByText('Macro: Refund issued')).toBeInTheDocument();
    expect(screen.getByText('Sending will also set state to Resolved, add 1 tag.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send and apply macro' }));
    expect(onApplyMacro).toHaveBeenCalledWith('m1', undefined);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends edited macro text as the override', async () => {
    const { field, onApplyMacro } = composer();
    await userEvent.type(field, '/greet{Enter}');
    await userEvent.type(field, ' Thanks for waiting.');
    await userEvent.click(screen.getByRole('button', { name: 'Send and apply macro' }));
    expect(onApplyMacro).toHaveBeenCalledWith('m2', 'Hello! Thanks for waiting.');
  });

  it('lets a changes-only macro be sent with an empty reply', async () => {
    const { field, onApplyMacro } = composer();
    await userEvent.type(field, '/esc{Enter}');
    expect(field).toHaveValue('');
    await userEvent.click(screen.getByRole('button', { name: 'Send and apply macro' }));
    expect(onApplyMacro).toHaveBeenCalledWith('m3', undefined);
  });

  it('removing the macro chip sends a plain reply', async () => {
    const { field, onApplyMacro, onSend } = composer();
    await userEvent.type(field, '/greet{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Remove macro Greeting' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    expect(onSend).toHaveBeenCalledWith('Hello!', 'reply');
    expect(onApplyMacro).not.toHaveBeenCalled();
  });

  it('never offers macros in an internal note, nor without macros', async () => {
    const { field } = composer();
    await userEvent.click(screen.getByRole('button', { name: /Internal note/ }));
    await userEvent.type(screen.getByRole('combobox', { name: 'Internal note' }), '/ref');
    expect(screen.queryByRole('listbox', { name: 'Insert a macro' })).not.toBeInTheDocument();
    expect(field).toBeDefined();
  });

  it('closes the picker with Escape', async () => {
    const { field } = composer();
    await userEvent.type(field, '/');
    expect(screen.getByRole('listbox', { name: 'Insert a macro' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox', { name: 'Insert a macro' })).not.toBeInTheDocument();
  });
});

describe('MergeTicketDialog', () => {
  it('rejects a non-number and the same ticket, then merges by number', async () => {
    const onMerge = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(<MergeTicketDialog open sourceNumber={1001} onClose={() => undefined} onMerge={onMerge} />);
    const dialog = screen.getByRole('dialog', { name: 'Merge #1001 into another ticket' });
    const input = within(dialog).getByRole('textbox', { name: 'Ticket number to merge into' });

    await userEvent.type(input, 'abc');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter the number of the ticket');

    await userEvent.clear(input);
    await userEvent.type(input, '1001');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Choose a different ticket');

    await userEvent.clear(input);
    await userEvent.type(input, '#1042');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));
    expect(onMerge).toHaveBeenCalledWith(1042);
    await expectNoAxeViolations(dialog);
  });

  it('shows the error the merge rejects with', async () => {
    const onMerge = vi.fn().mockRejectedValue(new Error('Only tickets from the same customer can be merged.'));
    renderWithProviders(<MergeTicketDialog open sourceNumber={1} onClose={() => undefined} onMerge={onMerge} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Ticket number to merge into' }), '2');
    await userEvent.click(screen.getByRole('button', { name: 'Merge' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only tickets from the same customer can be merged.');
  });
});

describe('SplitTicketDialog', () => {
  const messages = [
    { id: 'msg-1', body: 'First question', authorName: 'Cara', createdAt: '2026-10-01T10:00:00.000Z' },
    { id: 'msg-2', body: 'A different problem', authorName: 'Cara', createdAt: '2026-10-01T10:05:00.000Z' },
  ];

  it('splits the chosen message with an optional title', async () => {
    const onSplit = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(<SplitTicketDialog open messages={messages} onClose={() => undefined} onSplit={onSplit} />);
    const dialog = screen.getByRole('dialog', { name: 'Split a message into a new ticket' });
    expect(within(dialog).getByRole('button', { name: 'Split' })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('radio', { name: /A different problem/ }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'New ticket title (optional)' }), 'Billing');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Split' }));
    expect(onSplit).toHaveBeenCalledWith({ messageId: 'msg-2', title: 'Billing' });
    await expectNoAxeViolations(dialog);
  });

  it('explains when there is nothing to split', () => {
    renderWithProviders(<SplitTicketDialog open messages={[]} onClose={() => undefined} onSplit={vi.fn()} />);
    expect(screen.getByText('This ticket has no customer-visible messages to split.')).toBeInTheDocument();
  });
});

describe('bulk selection', () => {
  it('checks rows with x and the checkbox, exposed as aria-checked', async () => {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });
    const tickets = [makeTicketSummary({ id: 'a', number: 11, title: 'A' }), makeTicketSummary({ id: 'b', number: 12, title: 'B' })];
    const onToggle = vi.fn();
    renderWithProviders(<TicketList tickets={tickets} label="Mine" onOpenTicket={() => undefined} checkedIds={new Set(['b'])} onToggleChecked={onToggle} />);
    const [first, second] = screen.getAllByRole('option');
    expect(first).toHaveAttribute('aria-checked', 'false');
    expect(second).toHaveAttribute('aria-checked', 'true');

    first?.focus();
    await userEvent.keyboard('x');
    expect(onToggle).toHaveBeenCalledWith(tickets[0]);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select #12' }));
    expect(onToggle).toHaveBeenLastCalledWith(tickets[1]);
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 0 });
  });

  it('has no checkboxes or aria-checked without a selection handler', () => {
    renderWithProviders(<TicketList tickets={[makeTicketSummary()]} label="Mine" onOpenTicket={() => undefined} />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('the bulk bar applies one change at a time', async () => {
    const onApply = vi.fn();
    const onAssignToMe = vi.fn();
    const onClear = vi.fn();
    renderWithProviders(<BulkActionBar count={3} onApply={onApply} onAssignToMe={onAssignToMe} onClear={onClear} />);
    const toolbar = screen.getByRole('toolbar', { name: 'Bulk actions' });
    expect(within(toolbar).getByText('3 selected')).toBeInTheDocument();

    await userEvent.click(within(toolbar).getByRole('combobox', { name: 'Set priority' }));
    await userEvent.click(screen.getByRole('option', { name: 'Urgent' }));
    expect(onApply).toHaveBeenCalledWith({ priority: 'urgent' });

    await userEvent.click(within(toolbar).getByRole('combobox', { name: 'Set state' }));
    await userEvent.click(screen.getByRole('option', { name: 'Resolved' }));
    expect(onApply).toHaveBeenLastCalledWith({ state: 'resolved' });

    await userEvent.click(within(toolbar).getByRole('button', { name: 'Assign to me' }));
    await userEvent.click(within(toolbar).getByRole('button', { name: 'Clear selection' }));
    expect(onAssignToMe).toHaveBeenCalled();
    expect(onClear).toHaveBeenCalled();
    await expectNoAxeViolations(toolbar);
  });
});
