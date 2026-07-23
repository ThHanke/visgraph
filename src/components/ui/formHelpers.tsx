/**
 * Minimal stubs for form context helpers.
 * This file exists to satisfy the import in form.tsx.
 * Install react-hook-form and replace with real implementation if forms are needed.
 */
import * as React from "react"

type FormFieldContextValue = {
  name: string
}

type FormItemContextValue = {
  id: string
}

export const FormFieldContext = React.createContext<FormFieldContextValue>(
  {} as FormFieldContextValue
)

export const FormItemContext = React.createContext<FormItemContextValue>(
  {} as FormItemContextValue
)

export function useFormField() {
  const fieldContext = React.useContext(FormFieldContext)
  const itemContext = React.useContext(FormItemContext)
  const id = itemContext.id

  return {
    id,
    name: fieldContext.name,
    formItemId: `${id}-form-item`,
    formDescriptionId: `${id}-form-item-description`,
    formMessageId: `${id}-form-item-message`,
    error: undefined as any,
  }
}

// Stub Form — wraps children; real impl would use react-hook-form's FormProvider
export function Form({ children, ...props }: React.PropsWithChildren<Record<string, any>>) {
  return <form {...props}>{children}</form>
}

// Stub FormField — renders nothing meaningful without react-hook-form
export function FormField({ name, render }: { name: string; render: (arg: any) => React.ReactNode }) {
  return (
    <FormFieldContext.Provider value={{ name }}>
      {render({ field: {}, fieldState: {}, formState: {} })}
    </FormFieldContext.Provider>
  )
}
