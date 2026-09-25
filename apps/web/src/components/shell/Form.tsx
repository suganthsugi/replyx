import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button, { type ButtonProps } from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import TextField, { type TextFieldProps } from '@mui/material/TextField';
import { createContext, useContext, useState, type FormEvent, type ReactNode } from 'react';

import { mapError, type UiError } from '../../data/errors';

/**
 * Forms with consistent submit and error states. `Form` runs an async `onSubmit`, tracks
 * submitting, and maps a failure through `mapError`: validation `fieldErrors` land on the
 * matching `FormField` (by `name`), anything else in `FormError`. `SubmitButton` disables itself
 * and shows progress while submitting.
 */

interface FormState {
  submitting: boolean;
  error?: UiError;
}

const FormContext = createContext<FormState>({ submitting: false });

/** The API's validation `issue` codes (apps/api validation.pipe.ts) mapped to field messages. */
const ISSUE_MESSAGES: Record<string, string> = {
  required: 'This field is required',
  too_long: 'This is too long',
  too_short: 'This is too short',
  too_many: 'Too many items',
  too_few: 'Too few items',
  too_large: 'This value is too large',
  too_small: 'This value is too small',
  invalid_format: 'Check the format of this value',
  invalid_timezone: 'Choose a valid time zone',
  invalid_value: 'Choose one of the allowed values',
  invalid_type: 'This value is not valid',
  invalid: 'This value is not valid',
  unrecognized_key: 'This field is not allowed',
};

export function issueMessage(issue: string): string {
  return ISSUE_MESSAGES[issue] ?? 'This value is not valid';
}

export interface FormProps {
  onSubmit: () => Promise<void> | void;
  children: ReactNode;
  /** Accessible name for the form, e.g. "Invite a user". */
  label?: string;
}

export function Form({ onSubmit, children, label }: FormProps) {
  const [state, setState] = useState<FormState>({ submitting: false });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state.submitting) return;
    setState({ submitting: true });
    try {
      await onSubmit();
      setState({ submitting: false });
    } catch (caught) {
      setState({ submitting: false, error: mapError(caught) });
    }
  };

  return (
    <FormContext.Provider value={state}>
      <Box
        component="form"
        noValidate
        aria-label={label}
        aria-busy={state.submitting}
        onSubmit={(event: FormEvent<HTMLFormElement>) => void submit(event)}
        sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}
      >
        {children}
      </Box>
    </FormContext.Provider>
  );
}

/** A labelled text field whose server-side validation error comes from the enclosing `Form`. */
export function FormField({ name, helperText, disabled, ...props }: TextFieldProps & { name: string; label: string }) {
  const { submitting, error } = useContext(FormContext);
  const issue = error?.fieldErrors?.[name];
  return (
    <TextField
      {...props}
      name={name}
      disabled={disabled === true || submitting}
      error={issue !== undefined || props.error === true}
      helperText={issue === undefined ? helperText : issueMessage(issue)}
      fullWidth
    />
  );
}

/** The form-level error (anything that isn't a field validation issue). */
export function FormError() {
  const { error } = useContext(FormContext);
  if (error === undefined || error.fieldErrors !== undefined) return null;
  return <Alert severity="error">{error.message}</Alert>;
}

export function SubmitButton({ children, disabled, ...props }: ButtonProps) {
  const { submitting } = useContext(FormContext);
  return (
    <Button
      type="submit"
      variant="contained"
      {...props}
      disabled={disabled === true || submitting}
      aria-busy={submitting}
      startIcon={submitting ? <CircularProgress size={16} color="inherit" aria-hidden="true" /> : props.startIcon}
    >
      {children}
    </Button>
  );
}
