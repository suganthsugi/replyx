import Button from '@mui/material/Button';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmationDialog } from '../../src/components/shell/ConfirmationDialog';
import { Drawer } from '../../src/components/shell/Drawer';
import { ErrorBoundary } from '../../src/components/shell/ErrorBoundary';
import { Form, FormError, FormField, SubmitButton } from '../../src/components/shell/Form';
import { Modal } from '../../src/components/shell/Modal';
import { useToast } from '../../src/components/shell/Toast';
import { HttpError } from '../../src/data/http';
import { renderWithProviders } from '../render';
import { expectNoAxeViolations } from '../setup';

function apiError(status: number, code: string, message: string, details?: { path: string; issue: string }[]) {
  return new HttpError(status, { code, message, ...(details === undefined ? {} : { details }) });
}

describe('Modal', () => {
  function WithTrigger({ busy = false }: { busy?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open settings</Button>
        <Modal open={open} onClose={() => setOpen(false)} title="Settings" busy={busy} actions={<Button>Save</Button>}>
          Body
        </Modal>
      </>
    );
  }

  it('is named by its title and returns focus to the trigger on Escape', async () => {
    renderWithProviders(<WithTrigger />);
    const trigger = screen.getByRole('button', { name: 'Open settings' });
    await userEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    await expectNoAxeViolations(dialog);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('cannot be closed while busy', async () => {
    renderWithProviders(<WithTrigger busy />);
    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
  });
});

describe('Drawer', () => {
  it('is a named dialog with a close button', async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <Drawer open onClose={onClose} title="Customer">
        Details
      </Drawer>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Customer' });
    await expectNoAxeViolations(dialog);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ConfirmationDialog', () => {
  it('requires the typed word before confirming, then closes', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    renderWithProviders(
      <ConfirmationDialog
        open
        title="Erase user"
        message="This removes their personal data."
        confirmLabel="Erase"
        destructive
        requireText="ERASE"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    const confirm = screen.getByRole('button', { name: 'Erase' });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Type ERASE to confirm' }), 'ERASE');
    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('stays open and shows the mapped error when confirming fails', async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <ConfirmationDialog
        open
        title="Delete user"
        message="Delete this user?"
        confirmLabel="Delete"
        onConfirm={() => Promise.reject(apiError(409, 'USER_HAS_HISTORY', 'This user has history; deactivate them instead.'))}
        onClose={onClose}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('This user has history; deactivate them instead.')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await expectNoAxeViolations(screen.getByRole('dialog', { name: 'Delete user' }));
  });
});

describe('ErrorBoundary', () => {
  it('shows a generic error instead of the thrown text, and retries', async () => {
    let fail = true;
    function Fragile() {
      if (fail) throw new Error('secret stack detail');
      return <p>Recovered</p>;
    }
    const onError = vi.fn();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderWithProviders(
      <ErrorBoundary onError={onError}>
        <Fragile />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.queryByText(/secret stack detail/)).not.toBeInTheDocument();
    expect(onError).toHaveBeenCalled();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Recovered')).toBeInTheDocument();
    spy.mockRestore();
  });
});

describe('Form', () => {
  function InviteForm({ onSubmit }: { onSubmit: () => Promise<void> }) {
    return (
      <Form label="Invite a user" onSubmit={onSubmit}>
        <FormField name="email" label="Email" />
        <FormError />
        <SubmitButton>Send invitation</SubmitButton>
      </Form>
    );
  }

  it('puts validation issues on the matching field', async () => {
    const { container } = renderWithProviders(
      <InviteForm onSubmit={() => Promise.reject(apiError(400, 'VALIDATION_FAILED', 'Invalid', [{ path: 'email', issue: 'invalid_format' }]))} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    const field = await screen.findByRole('textbox', { name: 'Email' });
    await waitFor(() => expect(field).toHaveAccessibleDescription('Check the format of this value'));
    expect(field).toHaveAttribute('aria-invalid', 'true');
    await expectNoAxeViolations(container);
  });

  it('shows other failures as a form error and disables submit while submitting', async () => {
    let reject: (reason: unknown) => void = () => undefined;
    renderWithProviders(
      <InviteForm
        onSubmit={() =>
          new Promise<void>((_resolve, rejectPromise) => {
            reject = rejectPromise;
          })
        }
      />,
    );
    const submit = screen.getByRole('button', { name: 'Send invitation' });
    await userEvent.click(submit);
    expect(submit).toBeDisabled();
    reject(apiError(409, 'EMAIL_IN_USE', 'A user with this email already exists.'));
    expect(await screen.findByText('A user with this email already exists.')).toBeInTheDocument();
    expect(submit).toBeEnabled();
  });
});

describe('Toast', () => {
  function Saver() {
    const toast = useToast();
    return (
      <>
        <Button onClick={() => toast({ message: 'Saved', severity: 'success' })}>Save</Button>
        <Button onClick={() => toast({ message: 'Could not save', severity: 'error' })}>Fail</Button>
      </>
    );
  }

  it('shows the toast and announces it through the live region', async () => {
    const { container } = renderWithProviders(<Saver />);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved', { selector: '.MuiAlert-message' })).toBeInTheDocument();
    expect(container.ownerDocument.querySelector('[aria-live="polite"]')).toHaveTextContent('Saved');
    await userEvent.click(screen.getByRole('button', { name: 'Fail' }));
    expect(container.ownerDocument.querySelector('[aria-live="assertive"]')).toHaveTextContent('Could not save');
  });
});
