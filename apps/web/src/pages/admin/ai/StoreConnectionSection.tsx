import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { useEffect, useRef, useState } from 'react';

import { EmptyState } from '../../../components/foundations/EmptyState';
import { useAnnounce } from '../../../components/foundations/LiveRegion';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { ConfirmationDialog } from '../../../components/shell/ConfirmationDialog';
import { Form, FormField, SubmitButton } from '../../../components/shell/Form';
import { Modal } from '../../../components/shell/Modal';
import { useToast } from '../../../components/shell/Toast';
import {
  mapStoreConnectionError,
  storeTestErrorMessage,
  useRemoveStoreConnection,
  useSaveStoreConnection,
  useStoreConnection,
  useTestStoreConnection,
  type ConnectionTest,
  type StoreConnection,
  type StoreConnectionFormError,
} from '../../../data/ai/storeConnection';

import { AiSection } from './AiSection';

/**
 * The store connection for order lookups (specs/002-ai-assist US3, FR-014 to FR-016), inside AI
 * settings (`ai_settings.manage`). It follows the provider-key section: the key is write-only and
 * only shown as "•••• last4"; Replace opens a dialog, Remove is confirmed, Test connection gives a
 * plain-language result that is announced once.
 */

const SCOPES = ['read_orders', 'read_customers', 'read_fulfillments'] as const;

const formatTime = (iso: string) => new Date(iso).toLocaleString();

export function StoreConnectionSection() {
  const query = useStoreConnection();
  const connection = query.data;
  const [justConnected, setJustConnected] = useState(false);

  return (
    <AiSection
      title="Store (Spree)"
      description="Let the assistant look up orders, customers and delivery status in your Spree store so it can answer questions like “where is my order?”."
    >
      <ScopeNote />
      {query.isPending && <Skeleton variant="block" label="the store connection" />}
      {query.isError && (
        <EmptyState variant="error" title="Couldn't load the store connection" message={query.error?.message} onRetry={() => void query.refetch()} headingLevel={3} />
      )}
      {query.isSuccess && connection === null && <ConnectForm onConnected={() => setJustConnected(true)} />}
      {query.isSuccess && connection !== null && connection !== undefined && <ConnectedView connection={connection} focusOnMount={justConnected} />}
    </AiSection>
  );
}

function ScopeNote() {
  return (
    <Box sx={{ mb: 4 }}>
      <Typography sx={{ fontWeight: 600, mb: 1 }}>Use a read-only key</Typography>
      <Typography variant="body2" color="text.secondary">
        In your Spree admin, create an API key with only these scopes:{' '}
        {SCOPES.map((scope, index) => (
          <span key={scope}>
            <Box component="code" sx={{ fontFamily: 'monospace', fontWeight: 600, color: 'text.primary' }}>
              {scope}
            </Box>
            {index < SCOPES.length - 1 ? ', ' : '.'}
          </span>
        ))}{' '}
        The assistant only reads from your store and never needs permission to change anything. The key is stored encrypted and never shown again.
      </Typography>
    </Box>
  );
}

function ConnectForm({ onConnected }: { onConnected: () => void }) {
  const toast = useToast();
  return (
    <Box>
      <Typography sx={{ mb: 3 }}>No store is connected. Without one, the assistant cannot look up orders.</Typography>
      <StoreForm
        keyRequired
        submitLabel="Connect store"
        label="Connect your store"
        onSaved={() => {
          onConnected();
          toast({ message: 'Store connected. Test the connection to check it.', severity: 'success' });
        }}
      />
    </Box>
  );
}

