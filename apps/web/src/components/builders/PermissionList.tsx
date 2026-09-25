import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import Typography from '@mui/material/Typography';

/**
 * A role's registry permissions (FR-017, FR-018), grouped by module. Keys the product added
 * since the viewer last looked carry a "New" badge (`newKeys`). Ticket permissions also need
 * group access in the matrix below them (FR-023), which the list says next to them. `locked`
 * (the Admin role) shows the grants read-only.
 */

export interface ListPermission {
  key: string;
  module: string;
  description: string;
  groupScoped: boolean;
}

export interface PermissionListProps {
  permissions: readonly ListPermission[];
  value: ReadonlySet<string>;
  onChange?: (next: Set<string>) => void;
  locked?: boolean;
  newKeys?: ReadonlySet<string>;
}

const MODULE_LABELS: Record<string, string> = {
  audit: 'Audit log',
  authorization: 'Roles',
  groups: 'Groups',
  identity: 'Users',
  integrations: 'Webhooks',
  messaging: 'Macros',
  routing: 'Routing and automation',
  sla: 'SLA and reporting',
  tags: 'Tags',
  tenancy: 'Workspace settings',
  tickets: 'Tickets',
  views: 'Views',
};

export function moduleLabel(module: string): string {
  return MODULE_LABELS[module] ?? module.charAt(0).toUpperCase() + module.slice(1).replace(/_/g, ' ');
}

export function PermissionList({ permissions, value, onChange, locked = false, newKeys }: PermissionListProps) {
  const modules = new Map<string, ListPermission[]>();
  // Tickets first: it is the module every role is about; the rest keep the registry's order.
  for (const permission of [...permissions].sort((a, b) => Number(b.module === 'tickets') - Number(a.module === 'tickets'))) {
    modules.set(permission.module, [...(modules.get(permission.module) ?? []), permission]);
  }

  const toggle = (key: string) => {
    if (locked || onChange === undefined) return;
    const next = new Set(value);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };

  return (
    <Box sx={{ display: 'grid', gap: 4, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
      {[...modules].map(([module, entries]) => {
        const headingId = `permission-module-${module}`;
        return (
          <Box
            key={module}
            component="fieldset"
            aria-labelledby={headingId}
            disabled={locked}
            sx={{ m: 0, p: 4, border: 1, borderColor: 'divider', borderRadius: 1.5, bgcolor: 'background.paper', minWidth: 0 }}
          >
            <Typography id={headingId} component="legend" variant="overline" color="text.secondary" sx={{ px: 0, mb: 1 }}>
              {moduleLabel(module)}
            </Typography>
            {entries.map((permission) => (
              <Box key={permission.key} sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                <FormControlLabel
                  sx={{ mr: 0 }}
                  control={<Checkbox size="small" checked={value.has(permission.key)} onChange={() => toggle(permission.key)} />}
                  label={<Typography variant="body2">{permission.description}</Typography>}
                />
                {permission.groupScoped && (
                  <Typography variant="caption" color="text.secondary">
                    needs group access
                  </Typography>
                )}
                {newKeys?.has(permission.key) === true && <Chip size="small" color="primary" variant="outlined" label="New" />}
              </Box>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
