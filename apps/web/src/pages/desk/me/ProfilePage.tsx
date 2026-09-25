import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import { EmptyState } from '../../../components/foundations/EmptyState';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { Form, FormError, FormField, SubmitButton } from '../../../components/shell/Form';
import { useToast } from '../../../components/shell/Toast';
import { useChangePassword, useMe, useSignOut, useSignOutAll, useUpdateMe } from '../../../data/auth';

import type { Availability } from '../../../api/generated/model';

const AVAILABILITY_OPTIONS: { value: Availability; label: string }[] = [
  { value: 'online', label: 'Online' },
  { value: 'away', label: 'Away' },
  { value: 'offline', label: 'Offline' },
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

/** The signed-in staff member's own profile: name, availability, password, and sessions. */
export default function ProfilePage() {
  const meQuery = useMe();
  const updateMe = useUpdateMe();
  const changePassword = useChangePassword();
  const signOut = useSignOut();
  const signOutAll = useSignOutAll();
  const toast = useToast();
  const navigate = useNavigate();

  const [initialized, setInitialized] = useState(false);
  const [name, setName] = useState('');
  const [availability, setAvailability] = useState<Availability>('online');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  useEffect(() => {
    if (meQuery.data !== undefined && !initialized) {
      setName(meQuery.data.name);
      setAvailability(meQuery.data.availability ?? 'online');
      setInitialized(true);
    }
  }, [meQuery.data, initialized]);

  if (meQuery.isPending) {
    return (
      <Box component="main" sx={{ px: 6, py: 6, maxWidth: 640 }}>
        <Skeleton variant="block" label="your profile" />
      </Box>
    );
  }

  if (meQuery.isError) {
    return (
      <Box component="main" sx={{ px: 6, py: 6, maxWidth: 640 }}>
        <EmptyState
          variant="error"
          title="Couldn't load your profile"
          message={meQuery.error?.message}
          onRetry={() => void meQuery.refetch()}
        />
      </Box>
    );
  }

  const me = meQuery.data;

  const handleSignOut = async () => {
    await signOut.mutateAsync();
    void navigate('/desk/sign-in', { replace: true });
  };

  const handleSignOutAll = async () => {
    await signOutAll.mutateAsync();
    void navigate('/desk/sign-in', { replace: true });
  };

  return (
    <Box component="main" sx={{ px: 6, py: 6, maxWidth: 640 }}>
      <Typography component="h1" variant="h4" sx={{ mb: 6 }}>
        Your profile
      </Typography>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 4, mb: 8 }}>
        <Avatar src={me.avatarUrl ?? undefined} sx={{ width: 64, height: 64 }}>
          {initials(me.name)}
        </Avatar>
        <Typography variant="body2" color="text.secondary">
          {me.email}
        </Typography>
      </Box>

      <Typography component="h2" variant="h6" sx={{ mb: 3 }}>
        Name and availability
      </Typography>
      <Form
        label="Update your profile"
        onSubmit={async () => {
          await updateMe.mutateAsync({ name, availability });
          toast({ message: 'Profile updated', severity: 'success' });
        }}
      >
        <FormField name="name" label="Name" value={name} onChange={(event) => setName(event.target.value)} required />
        <FormField
          name="availability"
          label="Availability"
          select
          value={availability}
          onChange={(event) => setAvailability(event.target.value as Availability)}
        >
          {AVAILABILITY_OPTIONS.map((option) => (
            <MenuItem key={option.value} value={option.value}>
              {option.label}
            </MenuItem>
          ))}
        </FormField>
        <FormError />
        <SubmitButton>Save changes</SubmitButton>
      </Form>

      <Typography component="h2" variant="h6" sx={{ mt: 8, mb: 3 }}>
        Change password
      </Typography>
      <Form
        label="Change your password"
        onSubmit={async () => {
          await changePassword.mutateAsync({ currentPassword, newPassword });
          setCurrentPassword('');
          setNewPassword('');
          toast({ message: 'Password changed', severity: 'success' });
        }}
      >
        <FormField
          name="currentPassword"
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          required
        />
        <FormField
          name="newPassword"
          label="New password"
          type="password"
          autoComplete="new-password"
          helperText="At least 12 characters"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          required
        />
        <FormError />
        <SubmitButton>Change password</SubmitButton>
      </Form>

      <Typography component="h2" variant="h6" sx={{ mt: 8, mb: 3 }}>
        Sessions
      </Typography>
      <Box sx={{ display: 'flex', gap: 3 }}>
        <Button variant="outlined" onClick={() => void handleSignOut()}>
          Sign out
        </Button>
        <Button variant="outlined" color="error" onClick={() => void handleSignOutAll()}>
          Sign out of all sessions
        </Button>
      </Box>
    </Box>
  );
}
