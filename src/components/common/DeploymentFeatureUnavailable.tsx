'use client';
import { Column, Heading, Text } from '@umami/react-zen';
import { Panel } from './Panel';

/**
 * Empty-state notice shown on pages whose backing queries aren't supported on
 * the current deployment (e.g., D1 + Workers can't run some Prisma `include`
 * shapes yet). Server-renderable; takes only static props.
 */
export function DeploymentFeatureUnavailable({
  title,
  reason,
}: {
  title: string;
  reason?: string;
}) {
  return (
    <Column gap="6" margin="2">
      <Panel>
        <Column gap="3" paddingY="9" paddingX="6" alignItems="center" textAlign="center">
          <Heading size="3">{title}</Heading>
          <Text color="muted" maxWidth="500px">
            {reason ??
              'This feature is not available in this deployment. The underlying database queries have not yet been ported for Cloudflare D1.'}
          </Text>
        </Column>
      </Panel>
    </Column>
  );
}
