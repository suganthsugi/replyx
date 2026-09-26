import SvgIcon, { type SvgIconProps } from '@mui/material/SvgIcon';

/**
 * The app's icons, drawn on MUI `SvgIcon` (24 × 24 grid). Icons are decorative: the control that
 * holds one supplies the accessible name.
 */

export function CloseIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} aria-hidden="true">
      <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
    </SvgIcon>
  );
}

export function WarningIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} aria-hidden="true">
      <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
    </SvgIcon>
  );
}

export function AttachIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} aria-hidden="true">
      <path d="M16.5 6v11.5a4 4 0 0 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 0 1-2 0V6H10v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 0 0-8 0v12.5a5.5 5.5 0 0 0 11 0V6h-1.5z" />
    </SvgIcon>
  );
}

export function MoreIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} aria-hidden="true">
      <path d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
    </SvgIcon>
  );
}

export function ChatIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} aria-hidden="true">
      <path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm0 14H5.17L4 17.17V4h16v12z" />
    </SvgIcon>
  );
}
