import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useEffect, useRef, useState } from 'react';

import { EmptyState } from '../../../components/foundations/EmptyState';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { TagInput } from '../../../components/inputs/TagInput';
import { Drawer } from '../../../components/shell/Drawer';
import { Form, FormError, FormField, SubmitButton } from '../../../components/shell/Form';
import { useToast } from '../../../components/shell/Toast';
import { PriorityMark } from '../../../components/tickets/PriorityMark';
import { StatePill } from '../../../components/tickets/StatePill';
import { useMe } from '../../../data/auth';
import { useCustomer, useUpdateCustomer } from '../../../data/customers';
import { useCreateTag, useTags } from '../../../data/tags';
import { type TicketSummary } from '../../../data/tickets';

import type { CustomerProfile } from '../../../data/customers';
import type { TagRef } from '../../../data/tags';
import type { RefObject } from 'react';

/**
 * The customer profile sheet (FR-069): contact details and tags (editable with `user.edit`), and
 * the customer's open and closed tickets. Opens from an inbox row or a ticket's customer summary.
 */

export interface CustomerDrawerProps {
  customerId: string | null;
  open: boolean;
  onClose: () => void;
  onOpenTicket: (ticketId: string) => void;
}

const STATUS_LABEL: Record<CustomerProfile['status'], string> = {
  invited: 'Invited',
  active: 'Active',
  deactivated: 'Deactivated',
};

export function CustomerDrawer({ customerId, open, onClose, onOpenTicket }: CustomerDrawerProps) {
  const query = useCustomer(customerId ?? undefined);

  return (
    <Drawer open={open} onClose={onClose} title={query.data?.name ?? 'Customer'} width={420}>
      {customerId === null ? (
        <EmptyState title="No customer selected" />
      ) : query.isPending ? (
        <Skeleton variant="block" label="customer" />
      ) : query.isError ? (
        <EmptyState
          variant="error"
          title="Couldn't load this customer"
          message={query.error?.message}
          onRetry={() => void query.refetch()}
        />
      ) : query.data === undefined ? null : (
        <CustomerDrawerBody customer={query.data} onOpenTicket={onOpenTicket} />
      )}
    </Drawer>
  );
}

function CustomerDrawerBody({ customer, onOpenTicket }: { customer: CustomerProfile; onOpenTicket: (ticketId: string) => void }) {
  const permissions = new Set(useMe().data?.permissions ?? []);
  const [editing, setEditing] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const nameFieldRef = useRef<HTMLInputElement>(null);
  const hasMountedRef = useRef(false);

  // The two modes unmount each other's focused control (the "Edit" button, the first field), so
  // move focus explicitly instead of letting it fall through to <body>. Skip the very first
  // mount, when nothing has "returned" yet.
  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    if (editing) {
      nameFieldRef.current?.focus();
    } else {
      editButtonRef.current?.focus();
    }
  }, [editing]);

  return (
    <Stack spacing={5}>
      {editing ? (
        <CustomerEditForm customer={customer} permissions={permissions} nameFieldRef={nameFieldRef} onDone={() => setEditing(false)} />
      ) : (
        <CustomerSummary
          customer={customer}
          canEdit={permissions.has('user.edit')}
          editButtonRef={editButtonRef}
          onEdit={() => setEditing(true)}
        />
      )}
      <Divider />
      <TicketSection title="Open tickets" tickets={customer.openTickets} onOpenTicket={onOpenTicket} emptyMessage="No open tickets." />
      <TicketSection title="Closed tickets" tickets={customer.closedTickets} onOpenTicket={onOpenTicket} emptyMessage="No closed tickets." />
    </Stack>
  );
}

