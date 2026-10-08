import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Typography from '@mui/material/Typography';
import { useId, useState, type ReactNode } from 'react';

import { EmptyState } from '../../../components/foundations/EmptyState';
import { useAnnounce } from '../../../components/foundations/LiveRegion';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { ConfirmationDialog } from '../../../components/shell/ConfirmationDialog';
import { DesignSystemScope } from '../../../components/shell/DesignSystemScope';
import { Form, FormError, FormField, SubmitButton } from '../../../components/shell/Form';
import { Modal } from '../../../components/shell/Modal';
import { useToast } from '../../../components/shell/Toast';
import {
  useAiModels,
  useAiSettings,
  useAiSettingsEvents,
  useRemoveAiProviderKey,
  useSaveAiProviderKey,
  useTestAiProviderKey,
  useUpdateAiSettings,
  type AiModels,
  type AiPauseReason,
  type AiSettings,
  type AiSettingsPatch,
  type ConnectionTest,
  type ModelOption,
} from '../../../data/ai/settings';
import { useRealtime } from '../../../data/realtime';

/**
 * AI settings (specs/002-ai-assist US1, FR-001 to FR-005), behind `ai_settings.manage`:
 *
 * - the tenant's own OpenRouter key: shown only as "•••• last4", with Add/Replace (a dialog with a
 *   password field), Remove (confirmed) and Test connection (a plain-language result);
 * - how the assistant replies (Off, Drafts for agents, Auto-reply) and the model for each level,
 *   with its price per million tokens, saved together (only changed fields are sent);
 * - an "AI paused" banner while a bad key or no credit has paused AI; it appears and clears live.
 */

const REPLY_MODES: readonly { value: AiSettings['replyMode']; label: string; description: string }[] = [
  { value: 'off', label: 'Off', description: 'The assistant does not answer customers.' },
  { value: 'drafts', label: 'Drafts for agents', description: 'The assistant writes a draft on each ticket; an agent reviews and sends it.' },
  { value: 'auto', label: 'Auto-reply', description: 'The assistant answers customers directly and hands over to the team when it is unsure.' },
];

const LEVELS: readonly { level: keyof AiSettings['models']; label: string; description: string }[] = [
  { level: 'fast', label: 'Fast', description: 'Simple questions' },
  { level: 'standard', label: 'Standard', description: 'Most questions' },
  { level: 'advanced', label: 'Advanced', description: 'Complex or sensitive conversations' },
];

const PAUSE_MESSAGES: Readonly<Record<AiPauseReason, string>> = {
  invalid_key: 'OpenRouter did not accept the saved key. Replace the key, or test it again once it is fixed.',
  no_credit: 'The OpenRouter account has no credit left. Add credit, then test the connection to resume.',
};

const PAUSE_TITLES: Readonly<Record<AiPauseReason, string>> = {
  invalid_key: 'AI paused: the key was not accepted',
  no_credit: 'AI paused: no credit left',
};

function price(value: number): string {
  return `$${value.toFixed(2)}`;
}

function optionLabel(option: ModelOption): string {
  return `${option.label}${option.isDefault ? ' (default)' : ''} · ${price(option.inputPerMillionUsd)} in / ${price(option.outputPerMillionUsd)} out per million tokens`;
}

