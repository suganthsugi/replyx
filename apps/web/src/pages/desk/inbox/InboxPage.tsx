import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router';

import { EmptyState } from '../../../components/foundations/EmptyState';
import { useAnnounce } from '../../../components/foundations/LiveRegion';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { VisuallyHidden } from '../../../components/foundations/VisuallyHidden';
import { Drawer } from '../../../components/shell/Drawer';
import { useToast } from '../../../components/shell/Toast';
import { BulkActionBar } from '../../../components/tickets/BulkActionBar';
import { TicketList } from '../../../components/tickets/TicketList';
import { useMe } from '../../../data/auth';
import { BULK_LIMIT, mapTicketActionError, ticketActionMessage, useBulkUpdateTickets, type BulkChanges } from '../../../data/merge-split';
import { useTickets } from '../../../data/tickets';
import { useViews } from '../../../data/views';
import { WORKSPACE_BASE } from '../../../routes/area';

import { ViewRail } from './ViewRail';

import type { TicketSummary } from '../../../data/tickets';

const MOBILE_QUERY = '(max-width:1023.95px)';

// These three panels (a full ticket, the new-ticket form and the customer profile sheet) are most
// of this route's own code; their own chunks keep picking a view or scanning a list light until
// one of them is actually opened. Each is mounted only once it's been opened the first time (and
// then stays mounted, per `NewTicketDialog`'s and `CustomerDrawer`'s own "stays mounted while
// closed" contract) so the dynamic import fires on demand, not on every visit to the inbox.
const TicketFocus = lazy(() => import('./TicketFocus').then((module) => ({ default: module.TicketFocus })));
const NewTicketDialog = lazy(() => import('./NewTicketDialog').then((module) => ({ default: module.NewTicketDialog })));
const CustomerDrawer = lazy(() => import('../customers/CustomerDrawer').then((module) => ({ default: module.CustomerDrawer })));

/**
 * The workspace inbox (docs/design-system "Workspace Inbox"): the view rail, the ticket list for
 * the active view, and the focus pane, at `/desk/inbox/:viewId?/:ticketId?`. Below 1024 px it
 * shows one pane at a time. Opens `CustomerDrawer` from a ticket's customer and `NewTicketDialog`
 * from "New ticket" — both render as descendants of `DeskLayout`'s `DesignSystemScope`.
 */
export default function InboxPage() {
  const params = useParams<{ viewId?: string; ticketId?: string }>();
  const navigate = useNavigate();
  // `?ticket=` comes from desktop and email notifications, which don't know the agent's views.
  const [searchParams] = useSearchParams();
  const isMobile = useMediaQuery(MOBILE_QUERY);

  const views = useViews();
  const [railOpen, setRailOpen] = useState(false);
  const [newTicketOpen, setNewTicketOpen] = useState(false);
  const [newTicketEverOpened, setNewTicketEverOpened] = useState(false);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerEverOpened, setCustomerEverOpened] = useState(false);

  const focusPaneRef = useRef<HTMLDivElement>(null);
  const listPaneRef = useRef<HTMLDivElement>(null);
  const previousTicketId = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (params.ticketId !== previousTicketId.current) {
      if (params.ticketId !== undefined) focusPaneRef.current?.focus();
      else listPaneRef.current?.focus();
      previousTicketId.current = params.ticketId;
    }
  }, [params.ticketId]);

  if (views.isPending) {
    return (
      <Box component="main" sx={{ p: 4 }}>
        <VisuallyHidden component="h1">Inbox</VisuallyHidden>
        <Skeleton variant="list" rows={6} label="views" />
      </Box>
    );
  }

  if (views.isError) {
    return (
      <Box component="main" sx={{ p: 4 }}>
        <VisuallyHidden component="h1">Inbox</VisuallyHidden>
        <EmptyState variant="error" title="Couldn't load the inbox" message={views.error?.message} onRetry={() => void views.refetch()} headingLevel={2} />
      </Box>
    );
  }

  const visibleViews = (views.data ?? []).filter((view) => !view.hidden).sort((a, b) => a.position - b.position);

  if (params.viewId === undefined) {
    const first = visibleViews[0];
    if (first === undefined) {
      return (
        <Box component="main" sx={{ p: 4 }}>
          <VisuallyHidden component="h1">Inbox</VisuallyHidden>
          <EmptyState title="No views yet" message="Views will appear here once they're set up." headingLevel={2} />
        </Box>
      );
    }
    const linkedTicket = searchParams.get('ticket');
    return <Navigate to={`${WORKSPACE_BASE}/inbox/${first.id}${linkedTicket === null ? '' : `/${encodeURIComponent(linkedTicket)}`}`} replace />;
  }

  const activeView = visibleViews.find((view) => view.id === params.viewId);
  const ticketId = params.ticketId;

  const openNewTicket = () => {
    setNewTicketEverOpened(true);
    setNewTicketOpen(true);
  };
  const openCustomer = (id: string) => {
    setCustomerEverOpened(true);
    setCustomerId(id);
  };

  return (
    <Box component="main" id="desk-main" sx={{ height: '100%', minHeight: 0 }}>
      <VisuallyHidden component="h1">Inbox</VisuallyHidden>
      {isMobile ? (
        <MobileInbox
          viewId={params.viewId}
          viewName={activeView?.name ?? 'View'}
          ticketId={ticketId}
          onSelectTicket={(ticket) => void navigate(`${WORKSPACE_BASE}/inbox/${params.viewId}/${ticket.id}`)}
          onBackToList={() => void navigate(`${WORKSPACE_BASE}/inbox/${params.viewId}`)}
          onOpenRail={() => setRailOpen(true)}
          onNewTicket={openNewTicket}
          onOpenCustomer={openCustomer}
          focusPaneRef={focusPaneRef}
          listPaneRef={listPaneRef}
        />
      ) : (
        <DesktopInbox
          viewId={params.viewId}
          viewName={activeView?.name ?? 'View'}
          ticketId={ticketId}
          onSelectTicket={(ticket) => void navigate(`${WORKSPACE_BASE}/inbox/${params.viewId}/${ticket.id}`)}
          onCloseTicket={() => void navigate(`${WORKSPACE_BASE}/inbox/${params.viewId}`)}
          onSelectView={(viewId) => void navigate(`${WORKSPACE_BASE}/inbox/${viewId}`)}
          onNewTicket={openNewTicket}
          onOpenCustomer={openCustomer}
          focusPaneRef={focusPaneRef}
          listPaneRef={listPaneRef}
        />
      )}

      {isMobile && (
        <Drawer open={railOpen} onClose={() => setRailOpen(false)} title="Views" anchor="left" width={260}>
          <ViewRail
            activeViewId={params.viewId}
            onSelectView={(viewId) => {
              setRailOpen(false);
              void navigate(`${WORKSPACE_BASE}/inbox/${viewId}`);
            }}
          />
        </Drawer>
      )}

      {newTicketEverOpened && (
        <Suspense fallback={null}>
          <NewTicketDialog
            open={newTicketOpen}
            onClose={() => setNewTicketOpen(false)}
            onCreated={(createdId) => void navigate(`${WORKSPACE_BASE}/inbox/${params.viewId}/${createdId}`)}
          />
        </Suspense>
      )}
      {customerEverOpened && (
        <Suspense fallback={null}>
          <CustomerDrawer
            customerId={customerId}
            open={customerId !== null}
            onClose={() => setCustomerId(null)}
            onOpenTicket={(openTicketId) => {
              setCustomerId(null);
              void navigate(`${WORKSPACE_BASE}/inbox/${params.viewId}/${openTicketId}`);
            }}
          />
        </Suspense>
      )}
    </Box>
  );
}

