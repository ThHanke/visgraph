import React from 'react';

/**
 * PrefixContext provides a mapping of prefix -> namespace URI to child components.
 * Components can consume this via React.useContext(PrefixContext) to shorten IRIs.
 */
export const PrefixContext = React.createContext<Record<string, string>>({});
