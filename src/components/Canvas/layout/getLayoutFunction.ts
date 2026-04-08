import type { LayoutFunction } from '@reactodia/workspace';
import type { AppConfig } from '@/stores/appConfigStore';
import { createDagreLayout, createElkLayout } from './layouts';

export function getLayoutFunction(
  layoutType: string,
  config: AppConfig,
  defaultLayout: LayoutFunction
): LayoutFunction {
  const spacing = config.layoutSpacing ?? 120;
  switch (layoutType) {
    case 'horizontal':
      return createDagreLayout('LR', spacing);
    case 'vertical':
      return createDagreLayout('TB', spacing);
    case 'elk-layered':
      return createElkLayout('layered', spacing);
    case 'elk-force':
      return createElkLayout('force', spacing);
    case 'elk-stress':
      return createElkLayout('stress', spacing);
    case 'reactodia-default':
    default: {
      // The worker proxy forwards all arguments; pass spacing as preferredLinkLength
      // and scale padding proportionally (default cola padding is {x:50, y:50} at spacing 120)
      const pad = Math.round((spacing / 120) * 50);
      return (graph, state) =>
        (defaultLayout as (g: typeof graph, s: typeof state, o: object) => Promise<typeof state>)(
          graph, state, { preferredLinkLength: spacing, padding: { x: pad, y: pad } }
        );
    }
  }
}
