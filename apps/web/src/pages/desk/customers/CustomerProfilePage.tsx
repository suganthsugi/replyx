import { useNavigate, useParams } from 'react-router';

import { useCustomer, useCustomerHistory } from '../../../data/customers';
import { WORKSPACE_BASE } from '../../../routes/area';

import { CustomerProfileView } from './CustomerProfileView';

/** `/desk/customers/:id` (US16, T251): the container for `CustomerProfileView`. */
export default function CustomerProfilePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const customer = useCustomer(id);
  const history = useCustomerHistory(id);

  const status = customer.isPending ? 'pending' : customer.isError ? 'error' : 'ready';
  const historyStatus = history.isPending ? 'pending' : history.isError ? 'error' : 'ready';

  return (
    <CustomerProfileView
      status={status}
      errorMessage={customer.error?.message}
      onRetry={() => void customer.refetch()}
      customer={customer.data}
      history={{
        status: historyStatus,
        errorMessage: history.error?.message,
        items: history.data ?? [],
        hasMore: history.hasNextPage,
        loadingMore: history.isFetchingNextPage,
        onLoadMore: () => void history.fetchNextPage(),
        onRetry: () => void history.refetch(),
      }}
      onOpenTicket={(ticketId) => void navigate(`${WORKSPACE_BASE}/inbox?ticket=${encodeURIComponent(ticketId)}`)}
    />
  );
}
