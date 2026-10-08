import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormHelperText from '@mui/material/FormHelperText';
import FormLabel from '@mui/material/FormLabel';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Typography from '@mui/material/Typography';
import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';

import { PolicyStatusChip } from '../../../components/data-display/PolicyStatusChip';
import { EmptyState } from '../../../components/foundations/EmptyState';
import { AttachIcon, CloseIcon } from '../../../components/foundations/icons';
import { useAnnounce } from '../../../components/foundations/LiveRegion';
import { Skeleton } from '../../../components/foundations/Skeleton';
import { Form, FormField, SubmitButton } from '../../../components/shell/Form';
import { Modal } from '../../../components/shell/Modal';
import { useToast } from '../../../components/shell/Toast';
import {
  mapPolicyError,
  policyErrorMessage,
  useCreatePolicyDocument,
  useCreatePolicyVersion,
  usePolicyDocument,
  usePolicyFileUpload,
  useRenamePolicyDocument,
  type PolicyDocument,
  type PolicyDocumentDetail,
  type PolicyFormError,
} from '../../../data/ai/policies';

/**
 * Create and edit a policy document (specs/002-ai-assist US2), in a dialog over the list:
 *
 * - a title and the content, typed or uploaded (txt, md or pdf, up to 10 MB);
 * - editing the content adds a new version (the old one keeps answering until the new one is
 *   ready); changing only the title renames the document;
 * - the version history with each version's status and, for a failed one, why it failed.
 *
 * `RenamePolicyDialog` is the title-only dialog opened from the list.
 */

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const FILE_EXTENSIONS = ['.txt', '.md', '.pdf'];
const TITLE_MAX = 200;
const TEXT_MAX = 200_000;

type ContentMode = 'text' | 'file';

const formatTime = (iso: string) => new Date(iso).toLocaleString();

function validateFile(file: File): string | undefined {
  const name = file.name.toLowerCase();
  if (!FILE_EXTENSIONS.some((extension) => name.endsWith(extension))) return 'Choose a .txt, .md or .pdf file.';
  if (file.size > MAX_FILE_BYTES) return 'This file is larger than 10 MB. Choose a smaller file.';
  if (file.size === 0) return 'This file is empty. Choose a file with content.';
  return undefined;
}

export interface PolicyEditorProps {
  /** Absent to create a new policy. */
  documentId?: string;
  onClose: () => void;
}

export function PolicyEditor({ documentId, onClose }: PolicyEditorProps) {
  const detail = usePolicyDocument(documentId, documentId !== undefined);
  const [busy, setBusy] = useState(false);
  const title = documentId === undefined ? 'Add a policy' : 'Edit policy';

  return (
    <Modal open onClose={onClose} title={title} maxWidth="md" busy={busy}>
      {documentId === undefined && <PolicyForm onDone={onClose} onBusyChange={setBusy} />}
      {documentId !== undefined && detail.isPending && <Skeleton variant="block" label="policy" />}
      {documentId !== undefined && detail.isError && (
        <EmptyState variant="error" title="Couldn't load this policy" message={detail.error?.message} onRetry={() => void detail.refetch()} headingLevel={3} />
      )}
      {documentId !== undefined && detail.isSuccess && <PolicyForm detail={detail.data} onDone={onClose} onBusyChange={setBusy} />}
    </Modal>
  );
}

interface PolicyFormProps {
  detail?: PolicyDocumentDetail;
  onDone: () => void;
  onBusyChange: (busy: boolean) => void;
}

