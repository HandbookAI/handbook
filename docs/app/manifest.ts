import type { MetadataRoute } from 'next';
import { appName, brand, description, tagline } from '@/lib/shared';

export const revalidate = false;

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${appName} — ${tagline}`,
    short_name: appName,
    description,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: brand.background,
    theme_color: brand.background,
    categories: ['developer', 'productivity', 'utilities'],
    lang: 'en',
    dir: 'ltr',
    icons: [
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
      { src: '/og-square.png', sizes: '1200x1200', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
