import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface ConfirmOptions {
  /** Short heading — the action + entity (e.g. `Delete this agent?`). Never truncated. */
  title: string;
  /** Consequence line, e.g. "This can't be undone." Optional. */
  description?: ReactNode;
  /** Label for the primary action. Callers should pass the actual verb
   *  ("Delete", "Archive", "Revoke", ...) — never "OK" or "Confirm". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Danger-styled primary button for destructive/irreversible actions. */
  destructive?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

/**
 * Design-system replacement for `window.confirm()` (issue #184). Mount once
 * near the app root (see main.tsx) so every `useConfirm()` caller shares one
 * dialog instance — matches `window.confirm`'s one-at-a-time semantics, and
 * guarantees the dialog always renders outside any clickable row (it lives
 * at the app root, not wherever the triggering button sits), so opening it
 * never fires a row's own onClick navigation.
 *
 * Built on the same shadcn Dialog primitives as `components/Modal.tsx` —
 * focus trap, Escape-to-close, and theming come for free from Radix. Unlike
 * Modal's title (which truncates to one line), the title here wraps freely
 * since confirm copy is often a full sentence. Cancel renders first in the
 * footer so it receives Radix's default open-focus — a safe default where
 * Enter cancels rather than triggering the destructive action.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      setPending({ ...options, resolve });
    });
  }, []);

  const settle = (value: boolean) => {
    pending?.resolve(value);
    setPending(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) settle(false);
        }}
      >
        {pending && (
          <DialogContent className="!max-w-md">
            <DialogHeader>
              <DialogTitle>{pending.title}</DialogTitle>
              {pending.description && (
                <DialogDescription>{pending.description}</DialogDescription>
              )}
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => settle(false)}>
                {pending.cancelLabel ?? "Cancel"}
              </Button>
              <Button
                variant={pending.destructive ? "destructive" : "default"}
                onClick={() => settle(true)}
              >
                {pending.confirmLabel ?? "Confirm"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

/**
 * `const confirm = useConfirm(); if (await confirm({ title: "Delete agent?",
 * description: "This can't be undone.", confirmLabel: "Delete", destructive:
 * true })) { ... }` — replaces `window.confirm()`. Themed, accessible, and
 * doesn't silently no-op in sandboxed/embedded contexts the way the native
 * dialog can.
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm must be used within a ConfirmProvider");
  }
  return ctx;
}
