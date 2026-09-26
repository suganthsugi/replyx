import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';

import { EmptyState } from '../../../components/foundations/EmptyState';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { useViews } from '../../../data/views';

/**
 * The workspace's saved views (docs/design-system "Workspace Inbox" rail): the tenant's default
 * and shared views, each with a live count. US8's T170 adds notification badges to this file.
 */

export interface ViewRailProps {
  activeViewId: string | undefined;
  onSelectView: (viewId: string) => void;
}

export function ViewRail({ activeViewId, onSelectView }: ViewRailProps) {
  const views = useViews();

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

  const visible = (views.data ?? []).filter((view) => !view.hidden).sort((a, b) => a.position - b.position);

  return (
    <Box component="nav" aria-label="Views" sx={{ display: 'flex', flexDirection: 'column', gap: 1, p: 3, overflowY: 'auto', height: '100%' }}>
      <Typography component="h2" variant="h3" sx={{ px: 1, pb: 1 }}>
        Views
      </Typography>
      {visible.length === 0 ? (
        <EmptyState title="No views yet" message="Views will appear here once they're set up." headingLevel={3} />
      ) : (
        <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          {visible.map((view) => {
            const active = view.id === activeViewId;
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
                  {view.count > 0 && <Chip size="small" label={view.count} sx={{ height: 18, fontSize: '0.6875rem', fontWeight: 600 }} />}
                </Box>
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
