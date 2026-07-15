import { createContext, useContext } from "react";
import type { NodeHandle } from "pixel-react";

export const ComposerContext = createContext<React.RefObject<NodeHandle | null> | null>(null);

export function useComposer(): React.RefObject<NodeHandle | null> {
  const ref = useContext(ComposerContext);
  if (!ref) throw new Error("useComposer called outside ComposerContext.Provider");
  return ref;
}
