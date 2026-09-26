import Box from '@mui/material/Box';
import { keyframes } from '@mui/material/styles';
import Typography from '@mui/material/Typography';

import type { TypingIndicator } from './types';

const bounce = keyframes`
  0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
  40% { transform: translateY(-4px); opacity: 1; }
`;

/** "Ann is typing" with three bouncing dots; the dots hold still under reduced motion. */
export function TypingDots({ typing }: { typing: TypingIndicator }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, my: 1 }}>
      <Typography variant="caption" color="text.secondary">
        {typing.name} is typing
      </Typography>
      <Box aria-hidden="true" sx={{ display: 'flex', gap: 0.75 }}>
        {[0, 1, 2].map((index) => (
          <Box
            key={index}
            component="span"
            sx={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              bgcolor: 'text.secondary',
              animation: `${bounce} 1.2s ${index * 0.15}s infinite ease-in-out`,
              '@media (prefers-reduced-motion: reduce)': { animation: 'none', opacity: 0.7 },
            }}
          />
        ))}
      </Box>
    </Box>
  );
}
