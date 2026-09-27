import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { useState } from 'react';

import { EmptyState } from '../../../components/foundations/EmptyState';
import { useAnnounce } from '../../../components/foundations/LiveRegion';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { mapError } from '../../../data/errors';
import { useReorderViews, useViewCounts } from '../../../data/view-counts';
import { useViews } from '../../../data/views';

import type { View } from '../../../data/views';

/**
 * The workspace's saved views (docs/design-system "Workspace Inbox" rail): the tenant's default
 * and shared views, each with a live count (T170, `useViewCounts`, falling back to the view's own
 * `count` while that query is loading). "Arrange views" (T170) switches to a list of every view,
 * including hidden ones, with Move up/down and Show/Hide controls in place of drag-and-drop, so
 * reordering stays keyboard- and screen-reader-accessible; moves are saved through
 * `useReorderViews` and announced via `LiveRegion`.
 */

export interface ViewRailProps {
  activeViewId: string | undefined;
  onSelectView: (viewId: string) => void;
}

export function ViewRail({ activeViewId, onSelectView }: ViewRailProps) {
  const views = useViews();
  const counts = useViewCounts();
  const [arranging, setArranging] = useState(false);

  if (views.isPending) {
    return (
      <Box component="nav" aria-label="Views" sx={{ p: 3 }}>
        <Skeleton variant="list" rows={5} label="views" />
      </Box>
    );
  }

  if (views.isError) {
    return (
      <Box component="nav" aria-label="Views" sx={{ p: 3 }}>
        <EmptyState variant="error" title="Couldn't load views" message={views.error?.message} onRetry={() => void views.refetch()} headingLevel={2} />
      </Box>
    );
  }

  const allViews = (views.data ?? []).slice().sort((a, b) => a.position - b.position);
  const visible = allViews.filter((view) => !view.hidden);

  return (
    <Box component="nav" aria-label="Views" sx={{ display: 'flex', flexDirection: 'column', gap: 1, p: 3, overflowY: 'auto', height: '100%' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1, pb: 1 }}>
        <Typography component="h2" variant="h3">
          Views
        </Typography>
        <Button size="small" onClick={() => setArranging((value) => !value)} aria-pressed={arranging}>
          {arranging ? 'Done' : 'Arrange views'}
        </Button>
      </Box>

      {arranging ? (
        <ArrangeViewsList views={allViews} />
      ) : visible.length === 0 ? (
        <EmptyState title="No views yet" message="Views will appear here once they're set up." headingLevel={3} />
      ) : (
        <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          {visible.map((view) => {
            const active = view.id === activeViewId;
            const count = counts.data?.[view.id] ?? view.count;
            return (
              <Box component="li" key={view.id}>
                <Box
                  component="button"
                  type="button"
                  onClick={() => onSelectView(view.id)}
                  aria-current={active ? 'page' : undefined}
                  sx={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 2,
                    border: 0,
                    borderRadius: 2,
                    px: 3,
                    py: 2,
                    fontSize: '0.8125rem',
                    fontFamily: 'inherit',
                    fontWeight: active ? 700 : 500,
                    cursor: 'pointer',
                    textAlign: 'left',
                    color: active ? 'primary.main' : 'text.primary',
                    bgcolor: active ? 'action.selected' : 'transparent',
                    '&:hover': { bgcolor: active ? 'action.selected' : 'action.hover' },
                    '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 },
                  }}
                >
                  <span>{view.name}</span>
                  {count > 0 && <Chip size="small" label={count} sx={{ height: 18, fontSize: '0.6875rem', fontWeight: 600 }} />}
                </Box>
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

/**
 * `aria-disabled`, not `disabled`: a move can land a view at the top or bottom, which would disable
 * the very button that has focus and drop focus to the page. The handlers ignore these presses.
 */
const ARIA_DISABLED_SX = { '&[aria-disabled="true"]': { color: 'text.disabled', cursor: 'not-allowed' } } as const;

/** All views by position, each with keyboard-operable move and show/hide controls (no drag). */
function ArrangeViewsList({ views }: { views: readonly View[] }) {
  const reorder = useReorderViews();
  const announce = useAnnounce();

  // A swap moves both views, so the neighbor must be one the user may arrange too.
  const canMove = (index: number, direction: -1 | 1) => views[index]?.editable === true && views[index + direction]?.editable === true;

  // Buttons stay enabled while a save is in flight (disabling the focused one would drop focus);
  // a second press meanwhile is ignored instead.
  const save = async (items: { id: string; position: number; hidden: boolean }[], done: string) => {
    if (reorder.isPending) return;
    try {
      await reorder.mutateAsync({ items });
      announce(done);
    } catch (error) {
      announce(`Couldn't save the view order: ${mapError(error).message}`);
    }
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = views[index];
    const neighbor = views[index + direction];
    if (target === undefined || neighbor === undefined || !canMove(index, direction)) return;
    void save(
      [
        { id: target.id, position: neighbor.position, hidden: target.hidden },
        { id: neighbor.id, position: target.position, hidden: neighbor.hidden },
      ],
      `${target.name} moved ${direction === -1 ? 'up' : 'down'}`,
    );
  };

  const toggleHidden = (view: View) => {
    if (!view.editable) return;
    void save([{ id: view.id, position: view.position, hidden: !view.hidden }], `${view.name} ${view.hidden ? 'shown' : 'hidden'}`);
  };

  if (views.length === 0) {
    return <EmptyState title="No views yet" message="Views will appear here once they're set up." headingLevel={3} />;
  }

  return (
    <Box component="ul" aria-label="Arrange views" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
      {views.map((view, index) => (
        <Box
          component="li"
          key={view.id}
          sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 1.5, borderRadius: 2, border: 1, borderColor: 'divider' }}
        >
          <Typography variant="body2" sx={{ flex: 1, fontWeight: 500, }}>
            {view.name}
            {view.hidden && ' (hidden)'}
          </Typography>
          <Button
            size="small"
            aria-label={`Move ${view.name} up`}
            aria-disabled={!canMove(index, -1)}
            sx={ARIA_DISABLED_SX}
            onClick={() => move(index, -1)}
          >
            Move up
          </Button>
          <Button
            size="small"
            aria-label={`Move ${view.name} down`}
            aria-disabled={!canMove(index, 1)}
            sx={ARIA_DISABLED_SX}
            onClick={() => move(index, 1)}
          >
            Move down
          </Button>
          <Button
            size="small"
            variant="outlined"
            aria-label={`${view.hidden ? 'Show' : 'Hide'} ${view.name}`}
            aria-pressed={!view.hidden}
            aria-disabled={!view.editable}
            sx={ARIA_DISABLED_SX}
            onClick={() => toggleHidden(view)}
          >
            {view.hidden ? 'Show' : 'Hide'}
          </Button>
        </Box>
      ))}
    </Box>
  );
}
