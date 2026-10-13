import type { Metadata } from 'next';
import { DeploymentFeatureUnavailable } from '@/components/common/DeploymentFeatureUnavailable';
import { AdminWebsitesPage } from './AdminWebsitesPage';

const IS_D1 = process.env.DATABASE_FLAVOR === 'd1';

export default function () {
  if (IS_D1) {
    return (
      <DeploymentFeatureUnavailable
        title="Admin websites"
        reason="The admin website list relies on Prisma `include` shapes that haven't been ported to D1 yet. Upstream PG / Vercel deployments are unaffected."
      />
    );
  }
  return <AdminWebsitesPage />;
}
export const metadata: Metadata = {
  title: 'Websites',
};
