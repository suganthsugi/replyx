import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import Slider from '@mui/material/Slider';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import { useId, useState } from 'react';

import { Form, FormError, SubmitButton } from '../../../components/shell/Form';
import { useToast } from '../../../components/shell/Toast';
import { useUpdateAiSettings, type AiSettings, type AiSettingsPatch } from '../../../data/ai/settings';

import { AiSection } from './AiSection';

/**
 * AI routing (specs/002-ai-assist US4, FR-023/024): new customer tickets that no routing rule
 * matched go to the group whose AI description fits best, when the model is at least as sure as
 * the threshold; otherwise they stay in Needs Triage. Rules always run first. Only changed fields
 * are sent; the caller keys this form by the saved values, so a save elsewhere resets it.
 */
export function RoutingSection({ settings }: { settings: AiSettings }) {
  const [enabled, setEnabled] = useState(settings.routingEnabled);
  const [threshold, setThreshold] = useState(Math.round(settings.routingThreshold * 100));
  const update = useUpdateAiSettings();
  const toast = useToast();
  const sliderLabelId = useId();
  const sliderHelpId = useId();

  const patch: AiSettingsPatch = {};
  if (enabled !== settings.routingEnabled) patch.routingEnabled = enabled;
  if (threshold / 100 !== settings.routingThreshold) patch.routingThreshold = threshold / 100;
  const dirty = Object.keys(patch).length > 0;

  return (
    <AiSection
      title="Routing"
      description="Send new customer tickets that no routing rule matched to the group whose AI description fits best. Add AI descriptions on the Groups page."
    >
      <Form
        label="Routing settings"
        onSubmit={async () => {
          await update.mutateAsync(patch);
          toast({ message: 'Routing settings saved', severity: 'success' });
        }}
      >
        <FormControlLabel control={<Switch checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />} label="Route new tickets with AI" />
        <Box sx={{ maxWidth: 420 }}>
          <Typography id={sliderLabelId} sx={{ fontWeight: 600 }}>
            Confidence needed: {threshold}%
          </Typography>
          <Slider
            value={threshold}
            min={50}
            max={99}
            step={1}
            disabled={!enabled}
            onChange={(_event, value) => setThreshold(value)}
            valueLabelDisplay="auto"
            valueLabelFormat={(value) => `${value}%`}
            slotProps={{ input: { 'aria-labelledby': sliderLabelId, 'aria-describedby': sliderHelpId, 'aria-valuetext': `${threshold}%` } }}
          />
          <Typography id={sliderHelpId} variant="body2" color="text.secondary">
            Below this, the ticket stays in Needs Triage for a person to sort.
          </Typography>
        </Box>
        <FormError />
        <Box>
          <SubmitButton disabled={!dirty}>Save routing</SubmitButton>
        </Box>
      </Form>
    </AiSection>
  );
}
