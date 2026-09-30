import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { useEffect, useId, useRef } from 'react';

import { AddIcon, CloseIcon } from '../foundations/icons';
import { useAnnounce } from '../foundations/LiveRegion';

import { ConditionValueInput } from './ConditionValueInput';
import {
  FIELD_LABELS,
  MAX_GROUP_ITEMS,
  MAX_NESTING_DEPTH,
  MAX_TOTAL_CONDITIONS,
  OPERATOR_LABELS,
  availableFields,
  countConditions,
  describeCondition,
  errorPath,
  groupNumber,
  isConditionComplete,
  isGroup,
  newCondition,
  nextUnusedField,
  nodeAt,
  operatorsFor,
  pathKey,
  reconcileKeys,
  removeAt,
  removeKeyAt,
  replaceAt,
  withOperator,
  type FilterLookups,
  type KeyNode,
  type NodePath,
} from './filter-model';

import type { Condition, ConditionExpression, ConditionField, ConditionGroup, ConditionOperator } from '../../api/generated/model';

/**
 * The condition tree of a view (FR-075): a root AND/OR group of field / operator / value rows and
 * nested groups (up to 3 levels, 20 items per group, 20 conditions in total: the API's limits,
 * enforced by disabling the Add buttons). Fully keyboard operable, with no drag and drop: the
 * match mode is a two-button toggle, every row has a labelled Remove button, focus moves to a new
 * row or group and to a neighbour after a removal, and add/remove are announced.
 *
 * Presentational: `lookups` supplies the lists for the value pickers, and `errors` maps API
 * `details` paths (`conditions.items.1.operator`) to messages.
 */

export type { FilterLookups, LookupOption } from './filter-model';

export interface FilterBuilderProps {
  value: ConditionGroup;
  onChange: (next: ConditionGroup) => void;
  lookups: FilterLookups;
  disabled?: boolean;
  /** Messages by API `details` path, e.g. `{ 'conditions.items.1.operator': 'Choose one of the allowed values' }`. */
  errors?: Readonly<Record<string, string>>;
  /** The path of `value` inside the request body, the prefix of `errors` keys. Default `conditions`. */
  errorPathPrefix?: string;
  /** Marks conditions that still need a value ("Choose a value"), e.g. after a failed save attempt. */
  showIncomplete?: boolean;
  /** Accessible name of the whole builder. Default "Conditions". */
  label?: string;
}

type FocusRequest = { kind: 'node'; key: string } | { kind: 'add'; key: string };

interface BuilderContext {
  lookups: FilterLookups;
  disabled: boolean;
  errors: Readonly<Record<string, string>>;
  prefix: string;
  showIncomplete: boolean;
  total: number;
  idBase: string;
  onEdit: (path: NodePath, node: ConditionExpression) => void;
  onAddCondition: (path: NodePath) => void;
  onAddGroup: (path: NodePath) => void;
  onRemove: (path: NodePath) => void;
}

export function FilterBuilder({
  value,
  onChange,
  lookups,
  disabled = false,
  errors = {},
  errorPathPrefix = 'conditions',
  showIncomplete = false,
  label = 'Conditions',
}: FilterBuilderProps) {
  const announce = useAnnounce();
  const idBase = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const focusRequest = useRef<FocusRequest | null>(null);
  // Client-only row keys, parallel to `value` (see `reconcileKeys`); never sent to the API.
  const keyCounter = useRef(0);
  const keyTree = useRef<KeyNode | undefined>(undefined);
  const keys = reconcileKeys(value, keyTree.current, () => `k${keyCounter.current++}`);
  keyTree.current = keys;
  const total = countConditions(value);

  // Runs after every render: the request is set by a handler and served once the new row exists.
  useEffect(() => {
    const request = focusRequest.current;
    if (request === null) return;
    focusRequest.current = null;
    const selector =
      request.kind === 'add'
        ? `[data-add-for="${request.key}"]`
        : `[data-node="${request.key}"] :is([role="combobox"], button):not(:disabled)`;
    rootRef.current?.querySelector<HTMLElement>(selector)?.focus();
  });

  const groupAt = (path: NodePath): ConditionGroup | undefined => {
    const node = nodeAt(value, path);
    return node !== undefined && isGroup(node) ? node : undefined;
  };

  const context: BuilderContext = {
    lookups,
    disabled,
    errors,
    prefix: errorPathPrefix,
    showIncomplete,
    total,
    idBase,
    onEdit: (path, node) => onChange(replaceAt(value, path, node)),
    onAddCondition: (path) => {
      const group = groupAt(path);
      if (group === undefined) return;
      onChange(replaceAt(value, path, { ...group, items: [...group.items, newCondition(nextUnusedField(value, availableFields(lookups)))] }));
      focusRequest.current = { kind: 'node', key: pathKey([...path, group.items.length]) };
      announce(`Condition added. ${total + 1} ${total + 1 === 1 ? 'condition' : 'conditions'} in total.`);
    },
    onAddGroup: (path) => {
      const group = groupAt(path);
      if (group === undefined) return;
      const nested: ConditionGroup = { op: group.op === 'and' ? 'or' : 'and', items: [newCondition(nextUnusedField(value, availableFields(lookups)))] };
      onChange(replaceAt(value, path, { ...group, items: [...group.items, nested] }));
      focusRequest.current = { kind: 'node', key: pathKey([...path, group.items.length]) };
      announce(`Group added, matching ${nested.op === 'and' ? 'all' : 'any'} of its conditions. ${total + 1} conditions in total.`);
    },
    onRemove: (path) => {
      const parentPath = path.slice(0, -1);
      const index = path[path.length - 1];
      const parent = groupAt(parentPath);
      if (parent === undefined || index === undefined || parent.items.length <= 1) return;
      const removed = parent.items[index];
      const removedCount = removed === undefined ? 1 : countConditions(removed);
      keyTree.current = removeKeyAt(keys, path);
      onChange(removeAt(value, path));
      const remaining = parent.items.length - 1;
      focusRequest.current = { kind: 'node', key: pathKey([...parentPath, Math.min(index, remaining - 1)]) };
      const what = removed !== undefined && isGroup(removed) ? 'Group' : `Condition ${index + 1}`;
      announce(`${what} removed. ${total - removedCount} ${total - removedCount === 1 ? 'condition' : 'conditions'} left.`);
    },
  };

  return (
    <Box ref={rootRef} role="group" aria-label={label}>
      <GroupNode group={value} keys={keys} path={[]} depth={1} label="All conditions" ctx={context} />
    </Box>
  );
}