function PolicyForm({ detail, onDone, onBusyChange }: PolicyFormProps) {
  const editing = detail !== undefined;
  const createDocument = useCreatePolicyDocument();
  const renameDocument = useRenamePolicyDocument();
  const createVersion = useCreatePolicyVersion();
  const upload = usePolicyFileUpload();
  const announce = useAnnounce();
  const toast = useToast();

  const [title, setTitle] = useState(detail?.title ?? '');
  const [mode, setMode] = useState<ContentMode>(detail?.source === 'file' ? 'file' : 'text');
  const [text, setText] = useState(detail?.text ?? '');
  const [fileProblem, setFileProblem] = useState<string | undefined>();
  const [errors, setErrors] = useState<PolicyFormError | undefined>();

  const titleRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [focusTarget, setFocusTarget] = useState<'title' | 'text' | 'file' | undefined>();

  const modeLabelId = useId();
  const fileHelpId = useId();
  const fileErrorId = useId();

  // The newest picked file is the one that counts; an older pick is dropped when a new one starts.
  const current = upload.attachments[upload.attachments.length - 1];
  const readyFile = upload.ready[0];

  // Announce when the picked file finishes uploading or fails (once per change).
  const announcedStatus = useRef<string>('');
  useEffect(() => {
    const key = current === undefined ? '' : `${current.localId}:${current.status}`;
    if (key === announcedStatus.current) return;
    announcedStatus.current = key;
    if (current?.status === 'ready') announce(`${current.fileName} uploaded`, 'polite');
    if (current?.status === 'failed') announce(`Upload failed: ${current.error ?? 'try another file'}`, 'assertive');
  }, [current, announce]);

  // Move focus to the first field with a problem once the form is enabled again.
  useEffect(() => {
    if (focusTarget === undefined) return undefined;
    const timer = setTimeout(() => {
      if (focusTarget === 'title') titleRef.current?.focus();
      else if (focusTarget === 'text') textRef.current?.focus();
      else chooseRef.current?.focus();
      setFocusTarget(undefined);
    }, 0);
    return () => clearTimeout(timer);
  }, [focusTarget]);

  const trimmedTitle = title.trim();
  const titleChanged = editing && trimmedTitle !== detail.title;
  const hasContent = mode === 'text' ? text.trim() !== '' : readyFile !== undefined;
  const contentChanged = hasContent && (mode === 'file' || !editing || detail.source !== 'text' || text !== (detail.text ?? ''));
  const uploading = mode === 'file' && current?.status === 'uploading';
  const canSave = trimmedTitle !== '' && !uploading && (editing ? titleChanged || contentChanged : hasContent);

  const pickFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    setErrors((previous) => (previous === undefined ? previous : { ...previous, attachmentId: undefined }));
    const problem = validateFile(file);
    setFileProblem(problem);
    if (problem !== undefined) return;
    upload.attachments.forEach((attachment) => upload.remove(attachment.localId));
    upload.add([file]);
  };

  const content = () => (mode === 'text' ? { text } : { attachmentId: (readyFile as { id: string }).id });

  const submit = async () => {
    setErrors(undefined);
    onBusyChange(true);
    try {
      if (!editing) {
        await createDocument.mutateAsync({ title: trimmedTitle, ...content() });
      } else {
        if (titleChanged) await renameDocument.mutateAsync(detail.id, trimmedTitle);
        if (contentChanged) await createVersion.mutateAsync(detail.id, content());
      }
      const message = !editing
        ? 'Policy added. It is processing and will be ready shortly.'
        : contentChanged
          ? 'Policy updated. The new version is processing.'
          : 'Policy renamed';
      toast({ message, severity: 'success' });
      onDone();
    } catch (caught) {
      const mapped = mapPolicyError(caught);
      setErrors(mapped);
      if (mapped.attachmentId !== undefined) {
        // The uploaded file can't be used; clear it so another one can be chosen.
        upload.attachments.forEach((attachment) => upload.remove(attachment.localId));
        setFocusTarget('file');
      } else if (mapped.text !== undefined) {
        setFocusTarget(mode === 'text' ? 'text' : 'file');
      } else if (mapped.title !== undefined) {
        setFocusTarget('title');
      }
      announce(mapped.title ?? mapped.attachmentId ?? mapped.text ?? mapped.message ?? 'Could not save the policy', 'assertive');
    } finally {
      onBusyChange(false);
    }
  };

  const fileMessage = fileProblem ?? errors?.attachmentId ?? (mode === 'file' ? errors?.text : undefined);

  return (
    <Form label={editing ? 'Edit policy' : 'Add a policy'} onSubmit={submit}>
      <FormField
        name="title"
        label="Title"
        required
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        error={errors?.title !== undefined}
        helperText={errors?.title ?? 'Shown to your team, for example "Return policy".'}
        inputRef={titleRef}
        autoComplete="off"
        slotProps={{ htmlInput: { maxLength: TITLE_MAX } }}
      />

      <FormControl>
        <FormLabel id={modeLabelId} sx={{ fontWeight: 600, color: 'text.primary', mb: 1 }}>
          {editing ? 'New content' : 'Content'}
        </FormLabel>
        <RadioGroup row aria-labelledby={modeLabelId} name="contentMode" value={mode} onChange={(event) => setMode(event.target.value as ContentMode)}>
          <FormControlLabel value="text" control={<Radio />} label="Type text" />
          <FormControlLabel value="file" control={<Radio />} label="Upload file" />
        </RadioGroup>
      </FormControl>

      {mode === 'text' ? (
        <FormField
          name="text"
          label="Policy text"
          multiline
          minRows={10}
          maxRows={20}
          required={!editing}
          value={text}
          onChange={(event) => setText(event.target.value)}
          error={errors?.text !== undefined}
          inputRef={textRef}
          helperText={
            errors?.text ??
            (editing ? 'Saving changed text adds a new version. The current one keeps answering until the new one is ready.' : 'Plain text or Markdown, up to 200,000 characters.')
          }
          slotProps={{ htmlInput: { maxLength: TEXT_MAX } }}
        />
      ) : (
        <Box>
          <input ref={fileInputRef} type="file" hidden accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf" onChange={pickFile} tabIndex={-1} aria-hidden="true" />
          {editing && detail.source === 'file' && detail.fileName != null && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Current file: {detail.fileName}. Choose a file to replace it.
            </Typography>
          )}
          <Button
            ref={chooseRef}
            variant="outlined"
            startIcon={<AttachIcon />}
            onClick={() => fileInputRef.current?.click()}
            aria-describedby={fileMessage === undefined ? fileHelpId : `${fileHelpId} ${fileErrorId}`}
          >
            {current === undefined ? 'Choose file' : 'Choose a different file'}
          </Button>
          <FormHelperText id={fileHelpId}>Text, Markdown or PDF, up to 10 MB.</FormHelperText>
          {fileMessage !== undefined && (
            <FormHelperText id={fileErrorId} error>
              {fileMessage}
            </FormHelperText>
          )}
          {current !== undefined && (
            <Box component="ul" sx={{ listStyle: 'none', m: 0, mt: 3, p: 0 }}>
              <Box component="li" sx={{ display: 'flex', alignItems: 'center', gap: 2, p: 2, border: 1, borderColor: 'divider', borderRadius: 2 }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography noWrap sx={{ fontWeight: 500 }}>
                    {current.fileName}
                  </Typography>
                  {current.status === 'uploading' && <LinearProgress variant="determinate" value={current.progress} aria-label={`Uploading ${current.fileName}`} sx={{ mt: 1 }} />}
                  {current.status === 'ready' && (
                    <Typography variant="body2" color="text.secondary">
                      Uploaded
                    </Typography>
                  )}
                  {current.status === 'failed' && (
                    <Typography variant="body2" color="error">
                      {current.error ?? 'Upload failed'}
                    </Typography>
                  )}
                </Box>
                <IconButton aria-label={`Remove ${current.fileName}`} onClick={() => upload.remove(current.localId)}>
                  <CloseIcon />
                </IconButton>
              </Box>
            </Box>
          )}
        </Box>
      )}

      {errors?.message !== undefined && <Alert severity="error">{errors.message}</Alert>}

      {editing && <VersionHistory detail={detail} />}

      <Box sx={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
        <SubmitButton disabled={!canSave}>{editing ? 'Save changes' : 'Add policy'}</SubmitButton>
      </Box>
    </Form>
  );
}

