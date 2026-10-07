import Box from '@mui/material/Box';

import { splitHighlight } from '../../data/search';

/**
 * A search snippet with its matched words in `<mark>` (FR-070). The server sends plain text with
 * marker characters, never HTML, so every segment is rendered as a React text node.
 */

export interface SearchHighlightProps {
  highlight: string | undefined | null;
}

export function SearchHighlight({ highlight }: SearchHighlightProps) {
  const segments = splitHighlight(highlight);
  if (segments.length === 0) return null;
  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? (
          <Box
            key={index}
            component="mark"
            sx={{ bgcolor: 'action.selected', color: 'text.primary', fontWeight: 600, borderRadius: 0.5, px: 0.25 }}
          >
            {segment.text}
          </Box>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}