interface PaneProps {
  viewId: string;
  viewName: string;
  ticketId: string | undefined;
  onSelectTicket: (ticket: TicketSummary) => void;
  onOpenCustomer: (customerId: string) => void;
  focusPaneRef: React.RefObject<HTMLDivElement | null>;
  listPaneRef: React.RefObject<HTMLDivElement | null>;
}

function DesktopInbox({
  viewId,
  viewName,
  ticketId,
  onSelectTicket,
  onCloseTicket,
  onSelectView,
  onNewTicket,
  onOpenCustomer,
  focusPaneRef,
  listPaneRef,
}: PaneProps & { onCloseTicket: () => void; onSelectView: (viewId: string) => void; onNewTicket: () => void }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '200px 320px 1fr', height: '100%', minHeight: 0 }}>
      <Box component="aside" sx={{ borderRight: 1, borderColor: 'divider', minHeight: 0, overflow: 'hidden' }}>
        <ViewRail activeViewId={viewId} onSelectView={onSelectView} />
      </Box>
      <Box
        ref={listPaneRef}
        tabIndex={-1}
        sx={{ display: 'flex', flexDirection: 'column', borderRight: 1, borderColor: 'divider', minHeight: 0, outline: 'none' }}
      >
        <TicketListPane viewId={viewId} viewName={viewName} ticketId={ticketId} onSelectTicket={onSelectTicket} onNewTicket={onNewTicket} />
      </Box>
      <Box ref={focusPaneRef} tabIndex={-1} sx={{ minHeight: 0, outline: 'none', bgcolor: 'background.default' }}>
        {ticketId === undefined ? (
          <EmptyState title="Select a ticket" message="Pick a ticket from the list to see its conversation." headingLevel={2} />
        ) : (
          <Suspense fallback={<Skeleton variant="block" label="the ticket" />}>
            <TicketFocus key={ticketId} ticketId={ticketId} onClose={onCloseTicket} onOpenCustomer={onOpenCustomer} />
          </Suspense>
        )}
      </Box>
    </Box>
  );
}

