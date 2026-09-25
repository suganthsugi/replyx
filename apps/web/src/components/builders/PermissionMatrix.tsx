import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { useRef, useState } from 'react';

import type { KeyboardEvent } from 'react';

/**
 * The groups × actions matrix of a role (FR-022, FR-023): one row for Ungrouped and one per
 * group, columns View / Create / Edit / Delete. It is an ARIA grid with one tab stop: arrow keys
 * move between cells, Home/End jump within a row, Space toggles the focused cell.
 *
 * View is the gate: granting any other action grants View too, and removing View clears the
 * row, because the policy ignores flags on a group the role cannot view. `locked` (the Admin
 * role, FR-019) shows the grants read-only.
 */

export type MatrixAction = 'view' | 'create' | 'edit' | 'delete';

export interface MatrixEntry {
  /** `null` is Ungrouped. */
  groupId: string | null;
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
}

export interface MatrixGroup {
  id: string;
  name: string;
  status?: 'active' | 'inactive';
}

export interface PermissionMatrixProps {
  groups: readonly MatrixGroup[];
  value: readonly MatrixEntry[];
  onChange?: (next: MatrixEntry[]) => void;
  locked?: boolean;
  /** Accessible name of the grid, e.g. "Group access for Support Agent". */
  label: string;
}

export const MATRIX_ACTIONS: readonly { key: MatrixAction; label: string }[] = [
  { key: 'view', label: 'View' },
  { key: 'create', label: 'Create' },
  { key: 'edit', label: 'Edit' },
  { key: 'delete', label: 'Delete' },
];

const NONE = { view: false, create: false, edit: false, delete: false };

/** The entry for `groupId` after toggling `action`, applying the View rule. */
export function toggleEntry(entry: MatrixEntry, action: MatrixAction): MatrixEntry {
  const on = !entry[action];
  if (action === 'view') return on ? { ...entry, view: true } : { ...entry, ...NONE };
  return { ...entry, [action]: on, view: on ? true : entry.view };
}

export function PermissionMatrix({ groups, value, onChange, locked = false, label }: PermissionMatrixProps) {
  const rows: { id: string | null; name: string; inactive: boolean }[] = [
    { id: null, name: 'Ungrouped', inactive: false },
    ...groups.map((group) => ({ id: group.id, name: group.name, inactive: group.status === 'inactive' })),
  ];
  const byGroup = new Map(value.map((entry) => [entry.groupId, entry]));
  const entryOf = (groupId: string | null): MatrixEntry => byGroup.get(groupId) ?? { groupId, ...NONE };

  const [active, setActive] = useState<[number, number]>([0, 0]);
  const cells = useRef(new Map<string, HTMLInputElement>());
  const rowCount = rows.length;
  const colCount = MATRIX_ACTIONS.length;
  const [activeRow, activeCol] = [Math.min(active[0], rowCount - 1), Math.min(active[1], colCount - 1)];

  const focusCell = (row: number, col: number) => {
    setActive([row, col]);
    cells.current.get(`${row}:${col}`)?.focus();
  };

  const toggle = (groupId: string | null, action: MatrixAction) => {
    if (locked || onChange === undefined) return;
    const next = toggleEntry(entryOf(groupId), action);
    const others = value.filter((entry) => entry.groupId !== groupId);
    onChange([...others, next].filter((entry) => entry.view || entry.create || entry.edit || entry.delete));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, [number, number]> = {
      ArrowUp: [Math.max(activeRow - 1, 0), activeCol],
      ArrowDown: [Math.min(activeRow + 1, rowCount - 1), activeCol],
      ArrowLeft: [activeRow, Math.max(activeCol - 1, 0)],
      ArrowRight: [activeRow, Math.min(activeCol + 1, colCount - 1)],
      Home: [activeRow, 0],
      End: [activeRow, colCount - 1],
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    focusCell(move[0], move[1]);
  };

  return (
    <Box
      role="grid"
      aria-label={label}
      aria-readonly={locked || undefined}
      onKeyDown={onKeyDown}
      sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, bgcolor: 'background.paper', overflowX: 'auto' }}
    >
      <Box role="row" sx={rowSx}>
        <Box role="columnheader" sx={{ ...headerSx, textAlign: 'left' }}>
          Group
        </Box>
        {MATRIX_ACTIONS.map((action) => (
          <Box key={action.key} role="columnheader" sx={headerSx}>
            {action.label}
          </Box>
        ))}
      </Box>
      {rows.map((row, rowIndex) => {
        const entry = entryOf(row.id);
        return (
          <Box key={row.id ?? 'ungrouped'} role="row" sx={{ ...rowSx, borderTop: 1, borderColor: 'divider' }}>
            <Box role="rowheader" sx={{ px: 3.5, py: 2.5, display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {row.name}
              </Typography>
              {row.id === null && (
                <Typography variant="caption" color="text.secondary">
                  tickets in no group
                </Typography>
              )}
              {row.inactive && <Chip size="small" label="Inactive" />}
            </Box>
            {MATRIX_ACTIONS.map((action, colIndex) => (
              <Box key={action.key} role="gridcell" sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                <Checkbox
                  checked={entry[action.key]}
                  disabled={locked}
                  onChange={() => toggle(row.id, action.key)}
                  onFocus={() => setActive([rowIndex, colIndex])}
                  slotProps={{
                    input: {
                      ref: (node: HTMLInputElement | null) => {
                        const key = `${rowIndex}:${colIndex}`;
                        if (node === null) cells.current.delete(key);
                        else cells.current.set(key, node);
                      },
                      tabIndex: rowIndex === activeRow && colIndex === activeCol ? 0 : -1,
                      'aria-label': `${action.label} tickets in ${row.name}`,
                    },
                  }}
                />
              </Box>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}

const rowSx = {
  display: 'grid',
  gridTemplateColumns: 'minmax(160px, 1fr) repeat(4, minmax(64px, 88px))',
  alignItems: 'center',
} as const;

const headerSx = {
  px: 3.5,
  py: 2.5,
  textAlign: 'center',
  typography: 'overline',
  color: 'text.secondary',
} as const;
