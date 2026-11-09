import { redirect } from 'next/navigation';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

/** Admin → Settings has one section today: Mail Box. */
export default async function AdminSettingsPage() {
  await requirePageRole('ADMIN');
  redirect('/admin/settings/mail-box');
}
