/* eslint-disable react-refresh/only-export-components */
/* Helper-only module: exports contexts/hooks/constants (no React component default export) */
import * as React from "react"
import {
  Controller,
  ControllerProps,
  FieldPath,
  FieldValues,
  FormProvider,
  useFormContext,
} from "react-hook-form"

/**
 * Helper module for form contexts and hooks.
 * Split out from `form.tsx` so the main component file only exports React components,
 * avoiding react-refresh warnings about non-component exports.
 */

/* Re-export FormProvider as Form for convenience */
export const Form = FormProvider

export type FormFieldContextValue<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>
> = {
  name: TName
}

/* Context shared between FormField and consumers (label/control/message) */
export const FormFieldContext = React.createContext<FormFieldContextValue>(
  {} as FormFieldContextValue
)

/* A simple FormField wrapper that provides the field name to consumers and renders Controller */
export const FormField = <
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>
>({
  ...props
}: ControllerProps<TFieldValues, TName>) => {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  )
}

/* Context used by FormItem to provide IDs to consumers */
export type FormItemContextValue = {
  id: string
}

export const FormItemContext = React.createContext<FormItemContextValue>(
  {} as FormItemContextValue
)

/* Hook consumed by label/control/description/message components to access field state and ids */
export const useFormField = () => {
  const fieldContext = React.useContext(FormFieldContext)
  const itemContext = React.useContext(FormItemContext)
  const { getFieldState, formState } = useFormContext()

  const fieldState = getFieldState(fieldContext.name, formState)

  if (!fieldContext) {
    throw new Error("useFormField should be used within <FormField>")
  }

  const { id } = itemContext

  return {
    id,
    name: fieldContext.name,
    formItemId: `${id}-form-item`,
    formDescriptionId: `${id}-form-item-description`,
    formMessageId: `${id}-form-item-message`,
    ...fieldState,
  }
}
