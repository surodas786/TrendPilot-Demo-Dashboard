import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useDemo } from '../contexts/DemoContext';
import { simNow } from '../utils/clock';
import { makeLinkId } from '../utils/userDirectory';
import type { DemoUser } from '../types/signals';
import type { UserMenuAction } from '../components/users/UserActionsMenu';

type Confirm = {kind: 'reset' | 'suspend';user: DemoUser;} | null;

/** Admin user-management actions and the modal state they drive. */
export function useUserActions() {
  const { state, createUser, editUser, issueUserLink, setUserAccess, setRole, setTraderUser } = useDemo();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [previewLinkId, setPreviewLinkId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const issue = (userId: string, kind: 'invite' | 'reset') => {
    const at = simNow();
    const link = { id: makeLinkId(kind, at), userId, kind, createdAt: at, state: 'active' as const };
    issueUserLink(link);
    setPreviewLinkId(link.id);
  };

  const preview = (user: DemoUser) => {
    setTraderUser(user.id);
    setRole('trader');
    navigate('/');
    toast(`Previewing ${user.name}`, { description: 'Subscriber mode · only this subscriber’s records are shown.' });
  };

  const create = (name: string, email: string) => {
    const at = simNow();
    const id = `user-${at.toString(36)}`;
    const user: DemoUser = { id, name, email, status: 'invited', invitation: 'pending', createdAt: at, entriesPaused: false, workspacePaused: false };
    const link = { id: makeLinkId('invite', at), userId: id, kind: 'invite' as const, createdAt: at, state: 'active' as const };
    createUser(user, link);
    setCreating(false);
    setPreviewLinkId(link.id);
    toast.success('User created. Invitation email simulated.');
  };

  const saveEdit = (name: string, email: string) => {
    if (!editingId) return;
    editUser(editingId, name, email);
    setEditingId(null);
    toast.success('Subscriber details saved');
  };

  const onAction = (user: DemoUser, action: UserMenuAction) => {
    if (action === 'edit') setEditingId(user.id);
    if (action === 'resend') {
      issue(user.id, 'invite');
      toast.success('Invitation resent. Invitation email simulated.', { description: 'The previous invitation link no longer works.' });
    }
    if (action === 'reset' || action === 'suspend') setConfirm({ kind: action, user });
    if (action === 'reactivate') {
      setUserAccess(user.id, 'active');
      toast.success(`${user.name} reactivated`);
    }
    if (action === 'preview') preview(user);
  };

  const confirmAction = () => {
    if (!confirm) return;
    if (confirm.kind === 'reset') {
      issue(confirm.user.id, 'reset');
      toast.success('Password-reset email simulated.');
    } else {
      setUserAccess(confirm.user.id, 'suspended');
      toast.success(`${confirm.user.name} suspended`, { description: 'Simulated account access blocked.' });
    }
    setConfirm(null);
  };

  return {
    creating,
    setCreating,
    editingUser: state.users.find((u) => u.id === editingId),
    closeEdit: () => setEditingId(null),
    previewLinkId,
    closePreview: () => setPreviewLinkId(null),
    confirm,
    cancelConfirm: () => setConfirm(null),
    confirmAction,
    create,
    saveEdit,
    onAction
  };
}