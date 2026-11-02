import { useTheme } from '@umami/react-zen';

// DSI fork: wordmark shown in place of the umami logo (login page, nav).
export function DsiLogo({ height = 28 }: { height?: number }) {
  const { theme } = useTheme();

  return (
    <img
      src={theme === 'dark' ? '/images/dsi-logo-dark.svg' : '/images/dsi-logo.svg'}
      alt="UChicago Data Science Institute"
      style={{ height, width: 'auto', display: 'block' }}
    />
  );
}
