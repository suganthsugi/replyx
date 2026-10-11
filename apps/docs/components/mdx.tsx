import defaultMdxComponents from 'fumadocs-ui/mdx';

import { ComplexityDiagram } from './illustrations/ComplexityDiagram';
import { RoutingDiagram } from './illustrations/RoutingDiagram';

import type { MDXComponents } from 'mdx/types';
import type { ComponentProps } from 'react';

/**
 * Markdown task lists (`- [ ] step`) render disabled checkboxes with no label. They are decorative
 * in a checklist the reader can't tick, so hide them from assistive tech; the item text is read.
 */
function MdxInput(props: ComponentProps<'input'>) {
  if (props.type === 'checkbox') return <input {...props} aria-hidden="true" tabIndex={-1} />;
  return <input {...props} />;
}

/**
 * Fumadocs scrolls a wide table sideways inside a wrapper. Keyboard users can only scroll it if the
 * wrapper can take focus (axe scrollable-region-focusable), so make it a focusable, named region.
 */
function MdxTable(props: ComponentProps<'table'>) {
  return (
    <div className="relative overflow-auto prose-no-margin my-6" tabIndex={0} role="region" aria-label="Table">
      <table {...props} />
    </div>
  );
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    input: MdxInput,
    table: MdxTable,
    RoutingDiagram,
    ComplexityDiagram,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
