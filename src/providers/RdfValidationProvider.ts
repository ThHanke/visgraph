import type {
  ValidationProvider,
  ValidationEvent,
  ValidationResult,
  ValidatedElement,
  ElementIri,
} from '@reactodia/workspace';

const ERROR_PRED = 'urn:vg:reasoningError';
const WARNING_PRED = 'urn:vg:reasoningWarning';

export class RdfValidationProvider implements ValidationProvider {
  async validate(e: ValidationEvent): Promise<ValidationResult> {
    const items: ValidatedElement[] = [];
    const errors = e.target.properties?.[ERROR_PRED] ?? [];
    const warnings = e.target.properties?.[WARNING_PRED] ?? [];

    if (errors.length > 0) {
      items.push({
        type: 'element',
        target: e.target.id as ElementIri,
        severity: 'error',
        message: (errors[0] as any)?.value ?? 'Reasoning error',
      });
    } else if (warnings.length > 0) {
      items.push({
        type: 'element',
        target: e.target.id as ElementIri,
        severity: 'warning',
        message: (warnings[0] as any)?.value ?? 'Reasoning warning',
      });
    }
    return { items };
  }
}
