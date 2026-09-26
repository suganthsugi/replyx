import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';

import { ConfirmationDialog } from '../../components/shell/ConfirmationDialog';
import { Drawer } from '../../components/shell/Drawer';
import { Form, FormError, FormField, SubmitButton } from '../../components/shell/Form';
import { useToast } from '../../components/shell/Toast';
import { uploadCustomerAttachmentWithProgress } from '../../data/attachments';
import { useCustomerSignOut, useCustomerSignOutAll, useUpdateCustomerMe } from '../../data/customer-auth';
import { mapError } from '../../data/errors';

import type { CustomerMe, UpdateCustomerMeBody } from '../../api/generated/model';

const AVATAR_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp';

/**
 * The customer's profile, opened from the chat header: name, photo, an optional password (the
 * sign-in link keeps working either way), whether replies are also emailed, and signing out
 * here or on every device.
 */
export function ProfileSheet({ open, onClose, me }: { open: boolean; onClose: () => void; me: CustomerMe }) {
  const updateMe = useUpdateCustomerMe();
  const signOut = useCustomerSignOut();
  const signOutAll = useCustomerSignOutAll();
  const toast = useToast();
  const photoInput = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(me.name);
  const [emailOnReply, setEmailOnReply] = useState(me.emailOnReply ?? true);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [confirmSignOutAll, setConfirmSignOutAll] = useState(false);

  // Opening the sheet starts from what's saved, not from an abandoned edit.
  useEffect(() => {
    if (!open) return;
    setName(me.name);
    setEmailOnReply(me.emailOnReply ?? true);
    setCurrentPassword('');
    setNewPassword('');
  }, [open, me]);

  const save = async () => {
    const body: UpdateCustomerMeBody = {};
    if (name.trim() !== me.name) body.name = name.trim();
    if (emailOnReply !== (me.emailOnReply ?? true)) body.emailOnReply = emailOnReply;
    if (newPassword !== '') {
      body.newPassword = newPassword;
      if (me.hasPassword) body.currentPassword = currentPassword;
    }
    if (Object.keys(body).length > 0) await updateMe.mutateAsync(body);
    setCurrentPassword('');
    setNewPassword('');
    toast({ message: 'Profile saved', severity: 'success' });
  };

  const onPhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    setUploadingPhoto(true);
    try {
      const attachment = await uploadCustomerAttachmentWithProgress(file, () => undefined);
      await updateMe.mutateAsync({ avatarAttachmentId: attachment.id });
      toast({ message: 'Photo updated', severity: 'success' });
    } catch (error) {
      toast({ message: mapError(error).message, severity: 'error' });
    } finally {
      setUploadingPhoto(false);
    }
  };

  return (
    <Drawer open={open} onClose={onClose} title="Your profile">
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Avatar src={me.avatarUrl ?? undefined} alt="" sx={{ width: 56, height: 56 }}>
            {me.name.charAt(0).toUpperCase()}
          </Avatar>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
              {me.email}
            </Typography>
            <input ref={photoInput} type="file" accept={AVATAR_ACCEPT} hidden tabIndex={-1} aria-hidden="true" onChange={(event) => void onPhoto(event)} />
            <Button size="small" onClick={() => photoInput.current?.click()} disabled={uploadingPhoto} aria-busy={uploadingPhoto} sx={{ mt: 1, ml: -2 }}>
              {uploadingPhoto ? 'Uploading photo…' : 'Change photo'}
            </Button>
          </Box>
        </Box>

        <Form label="Update your profile" onSubmit={save}>
          <FormField name="name" label="Name" value={name} onChange={(event) => setName(event.target.value)} required slotProps={{ htmlInput: { maxLength: 120 } }} />
          <FormControlLabel
            control={<Switch checked={emailOnReply} onChange={(event) => setEmailOnReply(event.target.checked)} />}
            label="Email me when support replies and I'm not here"
          />
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <Typography component="h3" variant="subtitle2">
              {me.hasPassword ? 'Change password' : 'Set a password (optional)'}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              You can always sign in with an emailed link instead.
            </Typography>
            {me.hasPassword && (
              <FormField
                name="currentPassword"
                label="Current password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            )}
            <FormField
              name="newPassword"
              label="New password"
              type="password"
              autoComplete="new-password"
              helperText="At least 12 characters"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </Box>
          <FormError />
          <SubmitButton>Save changes</SubmitButton>
        </Form>

        <Divider />

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
          <Button variant="outlined" onClick={() => void signOut.mutateAsync()} disabled={signOut.isPending}>
            Sign out
          </Button>
          <Button color="error" onClick={() => setConfirmSignOutAll(true)}>
            Sign out everywhere
          </Button>
        </Box>
      </Box>
      <ConfirmationDialog
        open={confirmSignOutAll}
        title="Sign out everywhere?"
        message="You'll be signed out on every device, including this one."
        confirmLabel="Sign out everywhere"
        destructive
        onConfirm={async () => {
          await signOutAll.mutateAsync();
        }}
        onClose={() => setConfirmSignOutAll(false)}
      />
    </Drawer>
  );
}
