import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Slider from '@mui/material/Slider';
import Typography from '@mui/material/Typography';
import { useId, useState } from 'react';

import { EmptyState } from '../../../components/foundations/EmptyState';
import { useAnnounce } from '../../../components/foundations/LiveRegion';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { DesignSystemScope } from '../../../components/shell/DesignSystemScope';
import { Form, FormError, FormField, SubmitButton, useFormIssue } from '../../../components/shell/Form';
import { useToast } from '../../../components/shell/Toast';
import { useComplexity, useSaveComplexity, type ComplexityConfig, type ComplexityFactor, type ComplexityFactorKind } from '../../../data/ai/complexity';
import { useTags } from '../../../data/tags';

import { AiSection } from './AiSection';

/**
 * Complexity (specs/002-ai-assist US4, FR-025/026, research R12), behind `ai_settings.manage`. Each
 * factor gives the conversation a value from 0 to 1; their weighted average is the complexity
 * score, and the two thresholds turn the score into the model level (Fast, Standard, Advanced)
 * that answers. Factors are added, edited, reordered and removed locally and saved together;
 * the bands preview follows the threshold sliders as they move.
 */

const MAX_FACTORS = 12;
const KINDS: readonly { value: ComplexityFactorKind; label: string; help: string }[] = [
  { value: 'noul', label: 'Yes or no question', help: 'Worth 1 when the answer is yes.' },
  { value: 'score', label: 'Scale', help: 'Worth more the higher the level, from 0 for the first to 1 for the last.' },
  { value: 'choice', label: 'Multiple choice', help: 'Worth the value of the option that fits.' },
  { value: 'customer_tag', label: 'Customer has a tag', help: 'Worth 1 when the customer has the tag.' },
  { value: 'reopen_count', label: 'Times reopened', help: 'Worth 1 from the third reopen.' },
  { value: 'sla_breached', label: 'SLA breached', help: 'Worth 1 while the ticket has missed an SLA target.' },
];

interface Draft {
  /** Local only, for React keys. */
  uid: string;
  key: string;
  keyTouched: boolean;
  label: string;
  kind: ComplexityFactorKind;
  weight: number;
  instructions: string;
  yes: string;
  no: string;
  options: { key: string; description: string; value: number }[];
  levels: string[];
  tagId: string;
}

let nextUid = 0;
const uid = () => `factor-${(nextUid += 1)}`;

function toDraft(factor: ComplexityFactor): Draft {
  return {
    uid: uid(),
    key: factor.key,
    keyTouched: true,
    label: factor.label,
    kind: factor.kind,
    weight: factor.weight,
    instructions: factor.instructions ?? '',
    yes: factor.criteria?.true ?? '',
    no: factor.criteria?.false ?? '',
    options: factor.options ?? [],
    levels: factor.levels ?? [],
    tagId: factor.tagId ?? '',
  };
}

function newDraft(): Draft {
  return { uid: uid(), key: '', keyTouched: false, label: '', kind: 'noul', weight: 1, instructions: '', yes: '', no: '', options: [], levels: [], tagId: '' };
}

/** The factor as the API takes it: only the fields of its kind. */
function toFactor(draft: Draft): ComplexityFactor {
  const base = { key: draft.key, label: draft.label.trim(), kind: draft.kind, weight: draft.weight };
  switch (draft.kind) {
    case 'noul':
      return { ...base, instructions: draft.instructions.trim(), criteria: { true: draft.yes.trim(), false: draft.no.trim() } };
    case 'choice':
      return { ...base, instructions: draft.instructions.trim(), options: draft.options.map((option) => ({ ...option, description: option.description.trim() })) };
    case 'score':
      return { ...base, instructions: draft.instructions.trim(), levels: draft.levels.map((level) => level.trim()) };
    case 'customer_tag':
      return { ...base, tagId: draft.tagId };
    case 'reopen_count':
    case 'sla_breached':
      return base;
  }
}

/** A key from a label: lowercase letters, digits and underscores, starting with a letter. */
export function keyFromLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '');
  return slug.slice(0, 40);
}

