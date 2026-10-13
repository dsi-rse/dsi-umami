import type { Metadata } from 'next';
import { DeploymentFeatureUnavailable } from '@/components/common/DeploymentFeatureUnavailable';
import { AdminTeamsPage } from './AdminTeamsPage';

const IS_D1 = process.env.DATABASE_FLAVOR === 'd1';

export default function () {
  if (IS_D1) {
    return (
      <DeploymentFeatureUnavailable
        title="Admin teams"
        reason="The admin team list relies on Prisma `include` shapes that haven't been ported to D1 yet. Upstream PG / Vercel deployments are unaffected."
      />
    );
  }
  return <AdminTeamsPage />;
}
export const metadata: Metadata = {
  title: 'Teams',
};