export default function AiSettingsPage() {
  const settingsQuery = useAiSettings();
  const modelsQuery = useAiModels();
  useAiSettingsEvents(useRealtime());

  return (
    <DesignSystemScope>
      <Box component="main" sx={{ px: { xs: 4, sm: 8 }, py: 6, maxWidth: 880 }}>
        <Typography component="h1" variant="h1" sx={{ mb: 2 }}>
          AI settings
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 6, maxWidth: 680 }}>
          Connect your own OpenRouter account and choose how the assistant helps your team. Your organization pays OpenRouter directly for AI
          use.
        </Typography>

        {(settingsQuery.isPending || modelsQuery.isPending) && !settingsQuery.isError && !modelsQuery.isError && <Skeleton variant="block" label="AI settings" />}
        {settingsQuery.isError && (
          <EmptyState variant="error" title="Couldn't load AI settings" message={settingsQuery.error?.message} onRetry={() => void settingsQuery.refetch()} />
        )}
        {!settingsQuery.isError && modelsQuery.isError && (
          <EmptyState variant="error" title="Couldn't load the AI models" message={modelsQuery.error?.message} onRetry={() => void modelsQuery.refetch()} />
        )}
        {settingsQuery.isSuccess && modelsQuery.isSuccess && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {settingsQuery.data.paused !== null && settingsQuery.data.paused.reason !== undefined && (
              <Alert severity="warning" variant="outlined">
                <Typography component="h2" variant="body1" sx={{ fontWeight: 600 }}>
                  {PAUSE_TITLES[settingsQuery.data.paused.reason]}
                </Typography>
                {PAUSE_MESSAGES[settingsQuery.data.paused.reason]}
              </Alert>
            )}
            <ProviderSection settings={settingsQuery.data} />
            {/* Keyed by the saved values, so a save elsewhere (another tab, a pause) resets the form. */}
            <AssistantForm key={`${settingsQuery.data.replyMode}|${Object.values(settingsQuery.data.models).join('|')}`} settings={settingsQuery.data} models={modelsQuery.data} />
          </Box>
        )}
      </Box>
    </DesignSystemScope>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <Box component="section" aria-labelledby={headingId} sx={{ p: 5, border: 1, borderColor: 'divider', borderRadius: 3, bgcolor: 'background.paper' }}>
      <Typography id={headingId} component="h2" variant="h3" sx={{ mb: 1 }}>
        {title}
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 4 }}>
        {description}
      </Typography>
      {children}
    </Box>
  );
}

function ProviderSection({ settings }: { settings: AiSettings }) {
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [result, setResult] = useState<ConnectionTest | undefined>();
  const testKey = useTestAiProviderKey();
  const removeKey = useRemoveAiProviderKey();
  const announce = useAnnounce();
  const toast = useToast();
  const hasKey = settings.providerKey !== null;

  const runTest = async () => {
    setResult(undefined);
    try {
      const outcome = await testKey.mutateAsync();
      setResult(outcome);
      announce(outcome.ok ? 'Connection works' : `Connection failed: ${outcome.detail ?? ''}`, outcome.ok ? 'polite' : 'assertive');
    } catch {
      // The hook's mapped error is shown below.
    }
  };

  return (
    <Section title="AI provider" description="ReplyX uses OpenRouter to reach the AI models. Keys are stored encrypted and never shown again.">
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap', mb: 3 }}>
        <Typography sx={{ fontWeight: 600 }}>OpenRouter key</Typography>
        <Typography color={hasKey ? 'text.primary' : 'text.secondary'} sx={{ fontFamily: hasKey ? 'monospace' : undefined }}>
          {settings.providerKey === null ? 'No key saved' : `•••• ${settings.providerKey.last4 ?? ''}`}
        </Typography>
      </Box>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <Button variant={hasKey ? 'outlined' : 'contained'} onClick={() => setKeyDialogOpen(true)}>
          {hasKey ? 'Replace key' : 'Add key'}
        </Button>
        {hasKey && (
          <>
            <Button variant="outlined" onClick={() => void runTest()} disabled={testKey.isPending} aria-busy={testKey.isPending}>
              {testKey.isPending ? 'Testing…' : 'Test connection'}
            </Button>
            <Button color="error" onClick={() => setConfirmRemove(true)}>
              Remove key
            </Button>
          </>
        )}
      </Box>

      {result !== undefined && (
        // Announced once through useAnnounce, so the Alert itself is not a live region.
        <Alert severity={result.ok ? 'success' : 'error'} role="note" aria-label="Connection test result" sx={{ mt: 4 }}>
          {result.detail}
          {result.ok && typeof result.creditRemainingUsd === 'number' && ` Credit left on this key: ${price(result.creditRemainingUsd)}.`}
        </Alert>
      )}
      {testKey.error !== undefined && (
        <Alert severity="error" sx={{ mt: 4 }}>
          {testKey.error.message}
        </Alert>
      )}

      {keyDialogOpen && (
        <KeyDialog
          replacing={hasKey}
          onClose={() => setKeyDialogOpen(false)}
          onSaved={() => {
            setResult(undefined);
            toast({ message: 'Key saved. Test the connection to check it.', severity: 'success' });
          }}
        />
      )}
      <ConfirmationDialog
        open={confirmRemove}
        title="Remove the OpenRouter key?"
        message="The assistant stops until you add a key again."
        confirmLabel="Remove key"
        destructive
        onClose={() => setConfirmRemove(false)}
        onConfirm={async () => {
          await removeKey.mutateAsync();
          setResult(undefined);
          setConfirmRemove(false);
          toast({ message: 'Key removed', severity: 'success' });
        }}
      />
    </Section>
  );
}

