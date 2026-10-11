import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useId, useState, type FormEvent } from 'react';

/**
 * The optional satisfaction rating after support wraps up (spec US16 scenario 1, FR-087): five
 * score chips, an optional comment once a score is picked, and Skip. Nothing here names a ticket
 * (constitution XI). The chips are a labelled radio group, so keyboard and screen reader users
 * pick a score like any other choice.
 */

export interface RatingPromptProps {
  /** Rejects with a user-facing message when saving fails. */
  onRate: (score: number, comment: string) => Promise<void>;
  onSkip: () => Promise<void>;
}

const SCORES: readonly { score: number; label: string }[] = [
  { score: 1, label: 'Very poor' },
  { score: 2, label: 'Poor' },
  { score: 3, label: 'Okay' },
  { score: 4, label: 'Good' },
  { score: 5, label: 'Great' },
];

const MAX_COMMENT = 1000;

export function RatingPrompt({ onRate, onSkip }: RatingPromptProps) {
  const headingId = useId();
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong. Please try again.');
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (score !== null) void run(() => onRate(score, comment.trim()));
  };

  return (
    <Box
      component="form"
      aria-labelledby={headingId}
      onSubmit={submit}
      sx={{ mx: 4, mb: 3, p: 3, borderRadius: '12px', border: 1, borderColor: 'divider', bgcolor: 'background.default' }}
    >
      <Typography id={headingId} component="h2" variant="body2" sx={{ fontWeight: 600, mb: 2 }}>
        How did we do?
      </Typography>
      <Box role="radiogroup" aria-labelledby={headingId} sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
        {SCORES.map((option) => (
          <Chip
            key={option.score}
            role="radio"
            aria-checked={score === option.score}
            label={`${option.score} · ${option.label}`}
            color={score === option.score ? 'primary' : 'default'}
            variant={score === option.score ? 'filled' : 'outlined'}
            onClick={() => setScore(option.score)}
            disabled={busy}
          />
        ))}
      </Box>
      {score !== null && (
        <TextField
          label="Anything to add? (optional)"
          value={comment}
          onChange={(event) => setComment(event.target.value.slice(0, MAX_COMMENT))}
          multiline
          minRows={2}
          fullWidth
          size="small"
          disabled={busy}
          sx={{ mt: 3 }}
        />
      )}
      {error !== null && (
        <Typography role="alert" variant="caption" color="error.main" component="p" sx={{ mt: 2 }}>
          {error}
        </Typography>
      )}
      <Box sx={{ display: 'flex', gap: 2, mt: 3 }}>
        <Button type="submit" variant="contained" size="small" disabled={score === null || busy}>
          Send rating
        </Button>
        <Button type="button" size="small" onClick={() => void run(onSkip)} disabled={busy}>
          Skip
        </Button>
      </Box>
    </Box>
  );
}
