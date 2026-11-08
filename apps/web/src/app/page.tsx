import { redirect } from 'next/navigation';
import { homeFor, pageSession } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const s = await pageSession();
  redirect(s ? homeFor(s.user.role) : '/sign-in');
}
