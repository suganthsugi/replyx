import { useDashboard } from '../../../data/dashboard';

import { DashboardView } from './DashboardView';

/**
 * The dashboard (US12, FR-086): the container. `useDashboard` owns freshness (polling and the
 * tickets stream), this only maps its state onto `DashboardView`.
 */
export default function DashboardPage() {
  const query = useDashboard();
  const status = query.isPending ? 'pending' : query.isError ? 'error' : 'ready';
  return (
    <DashboardView
      status={status}
      errorMessage={query.error?.message}
      onRetry={() => void query.refetch()}
      data={query.data}
      updatedAt={query.dataUpdatedAt > 0 ? query.dataUpdatedAt : undefined}
    />
  );
}
