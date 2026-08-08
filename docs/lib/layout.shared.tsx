import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, repoUrl } from './shared';
import { i18n } from './i18n';
import { ui } from './ui-strings';

/**
 * `locale` is required, not optional: a nav bar that silently falls back to
 * English is the failure mode i18n exists to prevent, and making the caller
 * pass it means a new layout cannot forget.
 */
export function baseOptions(locale: string): BaseLayoutProps {
  const t = ui(locale);
  const prefix = locale === i18n.defaultLanguage ? '' : `/${locale}`;

  return {
    // `true`, not the config object: `defineI18n` attaches a `translations`
    // FUNCTION to it, and these options are handed to a Client Component, which
    // cannot receive a function across the boundary. `true` tells the layout to
    // render the language menu using the config the RootProvider already put in
    // context — where it lives on the server side of the line.
    i18n: true,
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
      url: prefix || '/',
    },
    githubUrl: repoUrl,
    links: [
      { text: t.navDocs, url: `${prefix}/docs`, active: 'nested-url' },
      { text: t.navQuickstart, url: `${prefix}/docs/getting-started/quickstart` },
      { text: t.navCli, url: `${prefix}/docs/reference/cli` },
      { text: t.navConfig, url: `${prefix}/docs/reference/configuration` },
    ],
  };
}
