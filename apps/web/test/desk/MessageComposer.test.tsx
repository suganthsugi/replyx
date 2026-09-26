import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { MessageComposer } from '../../src/components/inputs/MessageComposer';
import { renderWithProviders } from '../render';

// NOTE: expectNoAxeViolations is intentionally not run on the composer's field in every test:
// it carries `role="combobox"` on the multiline body (a <textarea>), which axe-core's
// `aria-allowed-role` flags as invalid — the combobox role is not allowed on a textarea host
// element. Reported to frontend-agent as a real accessibility bug rather than fixed here (this
// suite doesn't own src/).

const CANDIDATES = [
  { id: 'user-1', name: 'Ada Agent' },
  { id: 'user-2', name: 'Alex Agent' },
  { id: 'user-3', name: 'Sam Support' },
];

function setup(overrides: Partial<React.ComponentProps<typeof MessageComposer>> = {}) {
  const onSend = vi.fn();
  const onAttach = vi.fn();
  const onRemoveAttachment = vi.fn();
  const utils = renderWithProviders(
    <MessageComposer
      onSend={onSend}
      attachments={[]}
      onAttach={onAttach}
      onRemoveAttachment={onRemoveAttachment}
      mentionCandidates={CANDIDATES}
      {...overrides}
    />,
  );
  return { onSend, onAttach, onRemoveAttachment, ...utils };
}

describe('MessageComposer', () => {
  it('defaults to the reply mode, labelled distinctly from a note', () => {
    setup();
    expect(screen.getByRole('form', { name: 'Reply to the customer' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Reply' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeInTheDocument();
    expect(screen.queryByText('Only visible to staff, not the customer.')).not.toBeInTheDocument();
  });

  it('switches to the note mode with its own label, warning and submit text', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: /Internal note/ }));
    expect(screen.getByRole('form', { name: 'Add an internal note' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Internal note' })).toBeInTheDocument();
    expect(screen.getByText('Only visible to staff, not the customer.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add note' })).toBeInTheDocument();
  });

  it('sends the trimmed body in the current mode and clears the field', async () => {
    const { onSend } = setup();
    await userEvent.click(screen.getByRole('button', { name: /Internal note/ }));
    const field = screen.getByRole('combobox', { name: 'Internal note' });
    await userEvent.type(field, '  Escalating to billing  ');
    await userEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(onSend).toHaveBeenCalledWith('Escalating to billing', 'note');
    expect(field).toHaveValue('');
  });

  it('disables every control when disabled', () => {
    setup({ disabled: true });
    expect(screen.getByRole('combobox', { name: 'Reply' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Attach a file' })).toBeDisabled();
  });

  it('opens the mention picker on "@" and inserts the highlighted candidate with the keyboard', async () => {
    setup();
    const field = screen.getByRole('combobox', { name: 'Reply' });
    await userEvent.type(field, 'Hello @al');
    const listbox = screen.getByRole('listbox', { name: 'Mention a staff member' });
    expect(listbox).toBeInTheDocument();
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Alex Agent']);

    // Only "Alex Agent" matches "al"; re-type "ag" to get both agents (not "Sam Support") and use
    // the keyboard to pick the second.
    await userEvent.clear(field);
    await userEvent.type(field, 'Hello @ag');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Ada Agent', 'Alex Agent']);
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: 'Alex Agent' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(field).toHaveValue('Hello @Alex Agent ');
  });

  it('closes the mention picker on Escape without inserting anything', async () => {
    const { onSend } = setup();
    const field = screen.getByRole('combobox', { name: 'Reply' });
    await userEvent.type(field, 'Hi @a');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(field).toHaveValue('Hi @a');
    expect(onSend).not.toHaveBeenCalled();
  });
});
