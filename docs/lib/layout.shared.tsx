import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, repoUrl } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden
            style={{ display: 'inline-block', verticalAlign: '-4px', marginRight: 6 }}
          >
            <rect x="2" y="3" width="9" height="18" rx="2" fill="#2dd4bf" />
            <rect x="13" y="3" width="9" height="18" rx="2" fill="#a78bfa" />
            <path d="M12 5.5v13" stroke="#0b1020" strokeWidth="1.5" />
          </svg>
          <span style={{ fontWeight: 700 }}>{appName}</span>
        </>
      ),
    },
    githubUrl: repoUrl,
    links: [
      { text: 'Docs', url: '/docs', active: 'nested-url' },
      { text: 'Quick start', url: '/docs/getting-started/quickstart' },
      { text: 'CLI reference', url: '/docs/reference/cli' },
      { text: 'Configuration', url: '/docs/reference/configuration' },
    ],
  };
}
