import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { ComponentProps } from 'react';
import type { MDXComponents } from 'mdx/types';
import { ComplexityDiagram } from './illustrations/ComplexityDiagram';
import { RoutingDiagram } from './illustrations/RoutingDiagram';

/**
 * Markdown task lists (`- [ ] step`) render disabled checkboxes with no label. They are decorative
 * in a checklist the reader can't tick, so hide them from assistive tech; the item text is read.
 */
function MdxInput(props: ComponentProps<'input'>) {
  if (props.type === 'checkbox') return <input {...props} aria-hidden="true" tabIndex={-1} />;
  return <input {...props} />;
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    input: MdxInput,
    RoutingDiagram,
    ComplexityDiagram,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
