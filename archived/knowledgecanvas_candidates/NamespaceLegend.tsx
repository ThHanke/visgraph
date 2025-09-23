import React from "react";
import ResizableNamespaceLegend from "./ResizableNamespaceLegend";

/**
 * Thin wrapper that exposes the ResizableNamespaceLegend as the canonical NamespaceLegend.
 * Keeps the same default export and a named export for compatibility.
 */

export const NamespaceLegend = () => {
  return <ResizableNamespaceLegend />;
};

export default NamespaceLegend;
