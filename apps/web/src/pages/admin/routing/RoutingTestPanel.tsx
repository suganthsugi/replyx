import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import { OptionPicker } from '../../../components/builders/ConditionValueInput';
import { priorityLabel, ruleIssueMessage, toNameMap } from '../../../components/builders/rule-model';
import { useAnnounce } from '../../../components/foundations/LiveRegion';
import { mapError } from '../../../data/errors';

import type { RoutingDryRun, TestRoutingRulesBody } from '../../../api/generated/model';

/**
 * "Try a message": runs the rules, exactly as live routing would, against a sample first message
 * and says which rule would win and where the ticket would go. Nothing is created or changed.
 */

export interface RoutingTestPanelProps {
  /** Rule names in evaluation order, to turn the matched id into "rule N". */
  ruleIds: readonly string[];
  groupNames: ReadonlyMap<string, string>;
  tags: readonly { id: string; name: string }[];
  tagsLoading: boolean;
  onTest: (body: TestRoutingRulesBody) => Promise<RoutingDryRun>;
}

const MAX_MESSAGE_LENGTH = 10_000;

export function RoutingTestPanel({ ruleIds, groupNames, tags, tagsLoading, onTest }: RoutingTestPanelProps) {
  const announce = useAnnounce();
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ run: RoutingDryRun; text: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const run = async () => {
    if (running || message.trim() === '') return;
    setRunning(true);
    setProblem(null);
    setFieldErrors({});
    const body: TestRoutingRulesBody = { message: message.trim() };
    if (email.trim() !== '') body.customerEmail = email.trim();
    if (tagIds.length > 0) body.customerTagIds = tagIds;
    try {
      const outcome = await onTest(body);
      const text = describeResult(outcome, ruleIds, groupNames, toNameMap(tags));
      setResult({ run: outcome, text });
      announce(outcome.skipped.length > 0 ? `${text} ${describeSkipped(outcome)}` : text);
    } catch (caught) {
      const mapped = mapError(caught);
      setResult(null);
      if (mapped.code === 'VALIDATION_FAILED' && mapped.fieldErrors !== undefined) {
        const found = Object.fromEntries(Object.entries(mapped.fieldErrors).map(([path, issue]) => [path, ruleIssueMessage(issue)]));
        setFieldErrors(found);
        announce(`The test did not run. ${Object.values(found).join(' ')}`, 'assertive');
      } else {
        setProblem(mapped.message);
        announce(`The test did not run. ${mapped.message}`, 'assertive');
      }
    } finally {
      setRunning(false);
    }
  };

  const tagError = Object.entries(fieldErrors).find(([path]) => path === 'customerTagIds' || path.startsWith('customerTagIds.'))?.[1];
  const bodyError = fieldErrors[''] ?? fieldErrors.customerId;

  return (
    <Box
      component="section"
      aria-labelledby="routing-test-heading"
      sx={{ mt: 8, p: 4, border: 1, borderColor: 'divider', borderRadius: 1.5, bgcolor: 'background.paper', display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 720 }}
    >
      <Box>
        <Typography id="routing-test-heading" component="h2" variant="h6">
          Try a message
        </Typography>
        <Typography variant="body2" color="text.secondary">
          See which rule would catch a customer&apos;s first message. Nothing is created.
        </Typography>
      </Box>
      <Box
        component="form"
        noValidate
        aria-labelledby="routing-test-heading"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
        sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}
      >
        <TextField
          label="Message"
          required
          multiline
          minRows={3}
          fullWidth
          size="small"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          error={fieldErrors.message !== undefined}
          helperText={fieldErrors.message}
          slotProps={{ htmlInput: { maxLength: MAX_MESSAGE_LENGTH } }}
        />
        <TextField
          label="Customer email"
          type="email"
          fullWidth
          size="small"
          autoComplete="off"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={fieldErrors.customerEmail !== undefined}
          helperText={fieldErrors.customerEmail ?? 'Optional. Used by email domain conditions.'}
          slotProps={{ htmlInput: { maxLength: 254 } }}
        />
        <OptionPicker
          label="Customer tags"
          options={tags}
          ids={tagIds}
          onChange={(next) => setTagIds(next.slice(0, 20))}
          unknownLabel="Unknown tag"
          loading={tagsLoading}
          error={tagError}
          noOptionsText="No matching tags"
        />
        {bodyError !== undefined && <Alert severity="error">{bodyError}</Alert>}
        {problem !== null && <Alert severity="error">{problem}</Alert>}
        <Box>
          <Button
            type="submit"
            variant="contained"
            disabled={running || message.trim() === ''}
            aria-busy={running}
            startIcon={running ? <CircularProgress size={16} color="inherit" aria-hidden="true" /> : undefined}
          >
            Run
          </Button>
        </Box>
      </Box>

      {result !== null && (
        // Announced through the live region when it appears; the group role keeps it findable.
        <Alert severity={result.run.matchedRuleId === null ? 'info' : 'success'} role="group" aria-label="Test result">
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {result.text}
          </Typography>
          {result.run.skipped.length > 0 && (
            <Typography variant="body2" sx={{ mt: 1 }}>
              {describeSkipped(result.run)}
            </Typography>
          )}
        </Alert>
      )}
    </Box>
  );
}

function describeResult(run: RoutingDryRun, ruleIds: readonly string[], groupNames: ReadonlyMap<string, string>, tagNames: ReadonlyMap<string, string>): string {
  if (run.matchedRuleId === null || run.actions === null) return 'No rule matches: the ticket would stay in Needs Triage.';
  const index = ruleIds.indexOf(run.matchedRuleId);
  const number = index === -1 ? '' : ` ${index + 1}`;
  const details: string[] = [];
  if (run.actions.priority !== undefined) details.push(priorityLabel(run.actions.priority).toLowerCase());
  const tags = (run.actions.tagIds ?? []).map((id) => tagNames.get(id)).filter((name): name is string => name !== undefined);
  if (tags.length > 0) details.push(`tags ${tags.join(', ')}`);
  const group = groupNames.get(run.actions.groupId) ?? 'an unknown group';
  return `Matches rule${number}: ${run.matchedRuleName ?? 'Unnamed'} -> ${group}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
}

function describeSkipped(run: RoutingDryRun): string {
  const inactive = run.skipped.filter((item) => item.reason === 'group_inactive').map((item) => item.ruleName);
  const missing = run.skipped.filter((item) => item.reason === 'group_missing').map((item) => item.ruleName);
  const parts: string[] = [];
  if (inactive.length > 0) parts.push(`Skipped because their group is inactive: ${inactive.join(', ')}.`);
  if (missing.length > 0) parts.push(`Skipped because their group no longer exists: ${missing.join(', ')}.`);
  return parts.join(' ');
}
