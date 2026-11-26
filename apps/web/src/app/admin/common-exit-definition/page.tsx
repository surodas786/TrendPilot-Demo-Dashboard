import { CommonExitAdmin } from '@/components/admin/CommonExitAdmin';
import { PageContainer } from '@/components/layout/PageContainer';
import { commonExitView } from '@/server/commonExit';
import { requirePageRole } from '@/server/pageSession';

export const dynamic = 'force-dynamic';

export default async function CommonExitDefinitionPage() {
  await requirePageRole('ADMIN');
  const view = await commonExitView();
  return (
    <PageContainer
      title="Common Exit Definition"
      description="Central Take Profit and Trailing Take Profit settings for every investor order block that has Sync Admin Setting checked. The same fields and rules as an investor's Exit Plan."
      scope="Publishing applies to new entries of linked order blocks at once. Open positions keep their exit plan unless you explicitly apply the change to them."
    >
      <CommonExitAdmin initial={view} />
    </PageContainer>
  );
}
