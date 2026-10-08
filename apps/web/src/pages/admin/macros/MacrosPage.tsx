import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { useMemo, useRef, useState } from 'react';

import { EmptyState } from '../../../components/foundations/EmptyState';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { macroEffects } from '../../../components/inputs/MessageComposer';
import { ConfirmationDialog } from '../../../components/shell/ConfirmationDialog';
import { DesignSystemScope } from '../../../components/shell/DesignSystemScope';
import { useToast } from '../../../components/shell/Toast';
import { useMe } from '../../../data/auth';
import { useGroups } from '../../../data/groups';
import { useCreateMacro, useDeleteMacro, useMacros, useUpdateMacro, type Macro, type MacroInput } from '../../../data/macros';
import { useRoles } from '../../../data/roles';
import { useTags } from '../../../data/tags';

import { MacroEditorDrawer } from './MacroEditorDrawer';

/**
 * Macros (US14, FR-068): canned replies with optional ticket changes, shared with everyone, some
 * roles or some groups. Lists the macros the person can see; add, edit and delete follow their
 * `macro.*` permissions (the API also lets a creator manage their own). Agents use macros from
 * the composer with `/`.
 */

const VISIBILITY_LABELS: Record<string, string> = {
  all_staff: 'Everyone',
  roles: 'Some roles',
  groups: 'Some groups',
};

export default function MacrosPage() {
  const macrosQuery = useMacros();
  const roles = useRoles();
  const groups = useGroups();
  const tags = useTags();
  const createMacro = useCreateMacro();
  const updateMacro = useUpdateMacro();
  const deleteMacro = useDeleteMacro();
  const held = new Set(useMe().data?.permissions ?? []);
  const toast = useToast();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Macro | undefined>();
  const [deleting, setDeleting] = useState<Macro | null>(null);

  const roleOptions = useMemo(() => (roles.data ?? []).filter((role) => role.system !== 'customer').map((role) => ({ id: role.id, name: role.name })), [roles.data]);
  const groupOptions = useMemo(() => (groups.data ?? []).map((group) => ({ id: group.id, name: group.name })), [groups.data]);
  const tagOptions = useMemo(() => (tags.data ?? []).map((tag) => ({ id: tag.id, name: tag.name })), [tags.data]);

  const canCreate = held.has('macro.create');
  const canEdit = held.has('macro.edit');
  const canDelete = held.has('macro.delete');

  const openEditor = (macro?: Macro) => {
    setEditing(macro);
    setEditorOpen(true);
  };

  const save = async (input: MacroInput, id?: string) => {
    if (id === undefined) await createMacro.mutateAsync(input);
    else await updateMacro.mutateAsync({ id, ...input });
    toast({ message: id === undefined ? `${input.name} added` : `${input.name} saved`, severity: 'success' });
  };

  const macros = macrosQuery.data ?? [];

  return (
    <DesignSystemScope>
      <Box component="main" sx={{ px: { xs: 4, sm: 8 }, py: 6, maxWidth: 1040 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, flexWrap: 'wrap', mb: 2 }}>
          <Typography component="h1" variant="h1" ref={headingRef} tabIndex={-1} sx={{ outline: 'none' }}>
            Macros
          </Typography>
          {canCreate && macrosQuery.isSuccess && (
            <Button variant="contained" onClick={() => openEditor()}>
              Add macro
            </Button>
          )}
        </Box>
        <Typography color="text.secondary" sx={{ mb: 6, maxWidth: 680 }}>
          A macro is a saved reply that can also change the ticket, such as setting it to resolved or adding a tag. Agents insert one by
          typing / in the reply box.
        </Typography>

        {macrosQuery.isPending && <Skeleton variant="list" rows={4} label="macros" />}

        {macrosQuery.isError && (
          <EmptyState variant="error" title="Couldn't load macros" message={macrosQuery.error?.message} onRetry={() => void macrosQuery.refetch()} />
        )}

        {macrosQuery.isSuccess &&
          (macros.length === 0 ? (
            <EmptyState
              title="No macros yet"
              message="Save the replies your team sends most often, so they take one action."
              action={canCreate ? { label: 'Add macro', onClick: () => openEditor() } : undefined}
            />
          ) : (
            <Box component="ul" aria-label="Macros" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {macros.map((macro) => {
                const effects = macroEffects(macro);
                return (
                  <Box
                    component="li"
                    key={macro.id}
                    sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', p: 3, border: 1, borderColor: 'divider', borderRadius: 3, bgcolor: 'background.paper' }}
                  >
                    <Box sx={{ flex: 1, minWidth: 220 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                        <Typography component="h2" variant="body1" sx={{ fontWeight: 600 }}>
                          {macro.name}
                        </Typography>
                        <Chip size="small" label={VISIBILITY_LABELS[macro.visibility] ?? macro.visibility} />
                      </Box>
                      {macro.body !== '' && (
                        <Typography variant="body2" color="text.secondary" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {macro.body}
                        </Typography>
                      )}
                      {effects.length > 0 && (
                        <Typography variant="body2" color="text.secondary">
                          Also: {effects.join(', ')}
                        </Typography>
                      )}
                    </Box>
                    {canEdit && (
                      <Button size="small" onClick={() => openEditor(macro)} aria-label={`Edit ${macro.name}`}>
                        Edit
                      </Button>
                    )}
                    {canDelete && (
                      <Button size="small" color="error" onClick={() => setDeleting(macro)} aria-label={`Delete ${macro.name}`}>
                        Delete
                      </Button>
                    )}
                  </Box>
                );
              })}
            </Box>
          ))}

        <MacroEditorDrawer
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
          macro={editing}
          roles={roleOptions}
          groups={groupOptions}
          tags={tagOptions}
          onSave={save}
        />

        {deleting !== null && (
          <ConfirmationDialog
            open
            title={`Delete ${deleting.name}`}
            message="The macro is removed for everyone it was shared with. Replies already sent with it stay as they are."
            confirmLabel="Delete macro"
            destructive
            onClose={() => setDeleting(null)}
            onConfirm={async () => {
              await deleteMacro.mutateAsync({ id: deleting.id });
              toast({ message: `${deleting.name} deleted`, severity: 'success' });
              window.setTimeout(() => headingRef.current?.focus(), 0);
            }}
          />
        )}
      </Box>
    </DesignSystemScope>
  );
}
