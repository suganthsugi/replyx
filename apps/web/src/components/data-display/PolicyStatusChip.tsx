import Chip from '@mui/material/Chip';

/**
 * A policy document's (or one of its versions') processing status as a soft pill. The label carries
 * the meaning, not just the color. `active` is a version's "ready"; `superseded` is a replaced version.
 */

export type PolicyChipStatus = 'processing' | 'ready' | 'active' | 'failed' | 'superseded';

const META: Record<PolicyChipStatus, { label: string; tone: 'info' | 'success' | 'error' | 'neutral' }> = {
  processing: { label: 'Processing', tone: 'info' },
  ready: { label: 'Ready', tone: 'success' },
  active: { label: 'Ready', tone: 'success' },
  failed: { label: 'Failed', tone: 'error' },
  superseded: { label: 'Replaced', tone: 'neutral' },
};

export function PolicyStatusChip({ status }: { status: PolicyChipStatus }) {
  const { label, tone } = META[status];
  return (
    <Chip
      size="small"
      label={label}
      sx={{
        height: 22,
        fontSize: '0.6875rem',
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.03em',
        bgcolor: tone === 'neutral' ? 'action.hover' : `${tone}.light`,
        color: tone === 'neutral' ? 'text.secondary' : `${tone}.dark`,
      }}
    />
  );
}
