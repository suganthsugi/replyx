import Box from '@mui/material/Box';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

import { visuallyHiddenStyle } from './VisuallyHidden';

/**
 * Screen-reader announcements for live changes (new messages, typing, notifications, errors):
 * FR-071a, SC-013a, ui-components rule 3. One provider per area (customer chat, workspace)
 * renders a polite and an assertive region that survive route changes; components call
 * `useAnnounce()` instead of rendering their own `aria-live` elements. The regions use plain
 * `aria-live` (no status/alert role) so they don't collide with components' own roles.
 */

export type Politeness = 'polite' | 'assertive';

type Announce = (message: string, politeness?: Politeness) => void;

const LiveRegionContext = createContext<Announce | undefined>(undefined);

interface Announcement {
  text: string;
  /** Changes on every announcement so repeating the same text is announced again. */
  id: number;
}

export function LiveRegionProvider({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState<Announcement>({ text: '', id: 0 });
  const [assertive, setAssertive] = useState<Announcement>({ text: '', id: 0 });
  const counter = useRef(0);

  const announce = useCallback<Announce>((message, politeness = 'polite') => {
    counter.current += 1;
    const next = { text: message, id: counter.current };
    if (politeness === 'assertive') setAssertive(next);
    else setPolite(next);
  }, []);

  return (
    <LiveRegionContext.Provider value={announce}>
      {children}
      <Box aria-live="polite" aria-atomic="true" sx={visuallyHiddenStyle}>
        <span key={polite.id}>{polite.text}</span>
      </Box>
      <Box aria-live="assertive" aria-atomic="true" sx={visuallyHiddenStyle}>
        <span key={assertive.id}>{assertive.text}</span>
      </Box>
    </LiveRegionContext.Provider>
  );
}

/** `announce(message, 'polite' | 'assertive')`; throws outside a `LiveRegionProvider`. */
export function useAnnounce(): Announce {
  const announce = useContext(LiveRegionContext);
  if (announce === undefined) throw new Error('useAnnounce must be used inside a LiveRegionProvider');
  return useMemo(() => announce, [announce]);
}