function MobileInbox({
  viewId,
  viewName,
  ticketId,
  onSelectTicket,
  onBackToList,
  onOpenRail,
  onNewTicket,
  onOpenCustomer,
  focusPaneRef,
  listPaneRef,
}: PaneProps & { onBackToList: () => void; onOpenRail: () => void; onNewTicket: () => void }) {
  if (ticketId !== undefined) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <Button onClick={onBackToList} sx={{ alignSelf: 'flex-start', m: 1 }}>
          ← Back to list
        </Button>
        <Box ref={focusPaneRef} tabIndex={-1} sx={{ flex: 1, minHeight: 0, outline: 'none' }}>
          <Suspense fallback={<Skeleton variant="block" label="the ticket" />}>
            <TicketFocus key={ticketId} ticketId={ticketId} onClose={onBackToList} onOpenCustomer={onOpenCustomer} />
          </Suspense>
        </Box>
      </Box>
    );
  }
  return (
    <Box ref={listPaneRef} tabIndex={-1} sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, outline: 'none' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', px: 3, py: 2 }}>
        <Button onClick={onOpenRail}>Views</Button>
        <Button variant="contained" size="small" onClick={onNewTicket}>
          New ticket
        </Button>
      </Box>
      <TicketListPane viewId={viewId} viewName={viewName} ticketId={ticketId} onSelectTicket={onSelectTicket} onNewTicket={onNewTicket} hideNewTicketButton />
    </Box>
  );
}

function TicketListPane({
  viewId,
  viewName,
  ticketId,
  onSelectTicket,
  onNewTicket,
  hideNewTicketButton = false,
}: {
  viewId: string;
  viewName: string;
  ticketId: string | undefined;
  onSelectTicket: (ticket: TicketSummary) => void;
  onNewTicket: () => void;
  hideNewTicketButton?: boolean;
}) {
  const tickets = useTickets({ viewId });
  const me = useMe();
  const bulk = useBulkUpdateTickets();
  const toast = useToast();
  const announce = useAnnounce();
  const canBulk = me.data?.permissions.includes('ticket.bulk_update') === true;
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());

  // A view switch starts a fresh selection; tickets that left the list drop out of it.
  useEffect(() => setChecked(new Set()), [viewId]);
  const visibleIds = useMemo(() => new Set(tickets.items.map((ticket) => ticket.id)), [tickets.items]);
  const checkedVisible = useMemo(() => new Set([...checked].filter((id) => visibleIds.has(id))), [checked, visibleIds]);

  const toggle = (ticket: TicketSummary) => {
    const next = new Set(checkedVisible);
    if (next.has(ticket.id)) {
      next.delete(ticket.id);
      announce(`#${ticket.number} unselected, ${next.size} selected`, 'polite');
    } else if (next.size >= BULK_LIMIT) {
      announce(`You can select up to ${BULK_LIMIT} tickets at a time`, 'assertive');
      return;
    } else {
      next.add(ticket.id);
      announce(`#${ticket.number} selected, ${next.size} selected`, 'polite');
    }
    setChecked(next);
  };

  const apply = async (changes: BulkChanges) => {
    let results;
    try {
      results = await bulk.mutateAsync([...checkedVisible], changes);
    } catch (error) {
      toast({ message: mapTicketActionError(error).message, severity: 'error' });
      return;
    }
    const failed = results.filter((result) => !result.ok);
    const updated = results.length - failed.length;
    if (failed.length === 0) {
      toast({ message: `Updated ${updated} ticket${updated === 1 ? '' : 's'}`, severity: 'success' });
      setChecked(new Set());
      return;
    }
    const reasons = [...new Set(failed.map((result) => ticketActionMessage(result.errorCode ?? '')))].join(' ');
    toast({ message: `Updated ${updated} of ${results.length}. ${failed.length} not updated: ${reasons}`, severity: 'warning' });
    setChecked(new Set(failed.map((result) => result.ticketId)));
  };

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 3, py: 2.5, borderBottom: 1, borderColor: 'divider' }}>
        <Typography component="h2" variant="h3">
          {viewName}
        </Typography>
        {!hideNewTicketButton && (
          <Button size="small" variant="outlined" onClick={onNewTicket}>
            New ticket
          </Button>
        )}
      </Box>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        {tickets.isPending ? (
          <Box sx={{ p: 3 }}>
            <Skeleton variant="list" rows={6} label="tickets" />
          </Box>
        ) : tickets.isError ? (
          <EmptyState variant="error" title="Couldn't load tickets" message={tickets.error?.message} onRetry={() => void tickets.refetch()} />
        ) : (
          <TicketList
            tickets={tickets.items}
            label={`Tickets in ${viewName}`}
            selectedId={ticketId}
            onOpenTicket={onSelectTicket}
            {...(canBulk ? { checkedIds: checkedVisible, onToggleChecked: toggle } : {})}
          />
        )}
      </Box>
      {/* Below the list, so the rows don't shift under the pointer when the bar appears. */}
      {canBulk && checkedVisible.size > 0 && (
        <BulkActionBar
          count={checkedVisible.size}
          busy={bulk.isPending}
          onApply={(changes) => void apply(changes)}
          onAssignToMe={me.data === undefined ? undefined : () => void apply({ ownerId: me.data.id })}
          onClear={() => setChecked(new Set())}
        />
      )}
    </>
  );
}
