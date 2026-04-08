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
    default:
      return defaultLayout;
  }
}
