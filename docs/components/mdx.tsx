import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { File, Files, Folder } from 'fumadocs-ui/components/files';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import type { MDXComponents } from 'mdx/types';

/**
 * Components every MDX page can use without importing anything.
 *
 * `defaultMdxComponents` already covers Callout, Cards/Card and the markdown
 * primitives; the rest are opt-in in fumadocs, and a page that uses one without
 * it being registered here fails the *build* rather than rendering wrong — which
 * is why they are all listed in one place instead of imported per page.
 */
export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Steps,
    Step,
    Tabs,
    Tab,
    Accordion,
    Accordions,
    Files,
    File,
    Folder,
    TypeTable,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