function GroupNode({
  group,
  keys,
  path,
  depth,
  label,
  ctx,
}: {
  group: ConditionGroup;
  keys: KeyNode;
  path: NodePath;
  depth: number;
  label: string;
  ctx: BuilderContext;
}) {
  const key = pathKey(path);
  const hintId = `${ctx.idBase}-${key}-hint`;
  const isRoot = path.length === 0;
  const atGroupLimit = group.items.length >= MAX_GROUP_ITEMS;
  const atTotalLimit = ctx.total >= MAX_TOTAL_CONDITIONS;
  const cannotNest = depth >= MAX_NESTING_DEPTH;
  const addDisabled = ctx.disabled || atGroupLimit || atTotalLimit;
  const groupError = ctx.errors[errorPath(ctx.prefix, path)];

  let hint: string | undefined;
  if (atTotalLimit) hint = `Limit reached: a view can have ${MAX_TOTAL_CONDITIONS} conditions in total.`;
  else if (atGroupLimit) hint = `Limit reached: a group can hold ${MAX_GROUP_ITEMS} items.`;
  else if (cannotNest) hint = `Groups can be nested ${MAX_NESTING_DEPTH} levels deep.`;

  return (
    <Box
      data-node={key}
      role={isRoot ? undefined : 'group'}
      aria-label={isRoot ? undefined : label}
      sx={
        isRoot
          ? { display: 'flex', flexDirection: 'column', gap: 3 }
          : { display: 'flex', flexDirection: 'column', gap: 3, p: 3, border: 1, borderColor: 'divider', borderRadius: 1.5, bgcolor: 'background.default' }
      }
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="subtitle2" component="span" id={`${ctx.idBase}-${key}-match`}>
          {isRoot ? 'Match' : `${label}: match`}
        </Typography>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={group.op}
          disabled={ctx.disabled}
          aria-labelledby={`${ctx.idBase}-${key}-match`}
          onChange={(_event, next: 'and' | 'or' | null) => {
            if (next !== null) ctx.onEdit(path, { ...group, op: next });
          }}
        >
          <ToggleButton value="and">All (AND)</ToggleButton>
          <ToggleButton value="or">Any (OR)</ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="body2" color="text.secondary" component="span">
          of the following
        </Typography>
      </Box>

      {groupError !== undefined && (
        <Typography variant="caption" color="error">
          {groupError}
        </Typography>
      )}

      <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {group.items.map((item, index) => {
          const itemPath = [...path, index];
          const onlyItem = group.items.length === 1;
          return (
            <Box component="li" key={keys.children[index]?.key ?? index} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {index > 0 && (
                <Typography aria-hidden="true" variant="overline" color="text.secondary" sx={{ pl: 1 }}>
                  {group.op === 'and' ? 'And' : 'Or'}
                </Typography>
              )}
              {isGroup(item) ? (
                <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <GroupNode
                      group={item}
                      keys={keys.children[index] ?? { key: String(index), children: [] }}
                      path={itemPath}
                      depth={depth + 1}
                      label={`Group ${groupNumber(itemPath)}`}
                      ctx={ctx}
                    />
                  </Box>
                  <IconButton
                    aria-label={`Remove group ${groupNumber(itemPath)}`}
                    disabled={ctx.disabled || onlyItem}
                    onClick={() => ctx.onRemove(itemPath)}
                    size="small"
                  >
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </Box>
              ) : (
                <ConditionRow condition={item} path={itemPath} number={index + 1} onlyItem={onlyItem} ctx={ctx} />
              )}
            </Box>
          );
        })}
      </Box>

      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button
          size="small"
          variant="outlined"
          startIcon={<AddIcon />}
          disabled={addDisabled}
          data-add-for={key}
          aria-describedby={hint === undefined ? undefined : hintId}
          onClick={() => ctx.onAddCondition(path)}
        >
          Add condition
        </Button>
        <Button
          size="small"
          variant="text"
          startIcon={<AddIcon />}
          disabled={addDisabled || cannotNest}
          aria-describedby={hint === undefined ? undefined : hintId}
          onClick={() => ctx.onAddGroup(path)}
        >
          Add group
        </Button>
        {hint !== undefined && (
          <Typography id={hintId} variant="caption" color="text.secondary">
            {hint}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

function ConditionRow({
  condition,
  path,
  number,
  onlyItem,
  ctx,
}: {
  condition: Condition;
  path: NodePath;
  number: number;
  onlyItem: boolean;
  ctx: BuilderContext;
}) {
  const key = pathKey(path);
  const base = errorPath(ctx.prefix, path);
  const errorStartingWith = (suffix: string): string | undefined => {
    const exact = ctx.errors[`${base}${suffix}`];
    if (exact !== undefined) return exact;
    const nested = Object.keys(ctx.errors).find((errorKey) => errorKey.startsWith(`${base}${suffix}.`));
    return nested === undefined ? undefined : ctx.errors[nested];
  };
  const rowError = ctx.errors[base];
  const fieldError = errorStartingWith('.field');
  const operatorError = errorStartingWith('.operator');
  const incomplete = ctx.showIncomplete && !isConditionComplete(condition);
  const valueError = errorStartingWith('.value') ?? (incomplete ? 'Choose a value' : undefined);
  const rowErrorId = `${ctx.idBase}-${key}-error`;

  const changeField = (field: ConditionField) => {
    if (field !== condition.field) ctx.onEdit(path, newCondition(field));
  };

  return (
    <Box
      data-node={key}
      role="group"
      aria-label={`Condition ${number}`}
      aria-describedby={rowError === undefined ? undefined : rowErrorId}
      sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'flex-start', p: 2.5, border: 1, borderColor: 'divider', borderRadius: 1.5, bgcolor: 'background.paper' }}
    >
      <TextField
        select
        label="Field"
        size="small"
        value={condition.field}
        disabled={ctx.disabled}
        onChange={(event) => changeField(event.target.value as ConditionField)}
        error={fieldError !== undefined}
        helperText={fieldError}
        sx={{ flex: '1 1 150px', minWidth: 140 }}
      >
        {availableFields(ctx.lookups, condition.field).map((field) => (
          <MenuItem key={field} value={field}>
            {FIELD_LABELS[field]}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        select
        label="Operator"
        size="small"
        value={condition.operator}
        disabled={ctx.disabled}
        onChange={(event) => ctx.onEdit(path, withOperator(condition, event.target.value as ConditionOperator))}
        error={operatorError !== undefined}
        helperText={operatorError}
        sx={{ flex: '1 1 140px', minWidth: 130 }}
      >
        {operatorsFor(condition.field, condition.operator).map((operator) => (
          <MenuItem key={operator} value={operator}>
            {OPERATOR_LABELS[operator]}
          </MenuItem>
        ))}
      </TextField>
      <Box sx={{ flex: '2 1 240px', minWidth: 200 }}>
        <ConditionValueInput
          key={condition.field}
          condition={condition}
          lookups={ctx.lookups}
          disabled={ctx.disabled}
          error={valueError}
          onChange={(value) => ctx.onEdit(path, { ...condition, value })}
        />
      </Box>
      <IconButton
        aria-label={`Remove condition ${number}: ${describeCondition(condition)}`}
        size="small"
        disabled={ctx.disabled || onlyItem}
        onClick={() => ctx.onRemove(path)}
        sx={{ mt: 0.5 }}
      >
        <CloseIcon fontSize="small" />
      </IconButton>
      {rowError !== undefined && (
        <Typography id={rowErrorId} variant="caption" color="error" sx={{ flexBasis: '100%' }}>
          {rowError}
        </Typography>
      )}
    </Box>
  );
}
