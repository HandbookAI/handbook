import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  /**
   * Hosts allowed to load `/_next/*` dev assets.
   *
   * `next dev` binds every local address but treats only `localhost` as its own
   * origin, and blocks dev-resource requests from anything else. So opening the
   * server at `http://127.0.0.1:3000` — or at the LAN address Next itself prints
   * as "Network:" — served the SSR HTML and then blocked every JavaScript chunk.
   * The page looked complete and was inert: search, the theme toggle, the
   * language menu and the sidebar collapse are all client components, so none of
   * them hydrated and none of them responded to a click.
   *
   * These are the addresses that already reach a dev server on this machine, so
   * allowing them adds no reach; it just stops the same origin being refused
   * under a different spelling. It has no effect on `next build`/`next start`.
   */
  allowedDevOrigins: ['127.0.0.1', '[::1]', '192.168.*.*', '10.*.*.*', '172.16.*.*'],
};

export default withMDX(config);