export default function ComplexityPage() {
  const query = useComplexity();
  return (
    <DesignSystemScope>
      <Box component="main" sx={{ px: { xs: 4, sm: 8 }, py: 6, maxWidth: 880 }}>
        <Typography component="h1" variant="h1" sx={{ mb: 2 }}>
          Complexity
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 6, maxWidth: 680 }}>
          Decide which conversations need a more capable model. Each factor adds to the conversation&apos;s complexity score, and the score picks the
          model level that answers.
        </Typography>
        {query.isPending && <Skeleton variant="block" label="complexity settings" />}
        {query.isError && <EmptyState variant="error" title="Couldn't load the complexity settings" message={query.error?.message} onRetry={() => void query.refetch()} />}
        {query.isSuccess && <ComplexityForm key={JSON.stringify(query.data)} config={query.data} />}
      </Box>
    </DesignSystemScope>
  );
}

function ComplexityForm({ config }: { config: ComplexityConfig }) {
  const [drafts, setDrafts] = useState<Draft[]>(() => config.factors.map(toDraft));
  const [standard, setStandard] = useState(Math.round(config.thresholds.standard * 100));
  const [advanced, setAdvanced] = useState(Math.round(config.thresholds.advanced * 100));
  const save = useSaveComplexity();
  const toast = useToast();
  const announce = useAnnounce();

  const update = (index: number, change: Partial<Draft>) => setDrafts((all) => all.map((draft, i) => (i === index ? { ...draft, ...change } : draft)));
  const move = (index: number, by: -1 | 1) => {
    const target = index + by;
    setDrafts((all) => {
      const next = [...all];
      const [moved] = next.splice(index, 1);
      if (moved !== undefined) next.splice(target, 0, moved);
      return next;
    });
    announce(`${drafts[index]?.label || 'Factor'} moved to position ${target + 1} of ${drafts.length}`, 'polite');
  };
  const remove = (index: number) => {
    announce(`${drafts[index]?.label || 'Factor'} removed`, 'polite');
    setDrafts((all) => all.filter((_, i) => i !== index));
  };

  const ordered = standard < advanced;
  const weighted = drafts.some((draft) => draft.weight > 0);

  return (
    <Form
      label="Complexity settings"
      onSubmit={async () => {
        await save.mutateAsync({ thresholds: { standard: standard / 100, advanced: advanced / 100 }, factors: drafts.map(toFactor) });
        toast({ message: 'Complexity settings saved', severity: 'success' });
      }}
    >
      <AiSection title="Levels" description="Conversations scoring at or above a threshold use that level's model. Most conversations should stay Fast.">
        <Thresholds standard={standard} advanced={advanced} onStandard={setStandard} onAdvanced={setAdvanced} />
      </AiSection>

      <AiSection title="Factors" description="What makes a conversation complex for your team. Weights set how much each factor counts.">
        <FactorsIssue />
        {drafts.length === 0 && <EmptyState title="No factors" message="Without factors every conversation uses the Fast model." headingLevel={3} />}
        <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {drafts.map((draft, index) => (
            <FactorCard
              key={draft.uid}
              draft={draft}
              index={index}
              count={drafts.length}
              onChange={(change) => update(index, change)}
              onMove={(by) => move(index, by)}
              onRemove={() => remove(index)}
            />
          ))}
        </Box>
        <Box sx={{ mt: 4 }}>
          <Button variant="outlined" disabled={drafts.length >= MAX_FACTORS} onClick={() => setDrafts((all) => [...all, newDraft()])}>
            Add factor
          </Button>
          {drafts.length >= MAX_FACTORS && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              You can have up to {MAX_FACTORS} factors.
            </Typography>
          )}
        </Box>
      </AiSection>

      {!weighted && drafts.length > 0 && <Alert severity="warning">Give at least one factor a weight above 0.</Alert>}
      <FormError />
      <Box>
        <SubmitButton disabled={!ordered || (!weighted && drafts.length > 0) || drafts.length === 0}>Save complexity settings</SubmitButton>
      </Box>
    </Form>
  );
}

