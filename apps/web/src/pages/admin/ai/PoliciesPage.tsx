import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { useEffect, useRef, useState } from 'react';

import { PolicyStatusChip } from '../../../components/data-display/PolicyStatusChip';
import { EmptyState } from '../../../components/foundations/EmptyState';
import { AddIcon } from '../../../components/foundations/icons';
import { useAnnounce } from '../../../components/foundations/LiveRegion';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { ConfirmationDialog } from '../../../components/shell/ConfirmationDialog';
import { DesignSystemScope } from '../../../components/shell/DesignSystemScope';
import { useToast } from '../../../components/shell/Toast';
import { policyErrorMessage, useDeletePolicyDocument, usePolicyDocuments, usePolicyEvents, type PolicyDocument, type PolicyStatus } from '../../../data/ai/policies';
import { useRealtime } from '../../../data/realtime';

import { PolicyEditor, RenamePolicyDialog } from './PolicyEditor';

/**
 * Policy documents (specs/002-ai-assist US2, FR-006 to FR-009), behind `ai_knowledge.manage`: the
 * return, refund and shipping policies the assistant answers from. Each row shows a
 * Processing/Ready/Failed chip that updates live, and the reason when a version failed. Add and
 * Edit open the editor dialog; Rename and Delete (confirmed) act on one row.
 */

type EditorState = { documentId?: string } | undefined;

const STATUS_WORDS: Readonly<Record<PolicyStatus, string>> = { processing: 'is processing', ready: 'is ready', failed: 'failed to process' };

const formatTime = (iso: string) => new Date(iso).toLocaleString();

function sourceText(policy: PolicyDocument): string {
  if (policy.source === 'file') return policy.fileName ?? 'Uploaded file';
  if (policy.source === 'text') return 'Typed text';
  return 'No content yet';
}

export default function PoliciesPage() {
  const query = usePolicyDocuments();
  usePolicyEvents(useRealtime());
  const deletePolicy = useDeletePolicyDocument();
  const announce = useAnnounce();
  const toast = useToast();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [editor, setEditor] = useState<EditorState>();
  const [renaming, setRenaming] = useState<PolicyDocument | undefined>();
  const [deleting, setDeleting] = useState<PolicyDocument | undefined>();

  // Say it when a policy changes status (not on first load).
  const seen = useRef<Map<string, PolicyStatus> | undefined>(undefined);
  const items = query.data?.items;
  useEffect(() => {
    if (items === undefined) return;
    const previous = seen.current;
    if (previous !== undefined) {
      for (const policy of items) {
        const before = previous.get(policy.id);
        if (before !== undefined && before !== policy.status) {
          announce(`${policy.title} ${STATUS_WORDS[policy.status]}`, policy.status === 'failed' ? 'assertive' : 'polite');
        }
      }
    }
    seen.current = new Map(items.map((policy) => [policy.id, policy.status]));
  }, [items, announce]);

  return (
    <DesignSystemScope>
      <Box component="main" sx={{ px: { xs: 4, sm: 8 }, py: 6, maxWidth: 880 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 4, flexWrap: 'wrap', mb: 2 }}>
          <Typography component="h1" variant="h1" tabIndex={-1} ref={headingRef} sx={{ outline: 'none' }}>
            Policies
          </Typography>
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditor({})}>
            Add policy
          </Button>
        </Box>
        <Typography color="text.secondary" sx={{ mb: 6, maxWidth: 680 }}>
          Add the return, refund and shipping policies the assistant answers from. Type the text or upload a file; a new version replaces the old one once it is ready.
        </Typography>

        {query.isPending && <Skeleton variant="list" rows={4} label="policies" />}
        {query.isError && <EmptyState variant="error" title="Couldn't load policies" message={query.error?.message} onRetry={() => void query.refetch()} />}
        {query.isSuccess && query.data.items.length === 0 && (
          <EmptyState
            title="No policies yet"
            message="Without a policy, the assistant has nothing to answer from and hands conversations to your team."
            action={{ label: 'Add policy', onClick: () => setEditor({}) }}
          />
        )}
        {query.isSuccess && query.data.items.length > 0 && (
          <Box component="ul" aria-label="Policies" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {query.data.items.map((policy) => (
              <PolicyRow
                key={policy.id}
                policy={policy}
                onEdit={() => setEditor({ documentId: policy.id })}
                onRename={() => setRenaming(policy)}
                onDelete={() => setDeleting(policy)}
              />
            ))}
          </Box>
        )}

        {editor !== undefined && <PolicyEditor key={editor.documentId ?? 'new'} documentId={editor.documentId} onClose={() => setEditor(undefined)} />}
        {renaming !== undefined && <RenamePolicyDialog document={renaming} onClose={() => setRenaming(undefined)} />}
        <ConfirmationDialog
          open={deleting !== undefined}
          title={`Delete ${deleting?.title ?? 'policy'}?`}
          message="The assistant stops answering from this policy. This can't be undone."
          confirmLabel="Delete policy"
          destructive
          onClose={() => setDeleting(undefined)}
          onConfirm={async () => {
            if (deleting === undefined) return;
            await deletePolicy.mutateAsync(deleting.id);
            toast({ message: `${deleting.title} deleted`, severity: 'success' });
            // The row (and the button that opened the dialog) is gone: land on the page heading.
            setTimeout(() => headingRef.current?.focus(), 0);
          }}
        />
      </Box>
    </DesignSystemScope>
  );
}

interface PolicyRowProps {
  policy: PolicyDocument;
  onEdit: () => void;
  onRename: () => void;
  onDelete: () => void;
}

function PolicyRow({ policy, onEdit, onRename, onDelete }: PolicyRowProps) {
  return (
    <Box component="li" sx={{ p: 4, border: 1, borderColor: 'divider', borderRadius: 3, bgcolor: 'background.paper' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
        <Typography component="h2" variant="body1" sx={{ fontWeight: 600, wordBreak: 'break-word' }}>
          {policy.title}
        </Typography>
        <PolicyStatusChip status={policy.status} />
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
        {sourceText(policy)} · Updated {formatTime(policy.updatedAt)}
        {policy.activeSince != null && ` · Answering since ${formatTime(policy.activeSince)}`}
      </Typography>
      {(policy.error != null || policy.status === 'failed') && (
        <Alert severity={policy.status === 'failed' ? 'error' : 'warning'} role="note" aria-label={`Problem with ${policy.title}`} sx={{ mt: 3 }}>
          {policy.status === 'failed'
            ? policyErrorMessage(policy.error)
            : `Your latest change wasn't applied: ${policyErrorMessage(policy.error)} The previous version is still in use.`}
        </Alert>
      )}
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 3 }}>
        <Button size="small" variant="outlined" onClick={onEdit} aria-label={`Edit ${policy.title}`}>
          Edit
        </Button>
        <Button size="small" onClick={onRename} aria-label={`Rename ${policy.title}`}>
          Rename
        </Button>
        <Button size="small" color="error" onClick={onDelete} aria-label={`Delete ${policy.title}`}>
          Delete
        </Button>
      </Box>
    </Box>
  );
}