function VersionHistory({ detail }: { detail: PolicyDocumentDetail }) {
  const headingId = useId();
  const versions = detail.versions ?? [];
  if (versions.length === 0) return null;
  return (
    <Box component="section" aria-labelledby={headingId}>
      <Typography id={headingId} component="h3" variant="body1" sx={{ fontWeight: 600, mb: 2 }}>
        Versions
      </Typography>
      <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {versions.map((version) => (
          <Box component="li" key={version.id} sx={{ display: 'flex', alignItems: 'baseline', gap: 3, flexWrap: 'wrap' }}>
            <PolicyStatusChip status={version.status} />
            <Typography variant="body2">
              {version.source === 'file' ? 'File' : 'Typed text'} · {formatTime(version.createdAt)}
              {version.createdBy?.name !== undefined && ` · ${version.createdBy.name}`}
            </Typography>
            {version.status === 'failed' && version.error != null && (
              <Typography variant="body2" color="error" sx={{ flexBasis: '100%' }}>
                Why it failed: {policyErrorMessage(version.error)}
              </Typography>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

export interface RenamePolicyDialogProps {
  document: PolicyDocument;
  onClose: () => void;
}

export function RenamePolicyDialog({ document, onClose }: RenamePolicyDialogProps) {
  const rename = useRenamePolicyDocument();
  const announce = useAnnounce();
  const toast = useToast();
  const [title, setTitle] = useState(document.title);
  const [errors, setErrors] = useState<PolicyFormError | undefined>();
  const [busy, setBusy] = useState(false);
  const trimmed = title.trim();

  return (
    <Modal open onClose={onClose} title="Rename policy" busy={busy}>
      <Form
        label="Rename policy"
        onSubmit={async () => {
          setErrors(undefined);
          setBusy(true);
          try {
            await rename.mutateAsync(document.id, trimmed);
            toast({ message: 'Policy renamed', severity: 'success' });
            onClose();
          } catch (caught) {
            const mapped = mapPolicyError(caught);
            setErrors(mapped);
            announce(mapped.title ?? mapped.message ?? 'Could not rename the policy', 'assertive');
          } finally {
            setBusy(false);
          }
        }}
      >
        <FormField
          name="title"
          label="Title"
          required
          autoFocus
          autoComplete="off"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          error={errors?.title !== undefined}
          helperText={errors?.title}
          slotProps={{ htmlInput: { maxLength: TITLE_MAX } }}
        />
        {errors?.message !== undefined && <Alert severity="error">{errors.message}</Alert>}
        <Box sx={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <SubmitButton disabled={trimmed === '' || trimmed === document.title}>Save name</SubmitButton>
        </Box>
      </Form>
    </Modal>
  );
}