function FactorsIssue() {
  const issue = useFormIssue('factors');
  return issue === undefined ? null : (
    <Alert severity="error" sx={{ mb: 4 }}>
      {issue}
    </Alert>
  );
}

function Thresholds({ standard, advanced, onStandard, onAdvanced }: { standard: number; advanced: number; onStandard: (value: number) => void; onAdvanced: (value: number) => void }) {
  const ordered = standard < advanced;
  const orderId = useId();
  const serverIssue = useFormIssue('thresholds.advanced');
  const bands = [
    { level: 'Fast', from: 0, to: standard, color: 'success.light' },
    { level: 'Standard', from: standard, to: advanced, color: 'warning.light' },
    { level: 'Advanced', from: advanced, to: 100, color: 'error.light' },
  ];
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <LabelledSlider label="Standard from" value={standard} onChange={onStandard} />
      <LabelledSlider label="Advanced from" value={advanced} onChange={onAdvanced} describedBy={ordered && serverIssue === undefined ? undefined : orderId} />
      {(!ordered || serverIssue !== undefined) && (
        <Typography id={orderId} variant="body2" color="error.main" role="alert">
          {serverIssue ?? 'The Advanced threshold must be higher than the Standard one.'}
        </Typography>
      )}
      <Box aria-hidden="true" sx={{ display: 'flex', height: 12, borderRadius: 9999, overflow: 'hidden', border: 1, borderColor: 'divider' }}>
        {bands.map((band) => (
          <Box key={band.level} sx={{ width: `${Math.max(0, band.to - band.from)}%`, bgcolor: band.color }} />
        ))}
      </Box>
      <Box component="ul" aria-label="Levels by score" sx={{ m: 0, pl: 5, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        {ordered ? (
          bands.map((band) => (
            <Typography key={band.level} component="li" variant="body2">
              <strong>{band.level}</strong>: score {band.from === 0 ? 'below' : `from ${band.from}%`}
              {band.from === 0 ? ` ${band.to}%` : band.to === 100 ? ' up' : ` to below ${band.to}%`}
            </Typography>
          ))
        ) : (
          <Typography component="li" variant="body2">
            Fix the thresholds to see the levels.
          </Typography>
        )}
      </Box>
    </Box>
  );
}

function LabelledSlider({ label, value, onChange, describedBy }: { label: string; value: number; onChange: (value: number) => void; describedBy?: string }) {
  const labelId = useId();
  return (
    <Box sx={{ maxWidth: 480 }}>
      <Typography id={labelId} sx={{ fontWeight: 600 }}>
        {label}: {value}%
      </Typography>
      <Slider
        value={value}
        min={1}
        max={99}
        step={1}
        onChange={(_event, next) => onChange(next)}
        valueLabelDisplay="auto"
        valueLabelFormat={(next) => `${next}%`}
        slotProps={{ input: { 'aria-labelledby': labelId, 'aria-valuetext': `${value}%`, ...(describedBy === undefined ? {} : { 'aria-describedby': describedBy }) } }}
      />
    </Box>
  );
}

interface FactorCardProps {
  draft: Draft;
  index: number;
  count: number;
  onChange: (change: Partial<Draft>) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}

function FactorCard({ draft, index, count, onChange, onMove, onRemove }: FactorCardProps) {
  const headingId = useId();
  const weightId = useId();
  const weightIssueId = useId();
  const path = `factors.${index}`;
  const weightIssue = useFormIssue(`${path}.weight`);
  const name = draft.label.trim() === '' ? `Factor ${index + 1}` : draft.label.trim();
  const kind = KINDS.find((entry) => entry.value === draft.kind);

  return (
    <Box component="li" aria-labelledby={headingId} sx={{ p: 4, border: 1, borderColor: 'divider', borderRadius: 2, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
        <Typography id={headingId} component="h3" variant="h6">
          {name}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button size="small" onClick={() => onMove(-1)} disabled={index === 0} aria-label={`Move ${name} up`}>
            Up
          </Button>
          <Button size="small" onClick={() => onMove(1)} disabled={index === count - 1} aria-label={`Move ${name} down`}>
            Down
          </Button>
          <Button size="small" color="error" onClick={onRemove} aria-label={`Remove ${name}`}>
            Remove
          </Button>
        </Box>
      </Box>

      <FormField
        name={`${path}.label`}
        label="Name"
        value={draft.label}
        required
        onChange={(event) => onChange({ label: event.target.value, ...(draft.keyTouched ? {} : { key: keyFromLabel(event.target.value) }) })}
        slotProps={{ htmlInput: { maxLength: 80 } }}
      />
      <FormField
        name={`${path}.key`}
        label="Key"
        value={draft.key}
        required
        helperText="Lowercase letters, digits and underscores. Used in usage reports."
        onChange={(event) => onChange({ key: event.target.value, keyTouched: true })}
        slotProps={{ htmlInput: { maxLength: 40, spellCheck: false } }}
      />
      <FormField
        select
        name={`${path}.kind`}
        label="Type"
        value={draft.kind}
        helperText={kind?.help}
        onChange={(event) => {
          const next = event.target.value as ComplexityFactorKind;
          onChange({
            kind: next,
            ...(next === 'choice' && draft.options.length < 2
              ? {
                  options: [
                    { key: 'low', description: '', value: 0 },
                    { key: 'high', description: '', value: 1 },
                  ],
                }
              : {}),
            ...(next === 'score' && draft.levels.length < 2 ? { levels: ['', '', ''] } : {}),
          });
        }}
      >
        {KINDS.map((entry) => (
          <MenuItem key={entry.value} value={entry.value}>
            {entry.label}
          </MenuItem>
        ))}
      </FormField>

      <Box sx={{ maxWidth: 420 }}>
        <Typography id={weightId} sx={{ fontWeight: 600 }}>
          Weight: {draft.weight}
        </Typography>
        <Slider
          value={draft.weight}
          min={0}
          max={10}
          step={0.5}
          marks={[
            { value: 0, label: '0' },
            { value: 10, label: '10' },
          ]}
          onChange={(_event, next) => onChange({ weight: next })}
          valueLabelDisplay="auto"
          slotProps={{ input: { 'aria-labelledby': weightId, ...(weightIssue === undefined ? {} : { 'aria-describedby': weightIssueId }) } }}
        />
        {weightIssue !== undefined && (
          <Typography id={weightIssueId} variant="body2" color="error.main">
            {weightIssue}
          </Typography>
        )}
      </Box>

      {(draft.kind === 'noul' || draft.kind === 'choice' || draft.kind === 'score') && (
        <FormField
          name={`${path}.instructions`}
          label="Question for the AI"
          value={draft.instructions}
          required
          multiline
          minRows={2}
          onChange={(event) => onChange({ instructions: event.target.value })}
          slotProps={{ htmlInput: { maxLength: 500 } }}
        />
      )}
      {draft.kind === 'noul' && (
        <>
          <FormField name={`${path}.criteria.true`} label="Yes means" value={draft.yes} required onChange={(event) => onChange({ yes: event.target.value })} slotProps={{ htmlInput: { maxLength: 200 } }} />
          <FormField name={`${path}.criteria.false`} label="No means" value={draft.no} required onChange={(event) => onChange({ no: event.target.value })} slotProps={{ htmlInput: { maxLength: 200 } }} />
        </>
      )}
      {draft.kind === 'choice' && <ChoiceOptions path={path} name={name} options={draft.options} onChange={(options) => onChange({ options })} />}
      {draft.kind === 'score' && <ScoreLevels path={path} name={name} levels={draft.levels} onChange={(levels) => onChange({ levels })} />}
      {draft.kind === 'customer_tag' && <TagSelect path={path} value={draft.tagId} onChange={(tagId) => onChange({ tagId })} />}
    </Box>
  );
}

function ChoiceOptions({ path, name, options, onChange }: { path: string; name: string; options: Draft['options']; onChange: (options: Draft['options']) => void }) {
  const issue = useFormIssue(`${path}.options`);
  const set = (index: number, change: Partial<Draft['options'][number]>) => onChange(options.map((option, i) => (i === index ? { ...option, ...change } : option)));
  return (
    <Box component="fieldset" sx={{ border: 0, m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Typography component="legend" sx={{ fontWeight: 600, mb: 2 }}>
        Options for {name}
      </Typography>
      {issue !== undefined && <Alert severity="error">{issue}</Alert>}
      {options.map((option, index) => (
        <Box key={index} sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 2fr 120px auto' }, gap: 2, alignItems: 'start' }}>
          <FormField name={`${path}.options.${index}.key`} label={`Option ${index + 1} key`} value={option.key} onChange={(event) => set(index, { key: event.target.value })} slotProps={{ htmlInput: { maxLength: 40 } }} />
          <FormField name={`${path}.options.${index}.description`} label={`Option ${index + 1} description`} value={option.description} onChange={(event) => set(index, { description: event.target.value })} slotProps={{ htmlInput: { maxLength: 200 } }} />
          <FormField
            name={`${path}.options.${index}.value`}
            label={`Option ${index + 1} value`}
            type="number"
            value={option.value}
            onChange={(event) => set(index, { value: Math.min(1, Math.max(0, Number(event.target.value))) })}
            slotProps={{ htmlInput: { min: 0, max: 1, step: 0.1 } }}
          />
          <Button onClick={() => onChange(options.filter((_, i) => i !== index))} disabled={options.length <= 2} aria-label={`Remove option ${index + 1}`}>
            Remove
          </Button>
        </Box>
      ))}
      <Box>
        <Button variant="outlined" size="small" onClick={() => onChange([...options, { key: `option_${options.length + 1}`, description: '', value: 0.5 }])} disabled={options.length >= 8}>
          Add option
        </Button>
      </Box>
    </Box>
  );
}

function ScoreLevels({ path, name, levels, onChange }: { path: string; name: string; levels: string[]; onChange: (levels: string[]) => void }) {
  const issue = useFormIssue(`${path}.levels`);
  return (
    <Box component="fieldset" sx={{ border: 0, m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Typography component="legend" sx={{ fontWeight: 600, mb: 2 }}>
        Levels for {name}, lowest first
      </Typography>
      {issue !== undefined && <Alert severity="error">{issue}</Alert>}
      {levels.map((level, index) => (
        <Box key={index} sx={{ display: 'flex', gap: 2, alignItems: 'start' }}>
          <FormField
            name={`${path}.levels.${index}`}
            label={`Level ${index + 1}`}
            value={level}
            onChange={(event) => onChange(levels.map((entry, i) => (i === index ? event.target.value : entry)))}
            slotProps={{ htmlInput: { maxLength: 80 } }}
          />
          <Button onClick={() => onChange(levels.filter((_, i) => i !== index))} disabled={levels.length <= 2} aria-label={`Remove level ${index + 1}`}>
            Remove
          </Button>
        </Box>
      ))}
      <Box>
        <Button variant="outlined" size="small" onClick={() => onChange([...levels, ''])} disabled={levels.length >= 7}>
          Add level
        </Button>
      </Box>
    </Box>
  );
}

function TagSelect({ path, value, onChange }: { path: string; value: string; onChange: (tagId: string) => void }) {
  const tags = useTags();
  if (tags.isError) return <Alert severity="error">Couldn&apos;t load tags. {tags.error?.message}</Alert>;
  return (
    <FormField select name={`${path}.tagId`} label="Tag" value={tags.data === undefined ? '' : value} required disabled={tags.isPending} onChange={(event) => onChange(event.target.value)}>
      {(tags.data ?? []).map((tag) => (
        <MenuItem key={tag.id} value={tag.id}>
          {tag.name}
        </MenuItem>
      ))}
    </FormField>
  );
}