function ConnectedView({ connection, focusOnMount }: { connection: StoreConnection; focusOnMount: boolean }) {
  const [replacing, setReplacing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [result, setResult] = useState<ConnectionTest | undefined>();
  const testConnection = useTestStoreConnection();
  const removeConnection = useRemoveStoreConnection();
  const announce = useAnnounce();
  const toast = useToast();
  const summaryRef = useRef<HTMLDivElement>(null);
  const lastTest = connection.lastTest ?? null;

  // Arriving here from the connect form: the form is gone, so land on the summary.
  useEffect(() => {
    if (focusOnMount) summaryRef.current?.focus();
  }, []);

  const runTest = async () => {
    setResult(undefined);
    try {
      const outcome = await testConnection.mutateAsync();
      setResult(outcome);
      announce(outcome.ok ? 'Store connection works' : `Store connection failed: ${outcome.detail ?? storeTestErrorMessage(outcome.error)}`, outcome.ok ? 'polite' : 'assertive');
    } catch {
      // The hook's mapped error is shown below.
    }
  };

  return (
    <Box>
      <Box ref={summaryRef} tabIndex={-1} sx={{ outline: 'none', display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 4, rowGap: 1, mb: 3, alignItems: 'baseline' }}>
        <Typography sx={{ fontWeight: 600 }}>Store address</Typography>
        <Typography sx={{ overflowWrap: 'anywhere' }}>{connection.baseUrl}</Typography>
        <Typography sx={{ fontWeight: 600 }}>Store key</Typography>
        <Typography sx={{ fontFamily: 'monospace' }}>{`•••• ${connection.apiKey.last4 ?? ''}`}</Typography>
        <Typography sx={{ fontWeight: 600 }}>Last test</Typography>
        <Typography color={lastTest === null ? 'text.secondary' : 'text.primary'}>
          {lastTest === null && 'Not tested yet'}
          {lastTest !== null && lastTest.ok === true && `Worked${lastTest.at === undefined ? '' : ` on ${formatTime(lastTest.at)}`}`}
          {lastTest !== null && lastTest.ok !== true && `Failed${lastTest.at === undefined ? '' : ` on ${formatTime(lastTest.at)}`}${lastTest.error === undefined ? '' : `: ${storeTestErrorMessage(lastTest.error)}`}`}
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <Button variant="outlined" onClick={() => setReplacing(true)}>
          Replace
        </Button>
        <Button variant="outlined" onClick={() => void runTest()} disabled={testConnection.isPending} aria-busy={testConnection.isPending}>
          {testConnection.isPending ? 'Testing…' : 'Test connection'}
        </Button>
        <Button color="error" onClick={() => setConfirmRemove(true)}>
          Remove
        </Button>
      </Box>

      {result !== undefined && (
        // Announced once through useAnnounce, so the Alert itself is not a live region.
        <Alert severity={result.ok ? 'success' : 'error'} role="note" aria-label="Store connection test result" sx={{ mt: 4 }}>
          {result.detail ?? (result.ok ? 'The store answered.' : storeTestErrorMessage(result.error))}
        </Alert>
      )}
      {testConnection.error !== undefined && (
        <Alert severity="error" sx={{ mt: 4 }}>
          {testConnection.error.message}
        </Alert>
      )}

      {replacing && (
        <Modal open onClose={() => setReplacing(false)} title="Replace the store connection">
          <StoreForm
            initialUrl={connection.baseUrl}
            keyRequired={false}
            submitLabel="Save connection"
            label="Replace the store connection"
            onSaved={() => {
              setResult(undefined);
              setReplacing(false);
              toast({ message: 'Store connection saved. Test the connection to check it.', severity: 'success' });
            }}
          />
        </Modal>
      )}
      <ConfirmationDialog
        open={confirmRemove}
        title="Remove the store connection?"
        message="The assistant can no longer look up orders. It will hand those questions to your team."
        confirmLabel="Remove connection"
        destructive
        onClose={() => setConfirmRemove(false)}
        onConfirm={async () => {
          await removeConnection.mutateAsync();
          setResult(undefined);
          setConfirmRemove(false);
          toast({ message: 'Store connection removed', severity: 'success' });
        }}
      />
    </Box>
  );
}

interface StoreFormProps {
  initialUrl?: string;
  /** True when connecting for the first time: the key is required. */
  keyRequired: boolean;
  submitLabel: string;
  label: string;
  onSaved: () => void;
}

function StoreForm({ initialUrl = '', keyRequired, submitLabel, label, onSaved }: StoreFormProps) {
  const save = useSaveStoreConnection();
  const announce = useAnnounce();
  const [baseUrl, setBaseUrl] = useState(initialUrl);
  const [apiKey, setApiKey] = useState('');
  const [errors, setErrors] = useState<StoreConnectionFormError | undefined>();
  const [focusTarget, setFocusTarget] = useState<'baseUrl' | 'apiKey' | undefined>();
  const urlRef = useRef<HTMLInputElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);

  // Focus the first field with a problem once the form is enabled again.
  useEffect(() => {
    if (focusTarget === undefined) return undefined;
    const timer = setTimeout(() => {
      (focusTarget === 'baseUrl' ? urlRef : keyRef).current?.focus();
      setFocusTarget(undefined);
    }, 0);
    return () => clearTimeout(timer);
  }, [focusTarget]);

  const trimmedUrl = baseUrl.trim();
  const trimmedKey = apiKey.trim();
  const keyOk = keyRequired ? trimmedKey.length >= 8 : trimmedKey === '' || trimmedKey.length >= 8;
  const keyHelp = keyRequired
    ? 'The read-only API key from your Spree admin.'
    : 'Leave blank to keep the saved key. If you change the store address, enter the key again.';

  return (
    <Form
      label={label}
      onSubmit={async () => {
        setErrors(undefined);
        try {
          await save.mutateAsync({ kind: 'spree', baseUrl: trimmedUrl, ...(trimmedKey === '' ? {} : { apiKey: trimmedKey }) });
          setApiKey('');
          onSaved();
        } catch (caught) {
          const mapped = mapStoreConnectionError(caught);
          setErrors(mapped);
          setFocusTarget(mapped.baseUrl !== undefined ? 'baseUrl' : mapped.apiKey !== undefined ? 'apiKey' : undefined);
          announce(mapped.baseUrl ?? mapped.apiKey ?? mapped.message ?? 'Could not save the store connection', 'assertive');
        }
      }}
    >
      <FormField
        name="baseUrl"
        label="Store address"
        required
        type="url"
        autoComplete="off"
        placeholder="https://shop.example.com"
        value={baseUrl}
        onChange={(event) => setBaseUrl(event.target.value)}
        error={errors?.baseUrl !== undefined}
        helperText={errors?.baseUrl ?? (keyRequired ? 'The public https address of your Spree store.' : 'If you change the address, you must enter the key again.')}
        inputRef={urlRef}
        slotProps={{ htmlInput: { maxLength: 300, spellCheck: false } }}
      />
      <FormField
        name="apiKey"
        label="Store key (read-only)"
        type="password"
        autoComplete="off"
        required={keyRequired}
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
        error={errors?.apiKey !== undefined}
        helperText={errors?.apiKey ?? keyHelp}
        inputRef={keyRef}
        slotProps={{ htmlInput: { maxLength: 200, spellCheck: false } }}
      />
      {errors?.message !== undefined && <Alert severity="error">{errors.message}</Alert>}
      <Box>
        <SubmitButton disabled={trimmedUrl === '' || !keyOk}>{submitLabel}</SubmitButton>
      </Box>
    </Form>
  );
}