function KeyDialog({ replacing, onClose, onSaved }: { replacing: boolean; onClose: () => void; onSaved: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const saveKey = useSaveAiProviderKey();
  const title = replacing ? 'Replace the OpenRouter key' : 'Add an OpenRouter key';
  return (
    <Modal open onClose={onClose} title={title} busy={saveKey.isPending}>
      <Form
        label={title}
        onSubmit={async () => {
          await saveKey.mutateAsync(apiKey.trim());
          onSaved();
          onClose();
        }}
      >
        <Typography color="text.secondary">Create a key in your OpenRouter account under Keys, then paste it here.</Typography>
        <FormField
          name="apiKey"
          label="API key"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          required
          slotProps={{ htmlInput: { maxLength: 200, spellCheck: false } }}
        />
        <FormError />
        <SubmitButton disabled={apiKey.trim().length < 8}>Save key</SubmitButton>
      </Form>
    </Modal>
  );
}

function AssistantForm({ settings, models }: { settings: AiSettings; models: AiModels }) {
  const [replyMode, setReplyMode] = useState(settings.replyMode);
  const [chosen, setChosen] = useState(settings.models);
  const update = useUpdateAiSettings();
  const toast = useToast();

  const patch: AiSettingsPatch = {};
  if (replyMode !== settings.replyMode) patch.replyMode = replyMode;
  const changedModels = Object.fromEntries(LEVELS.filter(({ level }) => chosen[level] !== settings.models[level]).map(({ level }) => [level, chosen[level]]));
  if (Object.keys(changedModels).length > 0) patch.models = changedModels;
  const dirty = Object.keys(patch).length > 0;

  return (
    <Section title="Assistant" description="Choose how the assistant answers customers and which model it uses for each level of difficulty.">
      <Form
        label="Assistant settings"
        onSubmit={async () => {
          await update.mutateAsync(patch);
          toast({ message: 'AI settings saved', severity: 'success' });
        }}
      >
        <FormControl>
          <FormLabel id="ai-reply-mode" sx={{ fontWeight: 600, color: 'text.primary', mb: 1 }}>
            Replies
          </FormLabel>
          <RadioGroup aria-labelledby="ai-reply-mode" name="replyMode" value={replyMode} onChange={(event) => setReplyMode(event.target.value as AiSettings['replyMode'])}>
            {REPLY_MODES.map((mode) => (
              <FormControlLabel
                key={mode.value}
                value={mode.value}
                control={<Radio />}
                sx={{ alignItems: 'flex-start', mb: 2, '& .MuiRadio-root': { pt: 0.5 } }}
                label={
                  <Box>
                    <Typography sx={{ fontWeight: 500 }}>{mode.label}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {mode.description}
                    </Typography>
                  </Box>
                }
              />
            ))}
          </RadioGroup>
        </FormControl>
        {replyMode !== 'off' && settings.providerKey === null && (
          <Alert severity="info">Add an OpenRouter key above: the assistant stays off until a key is saved.</Alert>
        )}

        <Box component="fieldset" sx={{ border: 0, m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Typography component="legend" sx={{ fontWeight: 600, mb: 2 }}>
            Models
          </Typography>
          {LEVELS.map(({ level, label, description }) => (
            <FormField
              key={level}
              select
              name={`models.${level}`}
              label={`${label} model`}
              helperText={description}
              value={chosen[level]}
              onChange={(event) => setChosen({ ...chosen, [level]: event.target.value })}
            >
              {models.levels[level].map((option) => (
                <MenuItem key={option.id} value={option.id}>
                  {optionLabel(option)}
                </MenuItem>
              ))}
            </FormField>
          ))}
        </Box>
        <FormError />
        <Box>
          <SubmitButton disabled={!dirty}>Save changes</SubmitButton>
        </Box>
      </Form>
    </Section>
  );
}
