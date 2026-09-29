import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { useEffect, useRef } from 'react';

import { useAnnounce } from '../../../components/foundations/LiveRegion';
import { AA_NORMAL_TEXT_CONTRAST, contrastRatio } from '../../../theme/brand-accent';

import type { Theme } from '@mui/material/styles';

/**
 * A small mock of the customer chat in the chosen primary color (docs/design-system "Customer
 * Chat"): a support bubble, the customer's own bubble and the send button. The color fills the
 * bubble and button and is read against white text (FR-071a), so the ratio and a pass/fail
 * chip sit under the mock. The mock itself is decoration and hidden from assistive technology;
 * the ratio text carries the information, and a change between pass and fail is announced.
 */

/** The API accepts six-digit hex colors only. */
export const PRIMARY_HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;
const WHITE = '#ffffff';

/** Chat bubbles use the design system's shell radius (twice the control radius) with a tight tail corner. */
const bubbleRadius = (theme: Theme) => Number(theme.shape.borderRadius) * 2;
const tailRadius = (theme: Theme) => Number(theme.shape.borderRadius) / 2;

export interface BrandPreviewProps {
  /** The color in the field; anything that isn't a six-digit hex is shown in the theme's own color. */
  color: string;
  welcomeMessage: string;
  tenantName: string;
}

export type ContrastStatus = { valid: false } | { valid: true; ratio: number; passes: boolean };

export function contrastStatus(color: string): ContrastStatus {
  if (!PRIMARY_HEX_PATTERN.test(color)) return { valid: false };
  const ratio = contrastRatio(color, WHITE);
  return { valid: true, ratio, passes: ratio >= AA_NORMAL_TEXT_CONTRAST };
}

export function BrandPreview({ color, welcomeMessage, tenantName }: BrandPreviewProps) {
  const announce = useAnnounce();
  const status = contrastStatus(color);
  const verdict = status.valid ? (status.passes ? 'pass' : 'fail') : undefined;
  // The last usable verdict: a half-typed color in between doesn't count as a change.
  const previous = useRef<'pass' | 'fail' | undefined>(verdict);

  // Announce only when the verdict flips (pass to fail or back), not on every keystroke that keeps it.
  // A first verdict of "pass" needs no announcement; a first "fail" does.
  useEffect(() => {
    if (verdict === undefined || previous.current === verdict) return;
    const before = previous.current;
    previous.current = verdict;
    if (verdict === 'pass' && before !== undefined) announce('This color has enough contrast with white text.', 'polite');
    if (verdict === 'fail') announce('This color does not have enough contrast with white text.', 'polite');
  }, [verdict, announce]);

  // The tenant's own choice is shown as chosen (that is the point of a preview), so the fill is
  // data, not a theme token; an unusable value falls back to the theme's primary.
  const fill = status.valid ? color : 'primary.main';

  return (
    <Box>
      <Box
        aria-hidden="true"
        sx={{
          border: 1,
          borderColor: 'divider',
          borderRadius: bubbleRadius,
          bgcolor: 'background.default',
          p: 4,
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
        }}
      >
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          {tenantName.trim() === '' ? 'Support' : tenantName}
        </Typography>
        <Box
          sx={{
            alignSelf: 'flex-start',
            maxWidth: '80%',
            px: 3,
            py: 2,
            bgcolor: 'background.paper',
            border: 1,
            borderColor: 'divider',
            borderRadius: bubbleRadius,
            borderBottomLeftRadius: tailRadius,
          }}
        >
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            {welcomeMessage.trim() === '' ? 'Hi! How can we help?' : welcomeMessage}
          </Typography>
        </Box>
        <Box
          sx={{
            alignSelf: 'flex-end',
            maxWidth: '80%',
            px: 3,
            py: 2,
            bgcolor: fill,
            color: 'common.white',
            borderRadius: bubbleRadius,
            borderBottomRightRadius: tailRadius,
          }}
        >
          <Typography variant="body2">I need help with my order</Typography>
        </Box>
        {/* A non-interactive chip carries the theme's pill radius and button type. */}
        <Chip label="Send" sx={{ alignSelf: 'flex-end', bgcolor: fill, color: 'common.white' }} />
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', mt: 3 }}>
        {status.valid ? (
          <>
            <Chip size="small" color={status.passes ? 'success' : 'error'} label={status.passes ? 'Passes AA' : 'Fails AA'} />
            <Typography variant="caption" color="text.secondary">
              Contrast {status.ratio.toFixed(2)}:1 with white text (needs {AA_NORMAL_TEXT_CONTRAST}:1)
            </Typography>
          </>
        ) : (
          <Typography variant="caption" color="text.secondary">
            Enter a color like #1D4ED8 to check its contrast.
          </Typography>
        )}
      </Box>
    </Box>
  );
}