function CustomerSummary({
  customer,
  canEdit,
  editButtonRef,
  onEdit,
}: {
  customer: CustomerProfile;
  canEdit: boolean;
  editButtonRef: RefObject<HTMLButtonElement | null>;
  onEdit: () => void;
}) {
  return (
    <Stack spacing={3}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2 }}>
        <Stack spacing={0.5}>
          <Typography variant="body2" color="text.secondary">
            {customer.email}
          </Typography>
          <Chip
            size="small"
            label={STATUS_LABEL[customer.status]}
            sx={{
              alignSelf: 'flex-start',
              ...(customer.status === 'active' ? { bgcolor: 'success.light', color: 'success.main' } : {}),
            }}
          />
        </Stack>
        {canEdit && (
          <Button ref={editButtonRef} size="small" onClick={onEdit}>
            Edit
          </Button>
        )}
      </Box>
      <Stack spacing={2}>
        <Field label="Phone" value={customer.phone} />
        <Field label="Company" value={customer.company} />
      </Stack>
      <Stack spacing={1}>
        <SectionLabel>Tags</SectionLabel>
        {customer.tags.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No tags
          </Typography>
        ) : (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {customer.tags.map((tag) => (
              <Chip key={tag.id} size="small" label={tag.name} />
            ))}
          </Box>
        )}
      </Stack>
    </Stack>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <Box>
      <SectionLabel>{label}</SectionLabel>
      <Typography variant="body2">{value ?? 'Not set'}</Typography>
    </Box>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>
      {children}
    </Typography>
  );
}

function CustomerEditForm({
  customer,
  permissions,
  nameFieldRef,
  onDone,
}: {
  customer: CustomerProfile;
  permissions: Set<string>;
  nameFieldRef: RefObject<HTMLInputElement | null>;
  onDone: () => void;
}) {
  const updateCustomer = useUpdateCustomer();
  const createTag = useCreateTag();
  const tagsQuery = useTags();
  const toast = useToast();

  const [name, setName] = useState(customer.name);
  const [phone, setPhone] = useState(customer.phone ?? '');
  const [company, setCompany] = useState(customer.company ?? '');
  const [tags, setTags] = useState<TagRef[]>(customer.tags);

  const tagOptions = tagsQuery.data ?? [];

  return (
    <Form
      label={`Edit ${customer.name}`}
      onSubmit={async () => {
        await updateCustomer.mutateAsync({
          id: customer.id,
          name: name.trim(),
          phone: phone.trim(),
          company: company.trim(),
          tagIds: tags.map((tag) => tag.id),
        });
        toast({ message: 'Customer saved', severity: 'success' });
        onDone();
      }}
    >
      <FormField
        name="name"
        label="Name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
        inputRef={nameFieldRef}
        slotProps={{ htmlInput: { maxLength: 120 } }}
      />
      <FormField name="phone" label="Phone" value={phone} onChange={(event) => setPhone(event.target.value)} slotProps={{ htmlInput: { maxLength: 40 } }} />
      <FormField
        name="company"
        label="Company"
        value={company}
        onChange={(event) => setCompany(event.target.value)}
        slotProps={{ htmlInput: { maxLength: 120 } }}
      />
      <TagInput
        value={tags}
        options={tagOptions}
        onChange={setTags}
        onCreateTag={
          permissions.has('tag.create')
            ? (createdName) => {
                void createTag.mutateAsync({ name: createdName }).then((created) => setTags((current) => [...current, created]));
              }
            : undefined
        }
      />
      <FormError />
      <Box sx={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
        <Button onClick={onDone}>Cancel</Button>
        <SubmitButton>Save</SubmitButton>
      </Box>
    </Form>
  );
}

function TicketSection({
  title,
  tickets,
  onOpenTicket,
  emptyMessage,
}: {
  title: string;
  tickets: TicketSummary[];
  onOpenTicket: (ticketId: string) => void;
  emptyMessage: string;
}) {
  return (
    <Stack spacing={2}>
      <Typography component="h3" variant="subtitle2" sx={{ textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>
        {title}
      </Typography>
      {tickets.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {emptyMessage}
        </Typography>
      ) : (
        <List disablePadding>
          {tickets.map((ticket) => (
            <ListItemButton
              key={ticket.id}
              onClick={() => onOpenTicket(ticket.id)}
              sx={{
                borderRadius: 1.5,
                mb: 1,
                border: 1,
                borderColor: 'divider',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'stretch',
                gap: 1,
                py: 1.5,
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                <StatePill state={ticket.state} />
                <Typography variant="caption" color="text.secondary">
                  #{ticket.number}
                </Typography>
              </Box>
              <Typography variant="body2" sx={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {ticket.title}
              </Typography>
              <PriorityMark priority={ticket.priority} />
            </ListItemButton>
          ))}
        </List>
      )}
    </Stack>
  );
}
