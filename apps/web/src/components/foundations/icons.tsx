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
